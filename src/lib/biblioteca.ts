/**
 * Operaciones de archivo sobre grabaciones ya guardadas.
 *
 * Cada grabación son hasta tres archivos que comparten nombre base dentro de la
 * misma carpeta: el audio, la transcripción `.txt` y la metadata `.json`.
 * Mover o renombrar tiene que arrastrarlos a los tres.
 */
import { exists, mkdir, remove, rename } from "@tauri-apps/plugin-fs";

import { escribirMetaGrabacion } from "./grabaciones";
import { sanitizarNombre, unir } from "./paths";
import type { Grabacion } from "../types";

/**
 * Sufijos que acompañan al audio y viajan con él.
 * "segmentos.json" va aparte de "json": son dos archivos distintos.
 */
const ACOMPANANTES = ["txt", "json", "segmentos.json"];

function rutasDe(g: Grabacion): { audio: string; extras: string[] } {
  return {
    audio: g.archivoAudio,
    extras: ACOMPANANTES.map((ext) => unir(g.carpeta, `${g.titulo}.${ext}`)),
  };
}

/** Busca un nombre base libre en `carpeta` (agrega _2, _3… si hace falta). */
async function tituloLibre(
  carpeta: string,
  deseado: string,
  formato: string,
): Promise<string> {
  let titulo = deseado;
  let intento = 2;
  while (await exists(unir(carpeta, `${titulo}.${formato}`))) {
    titulo = `${deseado}_${intento++}`;
  }
  return titulo;
}

async function moverArchivos(
  g: Grabacion,
  carpetaDestino: string,
  tituloDestino: string,
): Promise<Partial<Grabacion>> {
  const origen = rutasDe(g);
  const nuevoAudio = unir(carpetaDestino, `${tituloDestino}.${g.formato}`);

  await rename(origen.audio, nuevoAudio);

  for (const ext of ACOMPANANTES) {
    const desde = unir(g.carpeta, `${g.titulo}.${ext}`);
    if (await exists(desde)) {
      await rename(desde, unir(carpetaDestino, `${tituloDestino}.${ext}`));
    }
  }

  return {
    carpeta: carpetaDestino,
    titulo: tituloDestino,
    archivoAudio: nuevoAudio,
    transcripcion: g.transcripcion
      ? {
          ...g.transcripcion,
          archivo: unir(carpetaDestino, `${tituloDestino}.txt`),
          archivoSegmentos: unir(
            carpetaDestino,
            `${tituloDestino}.segmentos.json`,
          ),
        }
      : null,
  };
}

/**
 * Reasigna la grabación a otra clase/unidad y mueve los archivos a la carpeta
 * correspondiente, para que el Explorador siempre coincida con la biblioteca.
 */
export async function moverGrabacion(
  g: Grabacion,
  carpetaRaiz: string,
  destino: {
    claseId: string | null;
    unidadId: string | null;
    claseNombre: string;
    unidadNombre: string;
  },
): Promise<Partial<Grabacion>> {
  const carpetaDestino = unir(
    carpetaRaiz,
    sanitizarNombre(destino.claseNombre),
    sanitizarNombre(destino.unidadNombre),
  );

  const clasificacion = {
    claseId: destino.claseId,
    unidadId: destino.unidadId,
    claseNombre: destino.claseNombre,
    unidadNombre: destino.unidadNombre,
  };

  if (carpetaDestino === g.carpeta) return clasificacion;

  await mkdir(carpetaDestino, { recursive: true });
  const titulo = await tituloLibre(carpetaDestino, g.titulo, g.formato);
  const cambiosArchivo = await moverArchivos(g, carpetaDestino, titulo);

  const actualizada = { ...g, ...clasificacion, ...cambiosArchivo };
  await escribirMetaGrabacion(actualizada);
  return { ...clasificacion, ...cambiosArchivo };
}

/** Renombra los tres archivos dentro de la misma carpeta. */
export async function renombrarGrabacion(
  g: Grabacion,
  nuevoTitulo: string,
): Promise<Partial<Grabacion>> {
  const deseado = sanitizarNombre(nuevoTitulo, 90);
  if (!deseado) throw new Error("El nombre no puede quedar vacío.");
  if (deseado === g.titulo) return {};

  const titulo = await tituloLibre(g.carpeta, deseado, g.formato);
  const cambios = await moverArchivos(g, g.carpeta, titulo);

  const actualizada = { ...g, ...cambios };
  await escribirMetaGrabacion(actualizada);
  return cambios;
}

/** Borra el audio, la transcripción y la metadata del disco. */
export async function borrarArchivos(g: Grabacion): Promise<void> {
  const { audio, extras } = rutasDe(g);
  for (const ruta of [audio, ...extras]) {
    try {
      if (await exists(ruta)) await remove(ruta);
    } catch (e) {
      console.error(`No se pudo borrar ${ruta}`, e);
      throw new Error(
        `No se pudo borrar ${ruta}. Puede estar abierto en otro programa.`,
      );
    }
  }
}
