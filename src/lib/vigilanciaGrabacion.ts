/**
 * Lógica pura para vigilar una grabación en curso y auditarla al terminar.
 *
 * Sin imports de Tauri a propósito: se prueba con `node` (ver
 * vigilanciaGrabacion.test.mjs). El grabador solo le pasa relojes y eventos.
 */
import { formatearDuracion } from "./format.ts";

/** Sin chunks de MediaRecorder por más de esto = el micrófono dejó de entregar. */
export const LIMITE_SIN_CHUNKS_MS = 10_000;
/** Entre chunks normales hay TROZO_MS (5 s); por encima de esto se anota el hueco. */
export const HUECO_CHUNK_LOG_MS = 8_000;
/** Diferencia entre duración registrada y real que merece un aviso. */
export const UMBRAL_DIFERENCIA_SEG = 30;

export type ProblemaAudio = "ended" | "mute" | "sin-datos";

export function estaSinChunks(
  ahoraMs: number,
  ultimoChunkMs: number,
  limiteMs = LIMITE_SIN_CHUNKS_MS,
): boolean {
  return ahoraMs - ultimoChunkMs > limiteMs;
}

/** Segundos del hueco si el chunk llegó demasiado tarde; null si fue normal. */
export function huecoEntreChunks(
  ahoraMs: number,
  anteriorMs: number,
  minimoMs = HUECO_CHUNK_LOG_MS,
): number | null {
  const dt = ahoraMs - anteriorMs;
  return dt > minimoMs ? dt / 1000 : null;
}

/** Texto del aviso visible en la pantalla de grabar, o null si todo va bien. */
export function mensajeProblemaAudio(
  problemas: ReadonlySet<ProblemaAudio>,
  segundosSinDatos = 0,
): string | null {
  if (problemas.has("ended")) {
    return "El micrófono dejó de entregar audio (se desconectó o Windows lo cerró). Lo grabado hasta ahora está guardado, pero desde este momento NO se está grabando nada. Detén la grabación, revisa el micrófono y empieza otra.";
  }
  if (problemas.has("mute")) {
    return "Windows o el dispositivo silenció el micrófono: no está llegando sonido. La grabación sigue abierta, pero mientras esto dure no se graba nada.";
  }
  if (problemas.has("sin-datos")) {
    return `Hace ${Math.round(segundosSinDatos)} s que no llega audio al archivo. Puede que el micrófono se haya desconectado. La grabación sigue abierta por si se recupera.`;
  }
  return null;
}

/**
 * Aviso para la biblioteca cuando el audio real dura bastante menos (o más)
 * que lo que marcó el cronómetro. null si la diferencia es menor al umbral.
 */
export function avisoDuracion(
  registradaSeg: number,
  realSeg: number,
  umbralSeg = UMBRAL_DIFERENCIA_SEG,
): string | null {
  if (!(realSeg > 0) || !(registradaSeg > 0)) return null;
  if (Math.abs(registradaSeg - realSeg) <= umbralSeg) return null;
  const real = formatearDuracion(realSeg);
  const reg = formatearDuracion(registradaSeg);
  return realSeg < registradaSeg
    ? `El cronómetro marcó ${reg}, pero el audio guardado dura solo ${real}. El micrófono dejó de entregar sonido durante la grabación y lo que falta no se puede recuperar.`
    : `El cronómetro marcó ${reg}, pero el audio guardado dura ${real}.`;
}

/** Una línea del log de diagnóstico: tiempo de reloj y de cronómetro + evento. */
export function lineaLog(
  relojSeg: number,
  cronometroSeg: number,
  evento: string,
  detalle?: string,
): string {
  const t = (s: number) => s.toFixed(1).padStart(8, " ");
  return `[reloj ${t(relojSeg)} s | cron ${t(cronometroSeg)} s] ${evento}${
    detalle ? ` — ${detalle}` : ""
  }`;
}
