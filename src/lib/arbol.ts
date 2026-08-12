/**
 * Construcción del árbol clase › unidad › grabaciones de la Biblioteca.
 *
 * Vive fuera del componente porque es una transformación pura y es la parte
 * con reglas que se pueden romper sin que salte a la vista: qué ramas se
 * muestran vacías y cuáles se ocultan.
 */
// Extensión explícita: así el test corre con `node --experimental-strip-types`
// sin necesitar el resolver de Vite.
import { SIN_CLASE, type Clase, type Grabacion } from "../types.ts";

export interface RamaUnidad {
  claveUnidad: string;
  nombre: string;
  items: Grabacion[];
}

export interface RamaClase {
  claveClase: string;
  nombre: string;
  color: string;
  unidades: RamaUnidad[];
}

const COLOR_HUERFANA = "#8b93a1";

/**
 * Se siembra desde `clases`, no desde las grabaciones: una clase o unidad
 * recién creada tiene que verse aunque todavía no tenga nada grabado.
 *
 * Con `hayFiltros` en true se podan las ramas vacías: ahí el usuario busca
 * algo puntual y las clases sin resultados serían solo ruido.
 */
export function construirArbol(
  clases: Clase[],
  grabaciones: Grabacion[],
  hayFiltros: boolean,
): RamaClase[] {
  const grupos: RamaClase[] = clases.map((c) => ({
    claveClase: c.id,
    nombre: c.nombre,
    color: c.color,
    unidades: c.unidades.map((u) => ({
      claveUnidad: u.id,
      nombre: u.nombre,
      items: [],
    })),
  }));

  for (const g of grabaciones) {
    const claveClase = g.claseId ?? SIN_CLASE;
    let clase = grupos.find((x) => x.claveClase === claveClase);
    if (!clase) {
      // Grabación sin clase, o de una clase que ya no está en el índice: va a
      // un grupo propio para no perderla de vista.
      clase = {
        claveClase,
        nombre: g.claseNombre,
        color: clases.find((c) => c.id === g.claseId)?.color ?? COLOR_HUERFANA,
        unidades: [],
      };
      grupos.push(clase);
    }
    const claveUnidad = g.unidadId ?? g.unidadNombre;
    let unidad = clase.unidades.find((u) => u.claveUnidad === claveUnidad);
    if (!unidad) {
      unidad = { claveUnidad, nombre: g.unidadNombre, items: [] };
      clase.unidades.push(unidad);
    }
    unidad.items.push(g);
  }

  if (!hayFiltros) return grupos;
  return grupos
    .map((c) => ({ ...c, unidades: c.unidades.filter((u) => u.items.length > 0) }))
    .filter((c) => c.unidades.length > 0);
}
