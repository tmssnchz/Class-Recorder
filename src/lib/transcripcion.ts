/**
 * Orquestación de una transcripción completa.
 *
 * 1. ffmpeg saca un WAV 16 kHz mono (lo único que acepta whisper.cpp)
 * 2. whisper-cli procesa ese WAV y deja un JSON con segmentos
 * 3. se escribe el .txt legible y el .segmentos.json con los tiempos
 */
import { invoke } from "@tauri-apps/api/core";
import { exists, mkdir, readTextFile, remove, writeTextFile } from "@tauri-apps/plugin-fs";

import { carpetaDeDatos } from "./almacen";
import { extraerWav16k } from "./audio";
import {
  buscarModelo,
  buscarModeloFaster,
  carpetaModelosFaster,
  carpetaDeModeloFaster,
  rutaBinario,
  rutaBinarioFaster,
  rutaModelo,
} from "./modelos";
import { unir } from "./paths";
import type { Config, Grabacion, Segmento, Transcripcion } from "../types";

export type Etapa = "preparando" | "transcribiendo" | "guardando";

/** Estructura del JSON que emite whisper-cli con -oj: offsets en milisegundos. */
interface SalidaWhisper {
  transcription?: {
    offsets?: { from?: number; to?: number };
    text?: string;
  }[];
}

/**
 * faster-whisper emite el formato del Whisper original: `segments` con
 * `start`/`end` en **segundos** (float), no milisegundos.
 */
interface SalidaFaster {
  segments?: { start?: number; end?: number; text?: string }[];
}

async function carpetaTemporal(): Promise<string> {
  const carpeta = unir(await carpetaDeDatos(), "temp");
  if (!(await exists(carpeta))) await mkdir(carpeta, { recursive: true });
  return carpeta;
}

/**
 * Une los segmentos en párrafos legibles: un corte largo entre frases o un
 * párrafo demasiado extenso abren uno nuevo. Sin esto queda un muro de texto.
 */
export function armarTexto(segmentos: Segmento[]): string {
  const parrafos: string[] = [];
  let actual = "";
  let finAnterior = 0;

  for (const s of segmentos) {
    const texto = s.texto.trim();
    if (!texto) continue;
    const pausaLarga = s.desdeMs - finAnterior > 2000;
    if (actual && (pausaLarga || actual.length > 700)) {
      parrafos.push(actual);
      actual = "";
    }
    actual = actual ? `${actual} ${texto}` : texto;
    finAnterior = s.hastaMs;
  }
  if (actual) parrafos.push(actual);
  return parrafos.join("\n\n");
}

export function contarPalabras(texto: string): number {
  const limpio = texto.trim();
  return limpio ? limpio.split(/\s+/).length : 0;
}

export interface ResultadoTranscripcion {
  transcripcion: Transcripcion;
  segmentos: Segmento[];
}

/** Comprueba que el motor elegido y su modelo estén instalados. */
async function verificarInstalacion(config: Config): Promise<void> {
  if (config.motorTranscripcion === "faster-whisper") {
    const modelo = buscarModeloFaster(config.modeloFaster);
    if (!(await exists(await rutaBinarioFaster()))) {
      throw new Error(
        "faster-whisper no está instalado. Instálalo desde Configuración.",
      );
    }
    if (!(await exists(await carpetaDeModeloFaster(modelo)))) {
      throw new Error(
        `El modelo ${modelo.etiqueta} de faster-whisper no está descargado. Descárgalo desde Configuración.`,
      );
    }
    return;
  }

  const modelo = buscarModelo(config.modelo);
  if (!(await exists(await rutaBinario()))) {
    throw new Error(
      "El motor de transcripción no está instalado. Instálalo desde Configuración.",
    );
  }
  if (!(await exists(await rutaModelo(modelo)))) {
    throw new Error(
      `El modelo ${modelo.etiqueta} no está descargado. Descárgalo desde Configuración.`,
    );
  }
}

