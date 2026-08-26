/**
 * Transcripción vía API externa (Groq, OpenAI o un endpoint personalizado
 * compatible), con la clave del propio usuario.
 *
 * El audio se comprime primero con ffmpeg (ver `extraerAudioParaApi`) para no
 * chocar con el límite de tamaño del proveedor. La clave viaja cifrada
 * (DPAPI) hasta Rust: acá nunca se ve en texto plano ni se loguea.
 */
import { invoke } from "@tauri-apps/api/core";
import { exists, mkdir, remove, stat, writeTextFile } from "@tauri-apps/plugin-fs";

import { carpetaDeDatos } from "./almacen";
import { armarTexto, contarPalabras, type ResultadoTranscripcion } from "./transcripcion";
import { extraerAudioParaApi, generarSilencio, type VentanaAudio } from "./audio";
import { buscarProveedorApi, LIMITE_BYTES_API, urlProveedorApi } from "./modelos";
import { unir } from "./paths";
import type { Config, Grabacion, PerfilApi, Segmento } from "../types";
import type { Etapa } from "./transcripcion";

/** Igual forma que la salida de faster-whisper: `start`/`end` en segundos. */
interface SalidaVerboseJson {
  segments?: { start?: number; end?: number; text?: string }[];
  text?: string;
}

/** Se lanza cuando el audio comprimido supera el límite del proveedor. */
export class ErrorTamanoApi extends Error {}

/**
 * Se lanza cuando el proveedor devuelve 429 (rate limit). La cola de
 * transcripciones la usa para rotar de perfil en el modo "multi-API": ver
 * `opcionesMotor` y `procesar` en `estado/transcripciones.tsx`.
 */
export class ErrorLimiteApi extends Error {}

/**
 * Duración de cada tramo al mandar audio largo a la API. A 24 kbps, 90 min
 * pesan ~15,5 MB: bien por debajo del límite de 25 MB de Groq/OpenAI, con
 * margen para la variación normal del codificador entre tramos.
 */
const SEGUNDOS_POR_TRAMO = 90 * 60;

/**
 * Corta `duracionSeg` en tramos de `SEGUNDOS_POR_TRAMO`. Con duración
 * desconocida (0 o negativa) devuelve un único tramo sin recortar: se manda
 * el audio entero y el chequeo de tamaño después de comprimir hace de red de
 * seguridad (ver `ErrorTamanoApi`, que dispara el fallback a motor local).
 */
function planearTramos(duracionSeg: number): (VentanaAudio | undefined)[] {
  if (duracionSeg <= 0) return [undefined];
  const cantidad = Math.ceil(duracionSeg / SEGUNDOS_POR_TRAMO);
  return Array.from({ length: cantidad }, (_, i) => ({
    desdeSeg: i * SEGUNDOS_POR_TRAMO,
    duracionSeg: Math.min(SEGUNDOS_POR_TRAMO, duracionSeg - i * SEGUNDOS_POR_TRAMO),
  }));
}

async function carpetaTemporal(): Promise<string> {
  const carpeta = unir(await carpetaDeDatos(), "temp");
  if (!(await exists(carpeta))) await mkdir(carpeta, { recursive: true });
  return carpeta;
}

/** Perfiles con clave configurada: los únicos que se pueden ofrecer o usar. */
export function perfilesUsables(config: Config): PerfilApi[] {
  if (!config.apiTranscripcion.habilitada) return [];
  return config.apiTranscripcion.perfiles.filter((p) => p.claveCifrada);
}

/** true si hay al menos un perfil de API listo para usarse. */
export function apiDisponible(config: Config): boolean {
  return perfilesUsables(config).length > 0;
}

export function perfilPorId(config: Config, perfilId: string): PerfilApi | undefined {
  return config.apiTranscripcion.perfiles.find((p) => p.id === perfilId);
}

export async function guardarClaveApi(claveTextoPlano: string): Promise<string> {
  return invoke<string>("cifrar_clave_api", { clave: claveTextoPlano });
}

