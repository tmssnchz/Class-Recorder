/**
 * Envoltorio del sidecar ffmpeg.
 *
 * MediaRecorder en WebView2 solo produce WebM/Opus, así que ffmpeg se encarga
 * de pasar a MP3/WAV y, más adelante, de generar el WAV 16 kHz mono que
 * whisper.cpp necesita como entrada.
 */
import { Command } from "@tauri-apps/plugin-shell";

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
