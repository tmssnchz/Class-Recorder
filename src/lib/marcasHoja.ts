/**
 * Marcas rectangulares sobre una hoja de apunte: destacados y anotaciones.
 *
 * Todo lo de acá es puro y trabaja en fracciones de la hoja (0 a 1), nunca en
 * píxeles de pantalla. Es la decisión que hace que una marca siga en su lugar
 * con cualquier zoom y en cualquier monitor: la conversión a píxeles pasa una
 * sola vez, al dibujar, y no queda guardada en ninguna parte.
 */
// Extensión explícita: el test corre con `node --experimental-strip-types`,
// sin el resolver de Vite.
import type { MarcaHoja, PaginaApunte } from "../types.ts";

/** Un arrastre en píxeles sobre la imagen ya renderizada. */
export interface Arrastre {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Fracción mínima de lado para que un arrastre cuente como marca.
 *
 * Sin esto, cada click suelto sobre la hoja dejaría una marca invisible de un
 * píxel, y al rato la hoja estaría sembrada de basura imposible de agarrar
 * para borrarla.
 */
export const LADO_MINIMO = 0.01;

const acotar = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Convierte un arrastre en píxeles a un rectángulo en fracciones de la hoja.
 *
 * Acepta el arrastre en cualquier dirección —de abajo a la derecha hacia arriba
 * a la izquierda también— y recorta lo que se haya ido fuera de la hoja, que es
 * lo que pasa cuando uno suelta el mouse pasado el borde. Devuelve `null` si lo
 * dibujado es demasiado chico para ser algo.
 */
export function rectanguloNormalizado(
  arrastre: Arrastre,
  ancho: number,
  alto: number,
): { x: number; y: number; ancho: number; alto: number } | null {
  if (ancho <= 0 || alto <= 0) return null;

  const x = acotar(Math.min(arrastre.x0, arrastre.x1) / ancho);
  const y = acotar(Math.min(arrastre.y0, arrastre.y1) / alto);
  const x2 = acotar(Math.max(arrastre.x0, arrastre.x1) / ancho);
  const y2 = acotar(Math.max(arrastre.y0, arrastre.y1) / alto);

  const w = x2 - x;
  const h = y2 - y;
  if (w < LADO_MINIMO || h < LADO_MINIMO) return null;
  return { x, y, ancho: w, alto: h };
}

/** Devuelve las páginas con `marca` agregada a la que corresponde. */
export function agregarMarca(
  paginas: PaginaApunte[],
  paginaId: string,
  marca: MarcaHoja,
): PaginaApunte[] {
  return paginas.map((p) =>
    p.id === paginaId ? { ...p, marcas: [...(p.marcas ?? []), marca] } : p,
  );
}

/** Devuelve las páginas sin la marca indicada. */
export function quitarMarca(
  paginas: PaginaApunte[],
  paginaId: string,
  marcaId: string,
): PaginaApunte[] {
  return paginas.map((p) =>
    p.id === paginaId ? { ...p, marcas: (p.marcas ?? []).filter((m) => m.id !== marcaId) } : p,
  );
}

/** Cambia el texto de una marca. Vaciarlo la deja como simple destacado. */
export function editarNotaDeMarca(
  paginas: PaginaApunte[],
  paginaId: string,
  marcaId: string,
  nota: string,
): PaginaApunte[] {
  return paginas.map((p) =>
    p.id === paginaId
      ? { ...p, marcas: (p.marcas ?? []).map((m) => (m.id === marcaId ? { ...m, nota } : m)) }
      : p,
  );
}

/** Cuántas marcas tiene una página, para avisarlo en la miniatura. */
export const cuentaDeMarcas = (pagina: PaginaApunte) => (pagina.marcas ?? []).length;
