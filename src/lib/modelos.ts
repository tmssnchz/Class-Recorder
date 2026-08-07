/**
 * Catálogo de modelos de whisper y estado de la instalación local.
 *
 * Todo vive en %APPDATA%\com.tomas.classrecorder\whisper:
 *   whisper-cli.exe + DLLs   (motor)
 *   modelos\ggml-*.bin       (modelos)
 *
 * Las estimaciones de velocidad son para un portátil de gama media sin GPU
 * dedicada y sirven como orden de magnitud, no como promesa.
 */
import { exists, mkdir, remove } from "@tauri-apps/plugin-fs";

import { carpetaDeDatos } from "./almacen";
import { unir } from "./paths";
import type { IdModelo, IdModeloFaster, MotorTranscripcion } from "../types";

const BASE_HF = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";

/** Release verificado de whisper.cpp: build de CPU para Windows x64. */
export const URL_MOTOR =
  "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip";

export interface ModeloInfo {
  id: IdModelo;
  etiqueta: string;
  archivo: string;
  mb: number;
  /** Múltiplo aproximado del tiempo real: 0.35 = 42 min por cada 2 h de audio. */
  factorTiempo: number;
  descripcion: string;
}

export const MODELOS: ModeloInfo[] = [
  {
    id: "tiny-q5_1",
    etiqueta: "Tiny (cuantizado)",
    archivo: "ggml-tiny-q5_1.bin",
    mb: 31,
    factorTiempo: 0.06,
    descripcion:
      "El más rápido. Sirve para saber de qué se habló, no para citar textual.",
  },
  {
    id: "tiny",
    etiqueta: "Tiny",
    archivo: "ggml-tiny.bin",
    mb: 74,
    factorTiempo: 0.08,
    descripcion: "Igual que el anterior, sin cuantizar. Casi no se nota la mejora.",
  },
  {
    id: "base-q5_1",
    etiqueta: "Base (cuantizado)",
    archivo: "ggml-base-q5_1.bin",
    mb: 57,
    factorTiempo: 0.12,
    descripcion: "Rápido y ya entiende frases completas. Buen punto de partida.",
  },
  {
    id: "base",
    etiqueta: "Base",
    archivo: "ggml-base.bin",
    mb: 141,
    factorTiempo: 0.16,
    descripcion: "Un escalón sobre el cuantizado, sigue siendo veloz.",
  },
  {
    id: "small-q5_1",
    etiqueta: "Small (cuantizado)",
    archivo: "ggml-small-q5_1.bin",
    mb: 181,
    factorTiempo: 0.35,
    descripcion:
      "El equilibrio recomendado para español: reconoce vocabulario técnico y nombres propios sin comerse la RAM.",
  },
  {
    id: "small",
    etiqueta: "Small",
    archivo: "ggml-small.bin",
    mb: 465,
    factorTiempo: 0.45,
    descripcion: "Algo mejor que el cuantizado, ocupa bastante más memoria.",
  },
  {
    id: "medium-q5_0",
    etiqueta: "Medium (cuantizado)",
    archivo: "ggml-medium-q5_0.bin",
    mb: 514,
    factorTiempo: 1.1,
    descripcion:
      "Calidad alta. Con 8 GB de RAM conviene dejarlo corriendo sin usar la máquina.",
  },
  {
    id: "medium",
    etiqueta: "Medium",
    archivo: "ggml-medium.bin",
    mb: 1463,
    factorTiempo: 1.6,
    descripcion: "Muy lento en CPU y exige mucha memoria. Solo para dejar de noche.",
  },
  {
    id: "large-v3-turbo-q5_0",
    etiqueta: "Large v3 Turbo (cuantizado)",
    archivo: "ggml-large-v3-turbo-q5_0.bin",
    mb: 547,
    factorTiempo: 0.6,
    descripcion:
      "La mejor calidad que corre en un tiempo razonable sin GPU: casi como Medium pero bastante más rápido.",
  },
];

export function buscarModelo(id: IdModelo): ModeloInfo {
  return MODELOS.find((m) => m.id === id) ?? MODELOS[4];
}

// ------------------------------------------------------- faster-whisper

/**
 * Build standalone de faster-whisper (Purfview). Se elige el de CPU y no el
 * "XXL": este equipo tiene gráfica Intel integrada, así que las 1,4 GB de
 * CUDA y cuDNN del XXL no se podrían usar.
 */
