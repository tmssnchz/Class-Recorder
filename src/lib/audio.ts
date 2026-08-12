/**
 * Envoltorio del sidecar ffmpeg.
 *
 * MediaRecorder en WebView2 solo produce WebM/Opus, así que ffmpeg se encarga
 * de pasar a MP3/WAV y, más adelante, de generar el WAV 16 kHz mono que
 * whisper.cpp necesita como entrada.
 */
import { exists, remove, writeTextFile } from "@tauri-apps/plugin-fs";
import { Command } from "@tauri-apps/plugin-shell";

import { unir } from "./paths";
import type { FormatoAudio } from "../types";

const SIDECAR = "binaries/ffmpeg";

interface OpcionesConversion {
  /** Duración conocida en segundos: sin ella no se puede calcular el porcentaje. */
  duracionSeg?: number;
  onProgreso?: (fraccion: number) => void;
}

function ejecutar(
  args: string[],
  opciones: OpcionesConversion = {},
): Promise<void> {
  const { duracionSeg, onProgreso } = opciones;

  return new Promise((resolver, rechazar) => {
    const cmd = Command.sidecar(SIDECAR, args);

    // ffmpeg escribe todo su log por stderr; guardamos solo la cola para el mensaje de error.
    let stderr = "";
    cmd.stderr.on("data", (linea) => {
      stderr = (stderr + linea).slice(-4000);
    });

    if (onProgreso && duracionSeg && duracionSeg > 0) {
      cmd.stdout.on("data", (linea) => {
        // Formato de "-progress pipe:1": pares clave=valor, uno por línea.
        const m = /out_time_us=(\d+)/.exec(linea);
        if (m) {
          const segundos = Number(m[1]) / 1_000_000;
          onProgreso(Math.min(1, segundos / duracionSeg));
        }
      });
    }

    cmd.on("close", ({ code }) => {
      if (code === 0) resolver();
      else
        rechazar(
          new Error(
            `ffmpeg terminó con código ${code}.\n${stderr.trim().split("\n").slice(-6).join("\n")}`,
          ),
        );
    });
    cmd.on("error", (e) => rechazar(new Error(`No se pudo ejecutar ffmpeg: ${e}`)));

    cmd.spawn().catch(rechazar);
  });
}

/**
 * Duración en segundos de un archivo de audio, leída del encabezado que
 * ffmpeg imprime por stderr. Devuelve 0 si no se pudo determinar.
 *
 * Hace falta al importar: una grabación nativa ya sabe cuánto duró porque la
 * cronometró, pero un archivo que viene del celular no trae ese dato.
 */
export function duracionDe(entrada: string): Promise<number> {
  return new Promise((resolver) => {
    const cmd = Command.sidecar(SIDECAR, ["-hide_banner", "-i", entrada]);
    let stderr = "";
    cmd.stderr.on("data", (linea) => {
      stderr += linea;
    });
    cmd.on("close", () => {
      // "Duration: 00:19:36.60, start: ..."
      const m = /Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d+)/.exec(stderr);
      if (!m) {
        resolver(0);
        return;
      }
      const [, h, min, s, frac] = m;
      resolver(
        Number(h) * 3600 + Number(min) * 60 + Number(s) + Number(`0.${frac}`),
      );
    });
    cmd.on("error", () => resolver(0));
    // ffmpeg sin archivo de salida termina con código 1: no es un fallo acá,
    // igual imprimió el encabezado que queremos.
    cmd.spawn().catch(() => resolver(0));
  });
}

/** Convierte la grabación cruda (.webm/Opus) al formato final elegido por el usuario. */
export function convertirAudio(
  entrada: string,
  salida: string,
  formato: FormatoAudio,
  opciones: OpcionesConversion = {},
): Promise<void> {
  const codec =
    formato === "mp3"
      ? // -q:a 4 ≈ 128 kbps VBR: de sobra para voz y pesa poco.
        ["-c:a", "libmp3lame", "-q:a", "4"]
      : ["-c:a", "pcm_s16le"];

  return ejecutar(
    [
      "-y",
      "-hide_banner",
      "-i",
      entrada,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "44100",
      ...codec,
      "-progress",
      "pipe:1",
      "-nostats",
      salida,
    ],
    opciones,
  );
}

/**
 * Extrae el tramo [desdeSeg, hastaSeg) sin recodificar (copia de flujo): es
 * rápido y no pierde calidad. Sirve tanto para "cortar desde un punto"
 * (desdeSeg=0) como de paso intermedio para "quitar un intervalo" (se
 * recortan las dos mitades por separado y después se unen con
 * `concatenarArchivos`).
 */
export function recortarSegmento(
  entrada: string,
  salida: string,
  desdeSeg: number,
  hastaSeg: number,
  opciones: OpcionesConversion = {},
): Promise<void> {
  return ejecutar(
    [
      "-y",
      "-hide_banner",
      "-i",
      entrada,
      "-ss",
      String(Math.max(0, desdeSeg)),
      "-to",
      String(hastaSeg),
      "-c",
      "copy",
      "-progress",
      "pipe:1",
      "-nostats",
      salida,
    ],
    opciones,
  );
}

/**
 * Concatena archivos del mismo códec (los tramos de `recortarSegmento`, por
 * ejemplo) sin recodificar, con el demuxer "concat" de ffmpeg. Necesita un
 * archivo de lista temporal: se escribe, se usa y se borra en el momento.
 */
export async function concatenarArchivos(
  rutas: string[],
  salida: string,
  carpetaTemp: string,
  opciones: OpcionesConversion = {},
): Promise<void> {
  const lista = unir(carpetaTemp, `concat_${Date.now()}.txt`);
  // ffmpeg interpreta backslashes de Windows como escapes dentro de este
  // archivo de lista: se pasa todo a barras normales para evitarlo.
  const contenido = rutas
    .map((r) => `file '${r.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
    .join("\n");
  await writeTextFile(lista, contenido);

  try {
    await ejecutar(
      [
        "-y",
        "-hide_banner",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        lista,
        "-c",
        "copy",
        "-progress",
        "pipe:1",
        "-nostats",
        salida,
      ],
      opciones,
    );
  } finally {
    if (await exists(lista)) await remove(lista);
  }
}

/**
 * WAV PCM 16 bits, 16 kHz, mono: el único formato de entrada que acepta
 * whisper.cpp. Se genera en una carpeta temporal justo antes de transcribir.
 */
export function extraerWav16k(
  entrada: string,
  salida: string,
  opciones: OpcionesConversion = {},
): Promise<void> {
  return ejecutar(
    [
      "-y",
      "-hide_banner",
      "-i",
      entrada,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "-progress",
      "pipe:1",
      "-nostats",
      salida,
    ],
    opciones,
  );
}
