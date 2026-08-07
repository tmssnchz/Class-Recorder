/** Utilidades de formateo para la UI (todo en español, hora local). */

export function formatearDuracion(segundos: number): string {
  if (!Number.isFinite(segundos) || segundos < 0) return "--:--";
  const s = Math.floor(segundos % 60);
  const m = Math.floor((segundos / 60) % 60);
  const h = Math.floor(segundos / 3600);
  const dosDigitos = (n: number) => n.toString().padStart(2, "0");
  return h > 0
    ? `${h}:${dosDigitos(m)}:${dosDigitos(s)}`
    : `${dosDigitos(m)}:${dosDigitos(s)}`;
}

/**
 * Inverso de `formatearDuracion`: "mm:ss" o "h:mm:ss" a segundos.
 * null si el texto no tiene ese formato.
 */
export function parsearDuracion(texto: string): number | null {
  const partes = texto.trim().split(":");
  if (partes.length < 2 || partes.length > 3) return null;
  const numeros = partes.map(Number);
  if (numeros.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const [a, b, c] = numeros;
  return partes.length === 2 ? a * 60 + b : a * 3600 + b * 60 + c;
}

export function formatearFecha(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function formatearHora(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
}

export function formatearFechaLarga(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("es-ES", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function formatearBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const unidades = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    unidades.length - 1,
  );
  const valor = bytes / Math.pow(1024, i);
  return `${valor.toFixed(valor >= 10 || i === 0 ? 0 : 1)} ${unidades[i]}`;
}

/** "hoy", "ayer" o la fecha corta. Para encabezados de la biblioteca. */
export function fechaRelativa(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const hoy = new Date();
  const soloDia = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dias = Math.round((soloDia(hoy) - soloDia(d)) / 86_400_000);
  if (dias === 0) return "Hoy";
  if (dias === 1) return "Ayer";
  return formatearFecha(iso);
}
