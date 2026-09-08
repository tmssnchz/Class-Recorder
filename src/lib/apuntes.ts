/**
 * Consultas y operaciones de índice sobre los apuntes digitalizados.
 *
 * Se anclan a exactamente uno de los tres niveles (clase, unidad o grabación),
 * igual que un `Material`, así que al abrir una grabación se puede mostrar
 * también lo que cuelga de su unidad y de su clase sin duplicar nada.
 */
import { exists, remove } from "@tauri-apps/plugin-fs";

// Extensiones explícitas para que el test corra con
// `node --experimental-strip-types`, sin el resolver de Vite.
import type { Apunte, Grabacion, PaginaApunte } from "../types.ts";

export const apuntesDeClase = (apuntes: Apunte[], claseId: string) =>
  apuntes.filter((a) => a.claseId === claseId && a.unidadId === null && a.grabacionId === null);

export const apuntesDeUnidad = (apuntes: Apunte[], unidadId: string) =>
  apuntes.filter((a) => a.unidadId === unidadId && a.grabacionId === null);

export const apuntesDeGrabacion = (apuntes: Apunte[], grabacionId: string) =>
  apuntes.filter((a) => a.grabacionId === grabacionId);

/** Lo que corresponde mostrar al abrir una grabación, separado por nivel. */
export function apuntesVisiblesDe(apuntes: Apunte[], g: Grabacion) {
  return {
    propios: apuntesDeGrabacion(apuntes, g.id),
    unidad: g.unidadId ? apuntesDeUnidad(apuntes, g.unidadId) : [],
    clase: g.claseId ? apuntesDeClase(apuntes, g.claseId) : [],
  };
}

/**
 * Versiones anteriores de un apunte, de la más nueva a la más vieja.
 *
 * Al volver a escanear una hoja corregida no se pisa la anterior: el apunte
 * nuevo apunta al viejo con `reemplazaA`. Perder el escaneo original de un
 * apunte que después se corrigió mal sería irreversible.
 */
export function versionesAnteriores(apuntes: Apunte[], apunte: Apunte): Apunte[] {
  const cadena: Apunte[] = [];
  let actual = apunte.reemplazaA;
  const vistos = new Set<string>([apunte.id]);

  while (actual && !vistos.has(actual)) {
    vistos.add(actual);
    const previo = apuntes.find((a) => a.id === actual);
    if (!previo) break;
    cadena.push(previo);
    actual = previo.reemplazaA;
  }
  return cadena;
}

/** Los apuntes que no fueron reemplazados por otro más nuevo. */
export function vigentes(apuntes: Apunte[]): Apunte[] {
  const reemplazados = new Set(apuntes.map((a) => a.reemplazaA).filter(Boolean) as string[]);
  return apuntes.filter((a) => !reemplazados.has(a.id));
}

/**
 * Quita del índice los apuntes repetidos: los que comparten `carpeta`.
 *
 * Dos apuntes nunca comparten carpeta de forma legítima — `carpetaLibre` le
 * inventa un nombre nuevo (`_2`, `_3`) a cada escaneo —, así que un empate es
 * siempre el mismo apunte anotado dos veces. Pasaba cuando la ráfaga entregaba
 * la tanda más de una vez; se arregló en el origen, pero los índices que ya
 * quedaron duplicados hay que limpiarlos igual.
 *
 * Gana el registro con más páginas reconocidas: es el que se estuvo usando, y
 * borrar el otro no toca ningún archivo (los duplicados apuntan a los mismos).
 */
export function sinDuplicados(apuntes: Apunte[]): Apunte[] {
  const mejor = new Map<string, Apunte>();
  for (const a of apuntes) {
    const clave = a.carpeta.toLowerCase();
    const previo = mejor.get(clave);
    if (!previo || progresoReconocimiento(a).hechas > progresoReconocimiento(previo).hechas) {
      mejor.set(clave, a);
    }
  }
  return apuntes.filter((a) => mejor.get(a.carpeta.toLowerCase()) === a);
}

/** Cuántas páginas ya tienen texto reconocido. */
export function progresoReconocimiento(apunte: Apunte): { hechas: number; total: number } {
  return {
    hechas: apunte.paginas.filter((p) => p.motorHtr !== null).length,
    total: apunte.paginas.length,
  };
}

export const bytesDe = (apunte: Apunte) =>
  apunte.paginas.reduce((total, p) => total + p.bytes, 0);

/** Páginas que todavía no pasaron por el reconocimiento. */
export const paginasPendientes = (apunte: Apunte): PaginaApunte[] =>
  apunte.paginas.filter((p) => p.motorHtr === null);

/**
 * Borra del disco los archivos de un apunte. Silencioso con lo que ya no
 * está: si el usuario movió o borró una página a mano, no hay nada que hacer.
 */
export async function borrarArchivosApunte(apunte: Apunte): Promise<void> {
  for (const pagina of apunte.paginas) {
    if (await exists(pagina.archivo)) await remove(pagina.archivo);
    if (pagina.original && (await exists(pagina.original))) await remove(pagina.original);
  }
  if (apunte.archivoTexto && (await exists(apunte.archivoTexto))) {
    await remove(apunte.archivoTexto);
  }
}
