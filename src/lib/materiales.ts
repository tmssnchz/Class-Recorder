/**
 * Material de estudio: apuntes, presentaciones, fotos del pizarrón.
 *
 * Los archivos se copian dentro de la carpeta de grabaciones, nunca se
 * referencian desde su ubicación original: así el proyecto entero se puede
 * mover de disco (o restaurar desde el respaldo .zip) sin dejar enlaces rotos.
 *
 * Estructura:
 *   carpeta_raiz/{clase}/materiales/              material de la clase
 *   carpeta_raiz/{clase}/{unidad}/materiales/     material de la unidad
 *   carpeta_raiz/{clase}/{unidad}/materiales/     material de una grabación
 *
 * El material de una grabación comparte carpeta con el de su unidad; se
 * distinguen por el nivel guardado en el índice, no por la ruta.
 */
import { copyFile, exists, mkdir, remove, stat } from "@tauri-apps/plugin-fs";

// Extensiones explícitas: así el test corre con `node --experimental-strip-types`
// sin necesitar el resolver de Vite.
import { nombreArchivo, sanitizarNombre, unir } from "./paths.ts";
import {
  EXTENSIONES_MATERIAL,
  type Grabacion,
  type Material,
} from "../types.ts";

/** Se avisa antes de duplicar algo más pesado que esto. */
export const AVISO_TAMANO_BYTES = 100 * 1024 * 1024;

export const FILTRO_DIALOGO = {
  name: "Material de estudio",
  extensions: [...EXTENSIONES_MATERIAL],
};

export type TipoMaterial = "pdf" | "imagen" | "texto" | "presentacion" | "documento";

export function tipoDe(nombre: string): TipoMaterial {
  const ext = nombre.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg"].includes(ext)) return "imagen";
  if (ext === "md") return "texto";
  if (["ppt", "pptx"].includes(ext)) return "presentacion";
  return "documento";
}

/**
 * Carpeta de materiales del nivel indicado. `unidadNombre` en null significa
 * material de la clase entera.
 */
export function carpetaMateriales(
  carpetaRaiz: string,
  claseNombre: string,
  unidadNombre: string | null,
): string {
  const base = unir(carpetaRaiz, sanitizarNombre(claseNombre));
  return unidadNombre === null
    ? unir(base, "materiales")
    : unir(base, sanitizarNombre(unidadNombre), "materiales");
}

/** Nombre libre dentro de `carpeta` (agrega _2, _3… si ya existe). */
async function nombreLibre(carpeta: string, deseado: string): Promise<string> {
  const punto = deseado.lastIndexOf(".");
  const base = punto > 0 ? deseado.slice(0, punto) : deseado;
  const ext = punto > 0 ? deseado.slice(punto) : "";

  let nombre = deseado;
  let intento = 2;
  while (await exists(unir(carpeta, nombre))) {
    nombre = `${base}_${intento++}${ext}`;
  }
  return nombre;
}

export interface DestinoMaterial {
  carpetaRaiz: string;
  claseNombre: string;
  /** null = material de la clase entera. */
  unidadNombre: string | null;
  claseId: string | null;
  unidadId: string | null;
  grabacionId: string | null;
}

/**
 * Copia un archivo externo a la carpeta que le corresponde y devuelve la
 * entrada de índice ya lista. No toca el archivo de origen.
 */
export async function agregarMaterialDesde(
  rutaOrigen: string,
  destino: DestinoMaterial,
): Promise<Material> {
  const carpeta = carpetaMateriales(
    destino.carpetaRaiz,
    destino.claseNombre,
    destino.unidadNombre,
  );
  if (!(await exists(carpeta))) await mkdir(carpeta, { recursive: true });

  const nombre = await nombreLibre(carpeta, nombreArchivo(rutaOrigen));
  const rutaDestino = unir(carpeta, nombre);
  await copyFile(rutaOrigen, rutaDestino);

  return {
    id: crypto.randomUUID(),
    nombre,
    archivo: rutaDestino,
    bytes: await tamano(rutaDestino),
    agregadoEn: new Date().toISOString(),
    claseId: destino.claseId,
    unidadId: destino.unidadId,
    grabacionId: destino.grabacionId,
  };
}

export async function tamano(ruta: string): Promise<number> {
  try {
    return (await stat(ruta)).size;
  } catch {
    return 0;
  }
}

/** Borra el archivo del disco. Silencioso si ya no está. */
export async function borrarArchivoMaterial(material: Material): Promise<void> {
  if (await exists(material.archivo)) await remove(material.archivo);
}

// ------------------------------------------------------------ consultas

export const materialesDeClase = (materiales: Material[], claseId: string) =>
  materiales.filter((m) => m.claseId === claseId);

export const materialesDeUnidad = (materiales: Material[], unidadId: string) =>
  materiales.filter((m) => m.unidadId === unidadId);

export const materialesDeGrabacion = (materiales: Material[], grabacionId: string) =>
  materiales.filter((m) => m.grabacionId === grabacionId);

/**
 * Todo lo que corresponde mostrar al abrir una grabación, separado por nivel:
 * lo suyo, lo de su unidad y lo de su clase. Así el programa de la materia
 * está a mano sin haberlo subido una vez por grabación.
 */
export function materialesVisiblesDe(materiales: Material[], g: Grabacion) {
  return {
    propios: materialesDeGrabacion(materiales, g.id),
    unidad: g.unidadId ? materialesDeUnidad(materiales, g.unidadId) : [],
    clase: g.claseId ? materialesDeClase(materiales, g.claseId) : [],
  };
}

/**
 * Mueve los materiales propios de una grabación a la carpeta de su nuevo
 * destino. Se llama desde `moverGrabacion`, para que el material viaje con el
 * audio igual que ya lo hacen el .txt y el .json.
 *
 * Devuelve los materiales con su ruta actualizada. Si alguno falla, se deja
 * el original en su lugar: perder la referencia sería peor que dejarlo donde
 * estaba.
 */
export async function moverMaterialesDeGrabacion(
  materiales: Material[],
  carpetaRaiz: string,
  claseNombre: string,
  unidadNombre: string,
): Promise<Material[]> {
  const carpeta = carpetaMateriales(carpetaRaiz, claseNombre, unidadNombre);
  const actualizados: Material[] = [];

  for (const m of materiales) {
    try {
      if (!(await exists(m.archivo))) {
        actualizados.push(m);
        continue;
      }
      if (!(await exists(carpeta))) await mkdir(carpeta, { recursive: true });

      const nombre = await nombreLibre(carpeta, m.nombre);
      const rutaDestino = unir(carpeta, nombre);
      if (rutaDestino === m.archivo) {
        actualizados.push(m);
        continue;
      }
      await copyFile(m.archivo, rutaDestino);
      await remove(m.archivo);
      actualizados.push({ ...m, nombre, archivo: rutaDestino });
    } catch (e) {
      console.error(`No se pudo mover el material ${m.nombre}`, e);
      actualizados.push(m);
    }
  }

  return actualizados;
}
