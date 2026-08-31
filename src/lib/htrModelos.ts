/**
 * Catálogo de motores de reconocimiento de texto manuscrito (HTR) y estado de
 * su instalación local.
 *
 * Todo vive en %APPDATA%\com.tomas.classrecorder\htr:
 *   llama-mtmd-cli.exe + DLLs   (motor, del release de llama.cpp)
 *   modelos\*.gguf              (modelo + su proyector multimodal)
 *
 * Por qué llama.cpp y no TrOCR: TrOCR (microsoft/trocr-*-handwritten) está
 * entrenado sobre IAM, que es manuscrita en inglés, y no tiene soporte oficial
 * de español. Los VLM de OCR que salieron en 2026 sí son multilingües, vienen
 * en GGUF y corren con el mismo patrón de "ejecutable descargado aparte" que
 * ya usa whisper.cpp en esta app: sin Python, sin CUDA, sin dependencias del
 * sistema.
 *
 * Los tiempos son medidos en un portátil sin GPU dedicada, sobre una hoja B5
 * reducida a 1400 px de lado largo (ver `LADO_HTR_PX` en el backend). Sirven
 * como orden de magnitud, no como promesa.
 */
import { exists, mkdir, remove } from "@tauri-apps/plugin-fs";

import { carpetaDeDatos } from "./almacen";
import type { OpcionRecomendable } from "./hardware";
import { unir } from "./paths";
import type { IdModeloHtr } from "../types";

/** Release de llama.cpp: build de CPU para Windows x64, igual criterio que whisper. */
export const URL_MOTOR_HTR =
  "https://github.com/ggml-org/llama.cpp/releases/download/b10705/llama-b10705-bin-win-cpu-x64.zip";

const BASE_HF_HTR = "https://huggingface.co/ggml-org/";

export interface ModeloHtrInfo extends OpcionRecomendable {
  id: IdModeloHtr;
  etiqueta: string;
  /** Repositorio GGUF en Hugging Face. */
  repo: string;
  /** Pesos del modelo de lenguaje. */
  archivoModelo: string;
  /** Proyector multimodal: sin esto el modelo no ve la imagen. */
  archivoMmproj: string;
  mb: number;
  ramGB: number;
  calidad: number;
  /** Minutos aproximados por hoja en CPU. */
  minutosPorHoja: number;
  descripcion: string;
}

export const MODELOS_HTR: ModeloHtrInfo[] = [
  {
    id: "lighton-ocr",
    etiqueta: "LightOnOCR 1B",
    repo: "LightOnOCR-2-1B-GGUF",
    archivoModelo: "LightOnOCR-2-1B-Q8_0.gguf",
    archivoMmproj: "mmproj-LightOnOCR-2-1B-Q8_0.gguf",
    mb: 1039,
    ramGB: 3,
    calidad: 1,
    minutosPorHoja: 1,
    descripcion:
      "El más liviano. Sirve para tener el apunte buscable; en letra apretada se equivoca seguido.",
  },
  {
    id: "glm-ocr",
    etiqueta: "GLM-OCR",
    repo: "GLM-OCR-GGUF",
    archivoModelo: "GLM-OCR-Q8_0.gguf",
    archivoMmproj: "mmproj-GLM-OCR-Q8_0.gguf",
    mb: 1368,
    ramGB: 4,
    calidad: 2,
    minutosPorHoja: 2,
    descripcion:
      "El equilibrio recomendado para apuntes en español: usa el contexto de la frase para resolver palabras dudosas, que es justo lo que hace falta en manuscrita.",
  },
  {
    id: "dots-ocr",
    etiqueta: "dots.ocr 2B",
    repo: "dots.ocr-GGUF",
    archivoModelo: "dots.ocr-Q8_0.gguf",
    archivoMmproj: "mmproj-dots.ocr-Q8_0.gguf",
    mb: 3089,
    ramGB: 8,
    calidad: 3,
    minutosPorHoja: 5,
    descripcion:
      "El más preciso en alfabeto latino, y el más lento y pesado. Vale la pena si dejas la cola corriendo de noche.",
  },
];

export function buscarModeloHtr(id: IdModeloHtr): ModeloHtrInfo {
  return MODELOS_HTR.find((m) => m.id === id) ?? MODELOS_HTR[1];
}

export function urlArchivoHtr(m: ModeloHtrInfo, archivo: string): string {
  return `${BASE_HF_HTR}${m.repo}/resolve/main/${archivo}`;
}

// ------------------------------------------------------------------- rutas

export async function carpetaHtr(): Promise<string> {
  const carpeta = unir(await carpetaDeDatos(), "htr");
  if (!(await exists(carpeta))) await mkdir(carpeta, { recursive: true });
  return carpeta;
}

export async function carpetaModelosHtr(): Promise<string> {
  const carpeta = unir(await carpetaHtr(), "modelos");
  if (!(await exists(carpeta))) await mkdir(carpeta, { recursive: true });
  return carpeta;
}

export async function rutaBinarioHtr(): Promise<string> {
  return unir(await carpetaHtr(), "llama-mtmd-cli.exe");
}

export async function rutaModeloHtr(m: ModeloHtrInfo): Promise<string> {
  return unir(await carpetaModelosHtr(), m.archivoModelo);
}

export async function rutaMmprojHtr(m: ModeloHtrInfo): Promise<string> {
  return unir(await carpetaModelosHtr(), m.archivoMmproj);
}

export interface EstadoInstalacionHtr {
  motorInstalado: boolean;
  instalados: IdModeloHtr[];
}

export async function revisarInstalacionHtr(): Promise<EstadoInstalacionHtr> {
  const motorInstalado = await exists(await rutaBinarioHtr());
  const instalados: IdModeloHtr[] = [];
  for (const m of MODELOS_HTR) {
    // Los dos archivos o ninguno: sin el proyector, llama.cpp arranca y falla
    // recién al pasarle la imagen, con un error que no dice nada.
    const completo =
      (await exists(await rutaModeloHtr(m))) && (await exists(await rutaMmprojHtr(m)));
    if (completo) instalados.push(m.id);
  }
  return { motorInstalado, instalados };
}

export async function borrarModeloHtr(m: ModeloHtrInfo): Promise<void> {
  for (const ruta of [await rutaModeloHtr(m), await rutaMmprojHtr(m)]) {
    if (await exists(ruta)) await remove(ruta);
  }
}

/** Minutos estimados para reconocer `hojas` páginas con el modelo elegido. */
export function estimarMinutos(m: ModeloHtrInfo, hojas: number): number {
  return m.minutosPorHoja * hojas;
}
