/** Detección de OneDrive y creación de carpeta para la ubicación de grabaciones. */

import { invoke } from "@tauri-apps/api/core";

export const URL_DESCARGA_ONEDRIVE =
  "https://www.microsoft.com/microsoft-365/onedrive/download";

/** Nombre fijo de la carpeta que la app crea dentro de la raíz de OneDrive/Drive. */
export const NOMBRE_CARPETA_ALMACEN = "ClassRecorder";

export interface CuentaOneDrive {
  nombre: string;
  carpeta: string;
}

export interface InfoOneDrive {
  instalado: boolean;
  cuentas: CuentaOneDrive[];
}

export function detectarOneDrive(): Promise<InfoOneDrive> {
  return invoke("detectar_onedrive");
}

/** Crea (o reutiliza) `nombre` dentro de `raiz` y devuelve la ruta completa. */
export function crearCarpetaEnRaiz(raiz: string, nombre: string): Promise<string> {
  return invoke("crear_carpeta_en_raiz", { raiz, nombre });
}

/**
 * true si el audio está en modo ahorro de espacio (placeholder de OneDrive):
 * figura en el índice pero el contenido todavía no bajó a disco.
 */
export function esPlaceholder(ruta: string): Promise<boolean> {
  return invoke("es_placeholder", { ruta });
}

/** Fuerza la descarga completa de un placeholder. El progreso llega por el evento `hidratacion://progreso`. */
export function hidratarArchivo(ruta: string, tarea: string): Promise<void> {
  return invoke("hidratar_archivo", { ruta, tarea });
}

/**
 * Copia toda la carpeta `origen` dentro de `destino` y recién borra el origen
 * si la copia completa terminó bien. Progreso por el evento
 * `migracion://progreso`. Devuelve cuántos archivos se movieron.
 */
export function moverCarpetaGrabaciones(
  origen: string,
  destino: string,
  tarea: string,
): Promise<number> {
  return invoke("mover_carpeta_grabaciones", { origen, destino, tarea });
}
