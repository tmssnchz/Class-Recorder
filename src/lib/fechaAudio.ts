/**
 * Estimación de cuándo se grabó realmente un audio importado.
 *
 * Una grabación nativa sabe su hora porque la cronometró. Un archivo que viene
 * del celular no: hay que deducirla, y de esa hora depende que la sugerencia de
 * clase contra "Mi horario" sea correcta. Por eso cada estimación viaja con su
 * origen, para poder mostrarle al usuario de dónde salió antes de confirmar.
 *
 * Prioridad: metadata embebida > fecha en el nombre > llegada del archivo.
 */
import type { BloqueHorario } from "../types.ts";

export type OrigenFecha = "metadata" | "nombre" | "llegada" | "ninguna";

export interface FechaEstimada {
  fecha: Date;
  origen: OrigenFecha;
}

/** Marca de qué teléfono salen los audios, para no adivinar el patrón cada vez. */
export type OrigenGrabaciones = "iphone" | "android" | "otro";

/**
 * Patrones de nombre que usan las apps de grabación más comunes.
 *
 * Android y WhatsApp suelen incrustar la fecha; iPhone no (Voice Memos nombra
 * "Nueva grabación 3"), así que ahí la única señal útil es la metadata.
 */
const PATRONES: { re: RegExp; conHora: boolean }[] = [
  // 20260807_143000 · 20260807-143000 · 20260807 143000
  { re: /(\d{4})(\d{2})(\d{2})[_\-. ](\d{2})(\d{2})(\d{2})/, conHora: true },
  // 2026-08-07_14-30-00 · 2026-08-07 14.30.00
  {
    re: /(\d{4})-(\d{2})-(\d{2})[_\-. ](\d{2})[-.:](\d{2})[-.:](\d{2})/,
    conHora: true,
  },
  // 2026-08-07_14-30 (sin segundos)
  { re: /(\d{4})-(\d{2})-(\d{2})[_\-. ](\d{2})[-.:](\d{2})(?!\d)/, conHora: true },
  // PTT-20260807-WA0001 · AUD-20260807-WA0002: solo fecha, sin hora
  { re: /(\d{4})(\d{2})(\d{2})-WA\d+/i, conHora: false },
  // 2026-08-07 suelto
  { re: /(\d{4})-(\d{2})-(\d{2})(?![\d-])/, conHora: false },
];

function fechaValida(
  a: number,
  mes: number,
  d: number,
  h = 0,
  min = 0,
  s = 0,
): Date | null {
  if (a < 2000 || a > 2100 || mes < 1 || mes > 12 || d < 1 || d > 31) return null;
  if (h > 23 || min > 59 || s > 59) return null;
  const fecha = new Date(a, mes - 1, d, h, min, s);
  // Rechaza cosas como el 31 de febrero, que Date corre al mes siguiente.
  return fecha.getMonth() === mes - 1 && fecha.getDate() === d ? fecha : null;
}

/** Busca una fecha dentro del nombre del archivo. null si no hay ninguna. */
export function fechaDesdeNombre(nombre: string): Date | null {
  for (const { re, conHora } of PATRONES) {
    const m = re.exec(nombre);
    if (!m) continue;
    const n = m.slice(1).map(Number);
    const fecha = conHora
      ? fechaValida(n[0], n[1], n[2], n[3], n[4], n[5] ?? 0)
      : fechaValida(n[0], n[1], n[2]);
    if (fecha) return fecha;
  }
  return null;
}

/**
 * Combina las señales disponibles en una sola estimación.
 *
 * `permitirLlegada` en false deja `origen: "ninguna"` cuando las dos primeras
 * señales fallan: la fecha se devuelve igual porque hace falta para nombrar el
 * archivo, pero marcada como no confiable para no sugerir una clase a partir
 * de ella.
 */
export function estimarFecha(
  nombre: string,
  llegadaMs: number,
  fechaMetadata: Date | null,
  permitirLlegada: boolean,
): FechaEstimada {
  if (fechaMetadata) return { fecha: fechaMetadata, origen: "metadata" };

  const delNombre = fechaDesdeNombre(nombre);
  if (delNombre) return { fecha: delNombre, origen: "nombre" };

  return {
    fecha: new Date(llegadaMs),
    origen: permitirLlegada ? "llegada" : "ninguna",
  };
}

export const ETIQUETA_ORIGEN: Record<OrigenFecha, string> = {
  metadata: "fecha del archivo",
  nombre: "fecha en el nombre",
  llegada: "hora en que se subió",
  ninguna: "sin fecha confiable",
};

/**
 * Clase sugerida para un archivo, cruzando su fecha estimada contra el horario.
 *
 * Solo se sugiere cuando la fecha es confiable: con `origen: "ninguna"` se
 * devuelve null a propósito, para que el selector quede vacío en vez de
 * proponer una clase basada en una hora que no sabemos si es la real.
 */
export function sugerirClase(
  estimada: FechaEstimada,
  horario: BloqueHorario[],
  bloqueEn: (h: BloqueHorario[], momento: Date) => BloqueHorario | null,
): string | null {
  if (estimada.origen === "ninguna") return null;
  return bloqueEn(horario, estimada.fecha)?.claseId ?? null;
}