export const URL_MOTOR_FASTER =
  "https://github.com/Purfview/whisper-standalone-win/releases/download/faster-whisper/Whisper-Faster_r192.3_windows.zip";

const BASE_HF_FASTER = "https://huggingface.co/Systran/";

export interface ModeloFasterInfo {
  id: IdModeloFaster;
  etiqueta: string;
  /** Nombre que espera `--model` y también la carpeta: `faster-whisper-{modelo}`. */
  modelo: string;
  /** Repositorio en Hugging Face. */
  repo: string;
  /**
   * Los repos no son uniformes: los chicos traen `vocabulary.txt` y large-v3
   * usa `vocabulary.json` y suma `preprocessor_config.json`. Verificado uno
   * por uno contra la API de Hugging Face.
   */
  archivos: string[];
  mb: number;
  factorTiempo: number;
  descripcion: string;
  /** true = con 8 GB de RAM conviene no usar la máquina mientras corre. */
  exigeRam?: boolean;
}

export const MODELOS_FASTER: ModeloFasterInfo[] = [
  {
    id: "fw-tiny",
    etiqueta: "Tiny",
    modelo: "tiny",
    repo: "faster-whisper-tiny",
    archivos: ["config.json", "model.bin", "tokenizer.json", "vocabulary.txt"],
    mb: 74,
    factorTiempo: 0.1,
    descripcion: "El más rápido. Sirve para saber de qué se habló, no para citar.",
  },
  {
    id: "fw-base",
    etiqueta: "Base",
    modelo: "base",
    repo: "faster-whisper-base",
    archivos: ["config.json", "model.bin", "tokenizer.json", "vocabulary.txt"],
    mb: 142,
    factorTiempo: 0.16,
    descripcion: "Rápido y ya entiende frases completas.",
  },
  {
    id: "fw-small",
    etiqueta: "Small",
    modelo: "small",
    repo: "faster-whisper-small",
    archivos: ["config.json", "model.bin", "tokenizer.json", "vocabulary.txt"],
    mb: 464,
    factorTiempo: 0.3,
    descripcion:
      "El equilibrio recomendado para español. Equivale al Small de whisper.cpp pero suele ser más rápido y puntuar mejor.",
  },
  {
    id: "fw-medium",
    etiqueta: "Medium",
    modelo: "medium",
    repo: "faster-whisper-medium",
    archivos: ["config.json", "model.bin", "tokenizer.json", "vocabulary.txt"],
    mb: 1459,
    factorTiempo: 0.7,
    descripcion: "Calidad alta, reconoce bien vocabulario técnico.",
    exigeRam: true,
  },
  {
    id: "fw-large-v3",
    etiqueta: "Large v3",
    modelo: "large-v3",
    repo: "faster-whisper-large-v3",
    archivos: [
      "config.json",
      "model.bin",
      "preprocessor_config.json",
      "tokenizer.json",
      "vocabulary.json",
    ],
    mb: 2947,
    factorTiempo: 1.3,
    descripcion:
      "La mejor calidad disponible. Ocupa 2,9 GB en disco y con 8 GB de RAM conviene dejarlo corriendo sin usar la máquina.",
    exigeRam: true,
  },
];

export function buscarModeloFaster(id: IdModeloFaster): ModeloFasterInfo {
  return MODELOS_FASTER.find((m) => m.id === id) ?? MODELOS_FASTER[2];
}

/**
 * Etiqueta legible de un modelo cualquiera. Una transcripción guarda el id del
 * modelo con el que se generó, que puede ser de cualquiera de los dos motores.
 */
export function etiquetaDeModelo(id: IdModelo | IdModeloFaster): string {
  const faster = MODELOS_FASTER.find((m) => m.id === id);
  if (faster) return `${faster.etiqueta} · faster-whisper`;
  const ggml = MODELOS.find((m) => m.id === id);
  return ggml ? `${ggml.etiqueta} · whisper.cpp` : id;
}

/** Cuánto tardaría `duracionSeg` con el motor y modelo configurados ahora. */
export function estimarConConfig(
  motor: MotorTranscripcion,
  modeloWhisper: IdModelo,
  modeloFaster: IdModeloFaster,
  duracionSeg: number,
): { etiqueta: string; segundos: number } {
  if (motor === "faster-whisper") {
    const m = buscarModeloFaster(modeloFaster);
    return { etiqueta: m.etiqueta, segundos: duracionSeg * m.factorTiempo };
  }
  const m = buscarModelo(modeloWhisper);
  return { etiqueta: m.etiqueta, segundos: estimarSegundos(m, duracionSeg) };
}