export async function transcribirGrabacion(
  grabacion: Grabacion,
  config: Config,
  tarea: string,
  onEtapa: (etapa: Etapa) => void,
): Promise<ResultadoTranscripcion> {
  const conFaster = config.motorTranscripcion === "faster-whisper";
  await verificarInstalacion(config);

  const temp = await carpetaTemporal();
  const wav = unir(temp, `${tarea}.wav`);
  const baseSalida = unir(temp, tarea);
  // Ambos motores dejan el resultado en "{tarea}.json": whisper.cpp porque se
  // lo pasamos como -of, faster-whisper porque nombra la salida según el audio.
  const jsonWhisper = `${baseSalida}.json`;
  const comenzoEn = Date.now();

  try {
    onEtapa("preparando");
    await extraerWav16k(grabacion.archivoAudio, wav);

    onEtapa("transcribiendo");
    const hilos = config.hilosWhisper ?? (await invoke<number>("hilos_recomendados"));

    const bruto = conFaster
      ? await invoke<string>("transcribir_faster", {
          tarea,
          binario: await rutaBinarioFaster(),
          modelo: buscarModeloFaster(config.modeloFaster).modelo,
          carpetaModelos: await carpetaModelosFaster(),
          audio: wav,
          salidaDir: temp,
          salidaJson: jsonWhisper,
          idioma: config.idiomaTranscripcion,
          hilos,
        })
      : await invoke<string>("transcribir", {
          tarea,
          binario: await rutaBinario(),
          modelo: await rutaModelo(buscarModelo(config.modelo)),
          audio: wav,
          salidaBase: baseSalida,
          idioma: config.idiomaTranscripcion,
          hilos,
        });

    onEtapa("guardando");
    const segmentos: Segmento[] = conFaster
      ? ((JSON.parse(bruto) as SalidaFaster).segments ?? []).map((s) => ({
          // start/end vienen en segundos: se pasan a milisegundos para que el
          // resto de la app trate igual a los dos motores.
          desdeMs: Math.round((s.start ?? 0) * 1000),
          hastaMs: Math.round((s.end ?? 0) * 1000),
          texto: (s.text ?? "").trim(),
        }))
      : ((JSON.parse(bruto) as SalidaWhisper).transcription ?? []).map((s) => ({
          desdeMs: s.offsets?.from ?? 0,
          hastaMs: s.offsets?.to ?? 0,
          texto: (s.text ?? "").trim(),
        }));

    const utiles = segmentos.filter((s) => s.texto.length > 0);

    if (utiles.length === 0) {
      throw new Error(
        "whisper no reconoció nada en el audio. Revisa que la grabación tenga voz audible.",
      );
    }

    const texto = armarTexto(utiles);
    const rutaTxt = unir(grabacion.carpeta, `${grabacion.titulo}.txt`);
    const rutaSegmentos = unir(
      grabacion.carpeta,
      `${grabacion.titulo}.segmentos.json`,
    );

    await writeTextFile(rutaTxt, texto);
    await writeTextFile(rutaSegmentos, JSON.stringify(utiles));

    return {
      transcripcion: {
        archivo: rutaTxt,
        archivoSegmentos: rutaSegmentos,
        motor: conFaster ? "faster-whisper" : "whisper.cpp",
        modelo: conFaster ? config.modeloFaster : config.modelo,
        fechaISO: new Date().toISOString(),
        palabras: contarPalabras(texto),
        duracionProcesoSeg: (Date.now() - comenzoEn) / 1000,
      },
      segmentos: utiles,
    };
  } finally {
    // El WAV intermedio de una clase de 2 h pesa 220 MB: no puede quedar.
    for (const basura of [wav, jsonWhisper]) {
      try {
        if (await exists(basura)) await remove(basura);
      } catch (e) {
        console.warn(`No se pudo borrar el temporal ${basura}`, e);
      }
    }
  }
}

export async function leerSegmentos(t: Transcripcion): Promise<Segmento[]> {
  try {
    if (!(await exists(t.archivoSegmentos))) return [];
    return JSON.parse(await readTextFile(t.archivoSegmentos)) as Segmento[];
  } catch (e) {
    console.error("No se pudieron leer los segmentos", e);
    return [];
  }
}

export async function leerTexto(t: Transcripcion): Promise<string> {
  try {
    if (!(await exists(t.archivo))) return "";
    return await readTextFile(t.archivo);
  } catch {
    return "";
  }
}

export function cancelarTranscripcion(tarea: string): Promise<void> {
  return invoke("cancelar_transcripcion", { tarea });
}
