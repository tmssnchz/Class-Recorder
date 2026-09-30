/**
 * Transcripción vía API externa (OpenRouter, o un endpoint compatible OpenAI),
 * con la clave del propio usuario.
 *
 * La clase se parte en trozos de pocos minutos (ver `troceo.ts`), cada trozo se
 * comprime con ffmpeg y se manda por separado, con concurrencia limitada. Si un
 * trozo falla, los demás quedan guardados en disco y al reintentar solo se
 * repiten los que faltan. La clave viaja cifrada (DPAPI) hasta Rust: acá nunca
 * se ve en texto plano ni se loguea.
 */
import { invoke } from "@tauri-apps/api/core";
import {
  exists,
  mkdir,
  readTextFile,
  remove,
  stat,
  writeTextFile,
} from "@tauri-apps/plugin-fs";

import { carpetaDeDatos } from "./almacen";
import { armarTexto, contarPalabras, type ResultadoTranscripcion } from "./transcripcion";
import { detectarSilencios, duracionDe, extraerAudioParaApi, generarSilencio } from "./audio";
import { LIMITE_BYTES_API, modeloDePerfil, urlProveedorApi } from "./modelos";
import { unir } from "./paths";
import {
  aTiempoGlobal,
  deduplicarUnion,
  filtrarAlucinaciones,
  FRACCION_SILENCIO_OMITIR,
  fraccionSilencio,
  mapConcurrente,
  planearTrozos,
  segmentoDeTrozo,
  type SegmentoApiTrozo,
  type Trozo,
} from "./troceo";
import type {
  Config,
  Grabacion,
  MotorPredeterminado,
  PerfilApi,
  Segmento,
} from "../types";
import type { Etapa } from "./transcripcion";

/** Se lanza cuando el audio comprimido supera el límite del proveedor. */
export class ErrorTamanoApi extends Error {}

/**
 * Se lanza cuando el proveedor devuelve 429 (rate limit) y ya se agotaron los
 * reintentos. La cola de transcripciones la usa para rotar de perfil en el
 * modo "multi-API": ver `opcionesMotor` y `procesar` en `estado/transcripciones.tsx`.
 */
export class ErrorLimiteApi extends Error {}

export type CodigoErrorApi =
  | "claveInvalida"
  | "sinSaldo"
  | "limiteTasa"
  | "sinRed"
  | "deshabilitado"
  | "noImplementado"
  | "otro";

/** Error de un proveedor ya clasificado (lo arma `aErrorProveedor`). */
export class ErrorProveedorApi extends Error {
  constructor(
    public codigo: CodigoErrorApi,
    mensaje: string,
  ) {
    super(mensaje);
  }
}

/** Progreso por trozo que la cola muestra en la UI. */
export interface ProgresoTrozos {
  hechos: number;
  total: number;
  fallidos: number;
}

export interface OpcionesApi {
  /** Contexto para orientar a Whisper. OpenRouter hoy lo ignora. */
  prompt?: string;
  onProgreso?: (progreso: ProgresoTrozos) => void;
}

/** Proveedores que pasan por el trait de Rust; el resto usa el endpoint OpenAI genérico. */
const PROVEEDORES_TRAIT = ["openrouter", "groq"];

/**
 * Trozos en vuelo a la vez. Los límites de concurrencia de OpenRouter no están
 * documentados: se parte de 3 y se baja si aparecen 429 seguidos.
 */
const CONCURRENCIA = 3;

/** Con respuestas por encima de esto se avisa: el endpoint corta a los 60 s. */
const RESPUESTA_LENTA_MS = 45_000;

interface RespuestaTrozo {
  texto: string;
  segmentos: SegmentoApiTrozo[];
  msRespuesta: number;
}

