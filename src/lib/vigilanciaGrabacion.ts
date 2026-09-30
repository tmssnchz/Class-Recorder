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
    return "El micrófono dejó de entregar audio (se desconectó o Windows lo cerró). Lo grabado hasta ahora está guardado. Se está intentando reabrirlo solo; mientras tanto NO se graba nada. Si no vuelve, revisa el micrófono y detén la grabación.";
  }
  if (problemas.has("mute")) {
    return "Windows o el dispositivo silenció el micrófono: no está llegando sonido. La grabación sigue abierta, pero mientras esto dure no se graba nada.";
  }
  if (problemas.has("sin-datos")) {
    return `Hace ${Math.round(segundosSinDatos)} s que no llega audio al archivo. Puede que el micrófono se haya desconectado. Se está intentando reabrirlo solo.`;
  }
  return null;
}

/** Aviso cuando el micrófono ya se reabrió: cuánto audio faltó (quedó en silencio). */
export function mensajeReapertura(silenciosSeg: readonly number[]): string | null {
  if (silenciosSeg.length === 0) return null;
  const total = silenciosSeg.reduce((a, b) => a + b, 0);
  const veces = silenciosSeg.length === 1 ? "1 vez" : `${silenciosSeg.length} veces`;
  return `El micrófono se cortó ${veces} y se reabrió solo. Faltan unos ${Math.round(total)} s de audio en total; esos tramos quedaron en silencio.`;
}

export interface TramoAudio {
  ruta: string;
  /** Silencio que se intercala antes de este tramo (lo que duró el corte). */
  silencioAntesSeg: number;
}

/**
 * Argumentos de ffmpeg para unir los segmentos de una grabación cortada en un
 * solo WebM, rellenando cada corte con silencio para que el audio siga
 * alineado con el cronómetro (y con las marcas). Recodifica a Opus: los
 * segmentos de MediaRecorder traen marcas de tiempo propias y copiarlos sin
 * más daría saltos.
 */
export function argsUnirTramos(tramos: readonly TramoAudio[], salida: string): string[] {
  const entradas: string[] = [];
  const nodos: string[] = [];
  const filtros: string[] = [];
  let i = 0;
  for (const t of tramos) {
    if (t.silencioAntesSeg > 0) {
      entradas.push("-f", "lavfi", "-t", t.silencioAntesSeg.toFixed(3), "-i", "anullsrc=r=48000:cl=mono");
      filtros.push(`[${i}:a]aformat=channel_layouts=mono[n${i}]`);
      nodos.push(`[n${i}]`);
      i++;
    }
    entradas.push("-i", t.ruta);
    filtros.push(`[${i}:a]aresample=48000,aformat=channel_layouts=mono[n${i}]`);
    nodos.push(`[n${i}]`);
    i++;
  }
  filtros.push(`${nodos.join("")}concat=n=${nodos.length}:v=0:a=1[o]`);
  return [
    "-y", "-hide_banner", ...entradas,
    "-filter_complex", filtros.join(";"),
    "-map", "[o]", "-c:a", "libopus", "-b:a", "64k", "-f", "webm", salida,
  ];
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

/**
 * Corrección de una grabación ya guardada: si el audio real difiere más del
 * umbral de lo registrado, devuelve la duración real y el aviso (con cuántas
 * marcas quedaron fuera del audio). null = no hay nada que corregir; por eso
 * repetirla no cambia nada.
 */
export function correccionDuracion(
  registradaSeg: number,
  realSeg: number,
  marcasSeg: readonly number[],
): { duracionSeg: number; avisoAudio: string } | null {
  const aviso = avisoDuracion(registradaSeg, realSeg);
  if (!aviso) return null;
  const fuera = marcasSeg.filter((s) => s > realSeg).length;
  const extra =
    fuera > 0
      ? ` ${fuera === 1 ? "1 marca queda" : `${fuera} marcas quedan`} fuera del audio.`
      : "";
  return { duracionSeg: realSeg, avisoAudio: aviso + extra };
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
