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
import { open } from "@tauri-apps/plugin-dialog";
import { exists, remove, stat } from "@tauri-apps/plugin-fs";

import { convertirAudio, duracionDe } from "./audio";
import {
  escribirMetaGrabacion,
  prepararDestino,
  raizDeClase,
  tamanoArchivo,
} from "./grabaciones";
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

/**
 * Lo mismo pero para las fotos de apuntes. Comparten carpeta con los audios y
 * se separan por extensión, así el usuario configura una sola carpeta
 * sincronizada y no hay forma de que una foto caiga en la cola de audios.
 */
export const escanearInboxFotos = (carpeta: string) =>
  invoke<ArchivoInbox[]>("escanear_inbox_fotos", { carpeta });

export const archivarImportado = (ruta: string, carpetaInbox: string) =>
  invoke<string>("archivar_importado", { ruta, carpetaInbox });

/**
 * true si `ruta` está dentro del Inbox de Drive.
 *
 * Lo que se elige a mano desde el disco no se archiva: mover el archivo de un
 * usuario a una subcarpeta que él no creó sería una sorpresa desagradable. Solo
 * se archiva lo que llegó por la carpeta sincronizada, que es donde archivar
 * sirve para no reprocesarlo.
 */
export function vieneDelInbox(ruta: string, carpetaInbox: string | null): boolean {
  if (!carpetaInbox) return false;
  const normal = (r: string) =>
    r.replace(/\//g, "\\").toLowerCase().replace(/\\+$/, "");
  return normal(ruta).startsWith(normal(carpetaInbox) + "\\");
}

export const EXTENSIONES_AUDIO_IMPORT = [
  "m4a", "mp3", "wav", "aac", "ogg", "opus", "3gp", "amr", "flac", "webm",
];

export const EXTENSIONES_FOTO_IMPORT = ["jpg", "jpeg", "png", "heic", "webp"];

/**
 * Abre el diálogo del sistema y devuelve lo elegido con la misma forma que
 * `escanearInbox`, para que el resto del flujo no tenga que saber de dónde
 * salió cada archivo.
 */
export async function elegirArchivos(
  tipo: "audio" | "foto",
): Promise<ArchivoInbox[]> {
  const esAudio = tipo === "audio";
  const elegidos = await open({
    multiple: true,
    filters: [
      {
        name: esAudio ? "Audio" : "Fotos",
        extensions: esAudio ? EXTENSIONES_AUDIO_IMPORT : EXTENSIONES_FOTO_IMPORT,
      },
    ],
  });
  if (!elegidos) return [];

  const rutas = Array.isArray(elegidos) ? elegidos : [elegidos];
  const archivos: ArchivoInbox[] = [];

  for (const ruta of rutas) {
    let bytes = 0;
    let llegadaMs = Date.now();
    try {
      const info = await stat(ruta);
      bytes = info.size;
      // La fecha de modificación es la mejor señal de cuándo se grabó o se
      // sacó la foto, igual que en el escaneo del Inbox.
      llegadaMs = info.mtime?.getTime() ?? llegadaMs;
    } catch {
      // Sin metadata igual se puede importar: el tamaño solo se usa para mostrar.
    }
    archivos.push({
      nombre: nombreDe(ruta),
      ruta,
      bytes,
      llegadaMs,
      // Un archivo del disco local nunca está a medio bajar.
      estable: true,
    });
  }
  return archivos;
}

function nombreDe(ruta: string): string {
  const partes = ruta.split(/[\\/]/);
  return partes[partes.length - 1] ?? ruta;
}

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
  /** Grabaciones ya indexadas: si la clase ya vive en otra raíz, se respeta. */
  grabacionesExistentes: Grabacion[],
  onProgreso?: (fraccion: number) => void,
): Promise<Grabacion> {
  if (!(await exists(rutaOrigen))) {
    throw new Error(`El archivo ya no está en ${rutaOrigen}`);
  }

  const claseNombre = destino.claseNombre || SIN_CLASE;
  const unidadNombre = destino.unidadNombre || SIN_UNIDAD;
  const raiz = raizDeClase(grabacionesExistentes, destino.claseId, config.carpetaRaiz);

  const d = await prepararDestino(raiz, claseNombre, unidadNombre, destino.fecha);

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
    notaClase: "",
  };

  await escribirMetaGrabacion(grabacion);
  return grabacion;
}