/** Igual forma que la salida de faster-whisper: `start`/`end` en segundos. */
interface SalidaVerboseJson {
  segments?: { start?: number; end?: number; text?: string }[];
  text?: string;
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

/**
 * Motor que se usa sin preguntar, o `null` si hay que preguntar. Es lo que
 * promete Configuración: el predeterminado se aplica solo, y el modal de
 * elección queda para cuando el predeterminado es el motor local y además
 * hay perfiles de API configurados.
 */
export function motorSinPreguntar(config: Config): MotorPredeterminado | null {
  const usables = perfilesUsables(config);
  if (usables.length === 0) return { tipo: "local" };
  const pre = config.apiTranscripcion.predeterminado;
  if (pre.tipo === "multiapi") return pre;
  if (pre.tipo === "api" && usables.some((p) => p.id === pre.perfilId)) return pre;
  return null;
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

/** Contexto de la clase para el prompt: el vocabulario configurado y el nombre del ramo. */
export function opcionesApi(
  config: Config,
  grabacion: Grabacion,
  onProgreso?: (progreso: ProgresoTrozos) => void,
): OpcionesApi {
  const partes = [config.apiTranscripcion.promptContexto.trim(), grabacion.claseNombre && `Ramo: ${grabacion.claseNombre}.`];
  return { prompt: partes.filter(Boolean).join(" "), onProgreso };
}

/**
 * Convierte lo que rechaza `invoke` en un error con código. Rust manda
 * `{codigo, mensaje}`; el endpoint genérico (`transcribir_api`) manda un texto.
 */
function aErrorProveedor(e: unknown): ErrorProveedorApi {
  if (e instanceof ErrorProveedorApi) return e;
  if (e && typeof e === "object" && "codigo" in e && "mensaje" in e) {
    const { codigo, mensaje } = e as { codigo: CodigoErrorApi; mensaje: string };
    return new ErrorProveedorApi(codigo, mensaje);
  }
  const mensaje = e instanceof Error ? e.message : String(e);
  // Los textos exactos los arma transcripcion_api.rs.
  if (mensaje.includes("Límite de solicitudes")) return new ErrorProveedorApi("limiteTasa", mensaje);
  if (mensaje.includes("no es válida")) return new ErrorProveedorApi("claveInvalida", mensaje);
  if (mensaje.includes("No se pudo conectar")) return new ErrorProveedorApi("sinRed", mensaje);
  return new ErrorProveedorApi("otro", mensaje);
}

/** Un trozo, por el proveedor que corresponda al perfil. Lanza `ErrorProveedorApi`. */
async function transcribirTrozoApi(
  perfil: PerfilApi,
  audio: string,
  idioma: string,
  prompt: string | undefined,
): Promise<RespuestaTrozo> {
  try {
    if (PROVEEDORES_TRAIT.includes(perfil.proveedor)) {
      return await invoke<RespuestaTrozo>("transcribir_trozo", {
        proveedor: perfil.proveedor,
        claveCifrada: perfil.claveCifrada,
        audio,
        modelo: modeloDePerfil(perfil),
        idioma,
        prompt: prompt || null,
      });
    }
    const inicio = Date.now();
    const bruto = await invoke<string>("transcribir_api", {
      url: urlProveedorApi(perfil),
      claveCifrada: perfil.claveCifrada,
      audio,
      modelo: modeloDePerfil(perfil),
      idioma,
    });
    const json = JSON.parse(bruto) as SalidaVerboseJson;
    return {
      texto: json.text ?? "",
      segmentos: (json.segments ?? []).map((s) => ({
        inicioS: s.start ?? 0,
        finS: s.end ?? 0,
        texto: s.text ?? "",
      })),
      msRespuesta: Date.now() - inicio,
    };
  } catch (e) {
    throw aErrorProveedor(e);
  }
}

/** Llama a la API con un audio de prueba de 1 segundo de silencio. Lanza si falla. */
export async function probarConexionApi(perfil: PerfilApi): Promise<void> {
  if (!perfil.claveCifrada) throw new Error("Configura primero una clave de API.");
  const temp = await carpetaTemporal();
  const silencio = unir(temp, `prueba-api-${Date.now()}.wav`);
  try {
    await generarSilencio(silencio);
    await transcribirTrozoApi(perfil, silencio, "auto", undefined);
  } finally {
    if (await exists(silencio)) await remove(silencio);
  }
}

// --------------------------------------------------------- trozos en disco

interface TrozoGuardado {
  desdeSeg: number;
  hastaSeg: number;
  respuesta: RespuestaTrozo;
}

/** Lo que ya se transcribió de este trozo en un intento anterior, si sigue valiendo. */
async function leerGuardado(ruta: string, trozo: Trozo): Promise<RespuestaTrozo | null> {
  try {
    if (!(await exists(ruta))) return null;
    const g = JSON.parse(await readTextFile(ruta)) as TrozoGuardado;
    const coincide =
      Math.abs(g.desdeSeg - trozo.desdeSeg) < 0.01 && Math.abs(g.hastaSeg - trozo.hastaSeg) < 0.01;
    return coincide ? g.respuesta : null;
  } catch {
    return null;
  }
}

function mmss(seg: number): string {
  const m = Math.floor(seg / 60);
  return `${m}:${String(Math.floor(seg % 60)).padStart(2, "0")}`;
}

// ----------------------------------------------------------- transcripción

export async function transcribirConApi(
  grabacion: Grabacion,
  perfil: PerfilApi,
  idioma: string,
  tarea: string,
  onEtapa: (etapa: Etapa) => void,
  opciones: OpcionesApi = {},
): Promise<ResultadoTranscripcion> {
  if (!perfil.claveCifrada) {
    throw new Error(`El perfil "${perfil.nombre}" no tiene una clave de API configurada.`);
  }

  const temp = await carpetaTemporal();
  const comenzoEn = Date.now();

  onEtapa("preparando");
  // La duración del archivo manda sobre la registrada: si la registrada es mayor
  // (una grabación cuyo audio quedó más corto), los últimos trozos caerían
  // pasado el final, ffmpeg los dejaría vacíos y el proveedor respondería 400.
  const real = await duracionDe(grabacion.archivoAudio);
  const duracion = real > 0 ? real : grabacion.duracionSeg;
  if (duracion <= 0) {
    throw new Error("No se pudo determinar la duración del audio para dividirlo en trozos.");
  }
  const silencios = await detectarSilencios(grabacion.archivoAudio, duracion);
  const trozos = planearTrozos(duracion, silencios);

  // Los trozos ya transcritos en un intento anterior que falló se reutilizan.
  const carpetaCache = unir(temp, `${tarea}-trozos`);
  if (!(await exists(carpetaCache))) await mkdir(carpetaCache, { recursive: true });
  const rutaCache = (t: Trozo) => unir(carpetaCache, `trozo-${t.indice}.json`);

  const respuestas: (RespuestaTrozo | null)[] = new Array(trozos.length).fill(null);
  const pendientes: Trozo[] = [];
  for (const t of trozos) {
    if (fraccionSilencio(t, silencios) >= FRACCION_SILENCIO_OMITIR) {
      respuestas[t.indice] = { texto: "", segmentos: [], msRespuesta: 0 }; // Whisper alucina en silencios: no se manda.
      continue;
    }
    const guardado = await leerGuardado(rutaCache(t), t);
    if (guardado) respuestas[t.indice] = guardado;
    else pendientes.push(t);
  }

  const progreso: ProgresoTrozos = { hechos: trozos.length - pendientes.length, total: trozos.length, fallidos: 0 };
  opciones.onProgreso?.({ ...progreso });

  onEtapa("transcribiendo");
  // `as`: TS no ve las asignaciones dentro del closure y estrecharía esto a `null`.
  let fatal = null as Error | null;
  const resultados = await mapConcurrente(pendientes, CONCURRENCIA, async (t) => {
    // Con la clave mala o sin saldo, mandar el resto solo gasta llamadas.
    if (fatal) throw fatal;
    const parte = unir(temp, `${tarea}-${t.indice}.mp3`);
    try {
      await extraerAudioParaApi(grabacion.archivoAudio, parte, {}, {
        desdeSeg: t.desdeSeg,
        duracionSeg: t.hastaSeg - t.desdeSeg,
      });
      const { size } = await stat(parte);
      if (size > LIMITE_BYTES_API) {
        fatal = new ErrorTamanoApi(
          `El trozo comprimido pesa ${(size / 1024 / 1024).toFixed(1)} MB, por encima del límite de 25 MB de la API.`,
        );
        throw fatal;
      }
      const respuesta = await transcribirTrozoApi(perfil, parte, idioma, opciones.prompt);
      const guardado: TrozoGuardado = { desdeSeg: t.desdeSeg, hastaSeg: t.hastaSeg, respuesta };
      await writeTextFile(rutaCache(t), JSON.stringify(guardado));
      respuestas[t.indice] = respuesta;
      progreso.hechos += 1;
      return respuesta;
    } catch (e) {
      progreso.fallidos += 1;
      if (e instanceof ErrorProveedorApi && ["claveInvalida", "sinSaldo", "limiteTasa", "deshabilitado"].includes(e.codigo)) {
        fatal ??= e;
      }
      throw e;
    } finally {
      opciones.onProgreso?.({ ...progreso });
      if (await exists(parte)) await remove(parte);
    }
  });

  const tiempos = resultados.flatMap((r) => (r.ok ? [r.valor.msRespuesta] : []));
  if (tiempos.length > 0) {
    const media = tiempos.reduce((a, b) => a + b, 0) / tiempos.length;
    console.info(
      `API: ${tiempos.length} trozos transcritos, respuesta media ${(media / 1000).toFixed(1)} s, máxima ${(Math.max(...tiempos) / 1000).toFixed(1)} s (el endpoint corta a los 60 s).`,
    );
  }

  const fallidos = resultados.flatMap((r, i) => (r.ok ? [] : [{ trozo: pendientes[i], error: r.error }]));
  if (fallidos.length > 0) {
    if (fatal instanceof ErrorTamanoApi) throw fatal;
    if (fatal instanceof ErrorProveedorApi && fatal.codigo === "limiteTasa") throw new ErrorLimiteApi(fatal.message);
    if (fatal) throw fatal;
    const lista = fallidos.map((f) => `${mmss(f.trozo.propioDesdeSeg)}–${mmss(f.trozo.hastaSeg)}`).join(", ");
    const motivo = aErrorProveedor(fallidos[0].error).message;
    throw new Error(
      `Fallaron ${fallidos.length} de ${trozos.length} trozos (${lista}): ${motivo} Los demás quedaron guardados: al reintentar solo se repiten los fallidos.`,
    );
  }

  // Unión en orden: tiempos a la clase, solapes fuera, repetidos de las uniones fuera.
  onEtapa("guardando");
  const segmentos: Segmento[] = [];
  let sinTiempos = 0;
  for (const t of trozos) {
    const r = respuestas[t.indice];
    if (!r) continue;
    let nuevos: Segmento[];
    if (r.segmentos.length > 0) {
      nuevos = aTiempoGlobal(r.segmentos, t);
    } else {
      nuevos = segmentoDeTrozo(r.texto, t);
      if (nuevos.length > 0) sinTiempos += 1;
    }
    segmentos.push(...deduplicarUnion(segmentos, nuevos));
  }

  const { segmentos: limpios, descartados } = filtrarAlucinaciones(segmentos);
  segmentos.splice(0, segmentos.length, ...limpios);

  if (segmentos.length === 0) {
    throw new Error(
      "La API no reconoció nada en el audio. Revisa que la grabación tenga voz audible.",
    );
  }

  const avisos: string[] = [];
  if (sinTiempos > 0) {
    avisos.push(
      `El proveedor no devolvió marcas de tiempo en ${sinTiempos} de ${trozos.length} trozos: en esos tramos los tiempos son aproximados (un bloque por trozo, de unos ${mmss(trozos[0].hastaSeg - trozos[0].propioDesdeSeg)} min).`,
    );
  }
  if (descartados > 0) {
    avisos.push(
      `Se descartaron ${descartados} segmentos que parecen alucinaciones de Whisper (ej. «Gracias.» repetido, bucles). Si una parte sale vacía, el audio de ese tramo tenía poca voz.`,
    );
  }
  if (tiempos.some((ms) => ms > RESPUESTA_LENTA_MS)) {
    avisos.push("Algunas respuestas tardaron más de 45 s, cerca del límite de 60 s del endpoint: conviene acortar los trozos.");
  }

  const texto = armarTexto(segmentos);
  const rutaTxt = unir(grabacion.carpeta, `${grabacion.titulo}.txt`);
  const rutaSegmentos = unir(grabacion.carpeta, `${grabacion.titulo}.segmentos.json`);
  await writeTextFile(rutaTxt, texto);
  await writeTextFile(rutaSegmentos, JSON.stringify(segmentos));
  await remove(carpetaCache, { recursive: true });

  return {
    transcripcion: {
      archivo: rutaTxt,
      archivoSegmentos: rutaSegmentos,
      motor: "api",
      modelo: perfil.nombre,
      fechaISO: new Date().toISOString(),
      palabras: contarPalabras(texto),
      duracionProcesoSeg: (Date.now() - comenzoEn) / 1000,
      ...(avisos.length > 0 && { aviso: avisos.join(" ") }),
    },
    segmentos,
  };
}
