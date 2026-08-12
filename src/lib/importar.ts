/**
 * Importación de audios que no se grabaron con la app: los que vienen del
 * celular a través de la carpeta de Drive, o cualquier archivo suelto.
 *
 * Reusa la misma tubería que una grabación nativa (prepararDestino →
 * convertirAudio → escribirMetaGrabacion), así una grabación importada queda
 * indistinguible de una propia: misma estructura de carpetas, mismo formato,
 * misma metadata al lado del audio.
 */
import { invoke } from "@tauri-apps/api/core";
import { exists, remove } from "@tauri-apps/plugin-fs";

import { convertirAudio, duracionDe } from "./audio";
import { escribirMetaGrabacion, prepararDestino, tamanoArchivo } from "./grabaciones";
import { SIN_CLASE, SIN_UNIDAD, type Config, type Grabacion } from "../types";

export interface ArchivoInbox {
  nombre: string;
  ruta: string;
  bytes: number;
  /** Milisegundos epoch de llegada del archivo a la carpeta. */
  llegadaMs: number;
  /** false si Drive todavía lo estaba bajando durante el escaneo. */
  estable: boolean;
}

export interface InfoDrive {
  instalado: boolean;
  candidatas: string[];
}

export const URL_DESCARGA_DRIVE = "https://www.google.com/drive/download/";

export const detectarDrive = () => invoke<InfoDrive>("detectar_drive");

export const prepararInbox = (raizDrive: string) =>
  invoke<string>("preparar_inbox", { raizDrive });

export const escanearInbox = (carpeta: string) =>
  invoke<ArchivoInbox[]>("escanear_inbox", { carpeta });

export const archivarImportado = (ruta: string, carpetaInbox: string) =>
  invoke<string>("archivar_importado", { ruta, carpetaInbox });

export interface DestinoImportacion {
  claseId: string | null;
  unidadId: string | null;
  claseNombre: string;
  unidadNombre: string;
  /** Cuándo se grabó realmente. Se usa para el nombre y la fecha del índice. */
  fecha: Date;
}

/**
 * Copia el audio a la carpeta que le corresponde, lo convierte al formato
 * configurado y devuelve la entrada de índice lista para agregar.
 *
 * El archivo de origen no se toca: archivarlo (o no) es decisión de quien llama.
 */
export async function importarAudio(
  rutaOrigen: string,
  destino: DestinoImportacion,
  config: Config,
  onProgreso?: (fraccion: number) => void,
): Promise<Grabacion> {
  if (!(await exists(rutaOrigen))) {
    throw new Error(`El archivo ya no está en ${rutaOrigen}`);
  }

  const claseNombre = destino.claseNombre || SIN_CLASE;
  const unidadNombre = destino.unidadNombre || SIN_UNIDAD;

  const d = await prepararDestino(
    config.carpetaRaiz,
    claseNombre,
    unidadNombre,
    destino.fecha,
  );

  const duracionSeg = await duracionDe(rutaOrigen);
  const salida = `${d.carpeta}\\${d.base}.${config.formatoAudio}`;

  await convertirAudio(rutaOrigen, salida, config.formatoAudio, {
    duracionSeg,
    onProgreso,
  });

  const bytes = await tamanoArchivo(salida);
  if (bytes === 0) {
    // La conversión no dejó nada utilizable: mejor fallar que indexar un
    // archivo vacío que después no se puede reproducir ni transcribir.
    if (await exists(salida)) await remove(salida);
    throw new Error(`No se pudo convertir ${rutaOrigen}: el resultado quedó vacío.`);
  }

  const grabacion: Grabacion = {
    id: crypto.randomUUID(),
    claseId: destino.claseId,
    unidadId: destino.unidadId,
    claseNombre,
    unidadNombre,
    titulo: d.base,
    archivoAudio: salida,
    carpeta: d.carpeta,
    fechaISO: destino.fecha.toISOString(),
    duracionSeg,
    formato: config.formatoAudio,
    bytes,
    estado: "listo",
    errorConversion: null,
    tags: ["importada"],
    marcas: [],
    transcripcion: null,
  };

  await escribirMetaGrabacion(grabacion);
  return grabacion;
}
