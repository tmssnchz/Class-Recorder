/** Helpers de rutas y nombres de archivo seguros para Windows. */

// Caracteres que Windows no admite en nombres de archivo/carpeta.
// Los espacios se conservan a propósito: "Derecho Constitucional" se lee mejor
// que "Derecho-Constitucional" al abrir la carpeta desde el Explorador.
const CARACTERES_PROHIBIDOS = new RegExp('[<>:"/\\\\|?*\\u0000-\\u001f]', "g");

// Nombres reservados por Windows que no pueden usarse como carpeta/archivo.
const RESERVADOS = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

/**
 * Convierte un nombre escrito por el usuario ("Derecho Constitucional II")
 * en algo que Windows acepte como carpeta.
 */
export function sanitizarNombre(nombre: string, maxLargo = 60): string {
  let limpio = nombre
    .replace(CARACTERES_PROHIBIDOS, "-")
    .replace(/\s+/g, " ")
    .trim()
    // Windows no tolera puntos ni espacios al final de un segmento de ruta.
    .replace(/[. ]+$/, "");

  if (limpio.length > maxLargo) limpio = limpio.slice(0, maxLargo).trim();
  if (!limpio || RESERVADOS.test(limpio)) limpio = `_${limpio || "sin-nombre"}`;
  return limpio;
}

/** Une segmentos con separador de Windows, sin duplicar barras. */
export function unir(...partes: string[]): string {
  return partes
    .filter(Boolean)
    .map((p, i) =>
      i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, ""),
    )
    .join("\\");
}

/** Nombre de archivo base: 2026-08-05_14-30_Clase_Unidad */
export function nombreBaseGrabacion(
  fecha: Date,
  clase: string,
  unidad: string,
): string {
  const p = (n: number) => n.toString().padStart(2, "0");
  const sello = `${fecha.getFullYear()}-${p(fecha.getMonth() + 1)}-${p(
    fecha.getDate(),
  )}_${p(fecha.getHours())}-${p(fecha.getMinutes())}`;
  return `${sello}_${sanitizarNombre(clase, 30)}_${sanitizarNombre(unidad, 30)}`;
}

export function nombreArchivo(ruta: string): string {
  const partes = ruta.split(/[\\/]/);
  return partes[partes.length - 1] ?? ruta;
}

export function carpetaDe(ruta: string): string {
  const i = Math.max(ruta.lastIndexOf("\\"), ruta.lastIndexOf("/"));
  return i > 0 ? ruta.slice(0, i) : ruta;
}

export function quitarExtension(nombre: string): string {
  const i = nombre.lastIndexOf(".");
  return i > 0 ? nombre.slice(0, i) : nombre;
}