/** Llama a la API con un audio de prueba de 1 segundo de silencio. Lanza si falla. */
export async function probarConexionApi(perfil: PerfilApi): Promise<void> {
  if (!perfil.claveCifrada) throw new Error("Configura primero una clave de API.");
  const temp = await carpetaTemporal();
  const silencio = unir(temp, `prueba-api-${Date.now()}.wav`);
  try {
    await generarSilencio(silencio);
    await invoke<string>("transcribir_api", {
      url: urlProveedorApi(perfil),
      claveCifrada: perfil.claveCifrada,
      audio: silencio,
      modelo: buscarProveedorApi(perfil.proveedor).modelo,
      idioma: "auto",
    });
  } finally {
    if (await exists(silencio)) await remove(silencio);
  }
}

export async function transcribirConApi(
  grabacion: Grabacion,
  perfil: PerfilApi,
  idioma: string,
  tarea: string,
  onEtapa: (etapa: Etapa) => void,
): Promise<ResultadoTranscripcion> {
  if (!perfil.claveCifrada) {
    throw new Error(`El perfil "${perfil.nombre}" no tiene una clave de API configurada.`);
  }

  const temp = await carpetaTemporal();
  const comenzoEn = Date.now();
  const tramos = planearTramos(grabacion.duracionSeg);
  const segmentos: Segmento[] = [];

  for (let i = 0; i < tramos.length; i++) {
    const tramo = tramos[i];
    const parte = unir(temp, `${tarea}-${i}.mp3`);
    try {
      onEtapa("preparando");
      await extraerAudioParaApi(grabacion.archivoAudio, parte, {}, tramo);

      const { size } = await stat(parte);
      if (size > LIMITE_BYTES_API) {
        throw new ErrorTamanoApi(
          `El audio comprimido pesa ${(size / 1024 / 1024).toFixed(1)} MB, por encima del límite de 25 MB de la API.`,
        );
      }

      onEtapa("transcribiendo");
      const bruto = await invoke<string>("transcribir_api", {
        url: urlProveedorApi(perfil),
        claveCifrada: perfil.claveCifrada,
        audio: parte,
        modelo: buscarProveedorApi(perfil.proveedor).modelo,
        idioma,
      }).catch((e) => {
        const mensaje = e instanceof Error ? e.message : String(e);
        // El texto exacto lo arma transcripcion_api.rs al ver un 429.
        if (mensaje.includes("Límite de solicitudes")) throw new ErrorLimiteApi(mensaje);
        throw e instanceof Error ? e : new Error(mensaje);
      });

      // El offset ubica los tiempos del tramo dentro de la grabación completa.
      const offsetMs = (tramo?.desdeSeg ?? 0) * 1000;
      for (const s of (JSON.parse(bruto) as SalidaVerboseJson).segments ?? []) {
        segmentos.push({
          desdeMs: Math.round((s.start ?? 0) * 1000) + offsetMs,
          hastaMs: Math.round((s.end ?? 0) * 1000) + offsetMs,
          texto: (s.text ?? "").trim(),
        });
      }
    } finally {
      if (await exists(parte)) await remove(parte);
    }
  }

  onEtapa("guardando");
  const utiles = segmentos.filter((s) => s.texto.length > 0);
  if (utiles.length === 0) {
    throw new Error(
      "La API no reconoció nada en el audio. Revisa que la grabación tenga voz audible.",
    );
  }

  const texto = armarTexto(utiles);
  const rutaTxt = unir(grabacion.carpeta, `${grabacion.titulo}.txt`);
  const rutaSegmentos = unir(grabacion.carpeta, `${grabacion.titulo}.segmentos.json`);
  await writeTextFile(rutaTxt, texto);
  await writeTextFile(rutaSegmentos, JSON.stringify(utiles));

  return {
    transcripcion: {
      archivo: rutaTxt,
      archivoSegmentos: rutaSegmentos,
      motor: "api",
      modelo: perfil.nombre,
      fechaISO: new Date().toISOString(),
      palabras: contarPalabras(texto),
      duracionProcesoSeg: (Date.now() - comenzoEn) / 1000,
    },
    segmentos: utiles,
  };
}