export function urlArchivoFaster(m: ModeloFasterInfo, archivo: string): string {
  return `${BASE_HF_FASTER}${m.repo}/resolve/main/${archivo}`;
}

/** Carpeta raíz de faster-whisper: el .exe vive acá y los modelos en `_models`. */
export async function carpetaFaster(): Promise<string> {
  const carpeta = unir(await carpetaDeDatos(), "faster-whisper");
  if (!(await exists(carpeta))) await mkdir(carpeta, { recursive: true });
  return carpeta;
}

/**
 * `--model_dir` recibe la carpeta contenedora; adentro busca
 * `faster-whisper-{modelo}`. Verificado empíricamente con el binario r192.3.
 */
export async function carpetaModelosFaster(): Promise<string> {
  const carpeta = unir(await carpetaFaster(), "_models");
  if (!(await exists(carpeta))) await mkdir(carpeta, { recursive: true });
  return carpeta;
}

export async function carpetaDeModeloFaster(m: ModeloFasterInfo): Promise<string> {
  return unir(await carpetaModelosFaster(), m.repo);
}

export async function rutaBinarioFaster(): Promise<string> {
  return unir(await carpetaFaster(), "whisper-faster.exe");
}

export function urlModelo(modelo: ModeloInfo): string {
  return BASE_HF + modelo.archivo;
}

/** Segundos estimados de proceso para un audio de `duracionSeg`. */
export function estimarSegundos(modelo: ModeloInfo, duracionSeg: number): number {
  return duracionSeg * modelo.factorTiempo;
}

// ------------------------------------------------------------------- rutas

export async function carpetaWhisper(): Promise<string> {
  const carpeta = unir(await carpetaDeDatos(), "whisper");
  if (!(await exists(carpeta))) await mkdir(carpeta, { recursive: true });
  return carpeta;
}

export async function carpetaModelos(): Promise<string> {
  const carpeta = unir(await carpetaWhisper(), "modelos");
  if (!(await exists(carpeta))) await mkdir(carpeta, { recursive: true });
  return carpeta;
}

export async function rutaBinario(): Promise<string> {
  return unir(await carpetaWhisper(), "whisper-cli.exe");
}

export async function rutaModelo(modelo: ModeloInfo): Promise<string> {
  return unir(await carpetaModelos(), modelo.archivo);
}

export interface EstadoInstalacion {
  motorInstalado: boolean;
  instalados: IdModelo[];
  motorFasterInstalado: boolean;
  instaladosFaster: IdModeloFaster[];
}

export async function revisarInstalacion(): Promise<EstadoInstalacion> {
  const motorInstalado = await exists(await rutaBinario());
  const carpeta = await carpetaModelos();
  const instalados: IdModelo[] = [];
  for (const m of MODELOS) {
    if (await exists(unir(carpeta, m.archivo))) instalados.push(m.id);
  }

  const motorFasterInstalado = await exists(await rutaBinarioFaster());
  const carpetaFw = await carpetaModelosFaster();
  const instaladosFaster: IdModeloFaster[] = [];
  for (const m of MODELOS_FASTER) {
    // Un modelo solo cuenta como instalado si están todos sus archivos: si se
    // cortó la descarga a la mitad, whisper fallaría con un error críptico.
    const carpetaModelo = unir(carpetaFw, m.repo);
    let completo = true;
    for (const archivo of m.archivos) {
      if (!(await exists(unir(carpetaModelo, archivo)))) {
        completo = false;
        break;
      }
    }
    if (completo) instaladosFaster.push(m.id);
  }

  return { motorInstalado, instalados, motorFasterInstalado, instaladosFaster };
}

export async function borrarModelo(modelo: ModeloInfo): Promise<void> {
  const ruta = await rutaModelo(modelo);
  if (await exists(ruta)) await remove(ruta);
}

export async function borrarModeloFaster(m: ModeloFasterInfo): Promise<void> {
  const carpeta = await carpetaDeModeloFaster(m);
  if (await exists(carpeta)) await remove(carpeta, { recursive: true });
}
