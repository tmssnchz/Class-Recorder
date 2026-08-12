/**
 * Persistencia local. La "base de datos" son dos archivos JSON dentro de
 * %APPDATA%\com.tomas.classrecorder:
 *   - datos.json  : clases, unidades y el índice de grabaciones
 *   - config.json : preferencias del usuario
 *
 * Además, cada grabación deja su propio .json al lado del audio, para que la
 * carpeta de grabaciones sea autocontenida (ver lib/grabaciones.ts).
 */
import {
  copyFile,
  exists,
  mkdir,
  readTextFile,
  remove,
  rename,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { appDataDir } from "@tauri-apps/api/path";

import {
  BASE_DATOS_VACIA,
  CONFIG_POR_DEFECTO,
  VERSION_BD,
  type BaseDatos,
  type Config,
} from "../types";
import { unir } from "./paths";

let carpetaApp: string | null = null;

export async function carpetaDeDatos(): Promise<string> {
  if (!carpetaApp) {
    carpetaApp = await appDataDir();
    if (!(await exists(carpetaApp))) {
      await mkdir(carpetaApp, { recursive: true });
    }
  }
  return carpetaApp;
}

/**
 * Serializa las escrituras: dos mutaciones seguidas (por ejemplo tipear rápido
 * en un formulario) no deben pisarse entre sí ni corromper el JSON.
 */
let cola: Promise<unknown> = Promise.resolve();

export function enCola<T>(tarea: () => Promise<T>): Promise<T> {
  const siguiente = cola.then(tarea, tarea);
  cola = siguiente.catch(() => undefined);
  return siguiente;
}

/**
 * Escritura tolerante a cortes: primero .tmp, después se rota el archivo
 * anterior a .bak y recién ahí se publica el nuevo.
 */
async function escribirJsonSeguro(ruta: string, valor: unknown): Promise<void> {
  const tmp = `${ruta}.tmp`;
  const bak = `${ruta}.bak`;
  await writeTextFile(tmp, JSON.stringify(valor, null, 2));
  if (await exists(ruta)) {
    await copyFile(ruta, bak);
    await remove(ruta);
  }
  await rename(tmp, ruta);
}

async function leerJson<T>(ruta: string): Promise<T | null> {
  try {
    if (!(await exists(ruta))) return null;
    const texto = await readTextFile(ruta);
    return JSON.parse(texto) as T;
  } catch (e) {
    console.error(`No se pudo leer ${ruta}:`, e);
    return null;
  }
}

// ---------------------------------------------------------------- datos.json

async function rutaDatos(): Promise<string> {
  return unir(await carpetaDeDatos(), "datos.json");
}

export async function cargarDatos(): Promise<BaseDatos> {
  const ruta = await rutaDatos();
  let datos = await leerJson<Partial<BaseDatos>>(ruta);

  // Si datos.json quedó corrupto, intentamos con el respaldo antes de rendirnos.
  if (!datos) {
    datos = await leerJson<Partial<BaseDatos>>(`${ruta}.bak`);
    if (datos) console.warn("datos.json ilegible: se recuperó desde .bak");
  }
  if (!datos) return { ...BASE_DATOS_VACIA };

  return {
    version: datos.version ?? VERSION_BD,
    clases: (datos.clases ?? []).map((c) => ({
      ...c,
      unidades: c.unidades ?? [],
    })),
    grabaciones: (datos.grabaciones ?? []).map((g) => ({
      ...g,
      tags: g.tags ?? [],
      marcas: g.marcas ?? [],
      transcripcion: g.transcripcion ?? null,
    })),
    // Campo agregado después: un datos.json anterior no lo trae.
    materiales: datos.materiales ?? [],
  };
}

export async function guardarDatos(datos: BaseDatos): Promise<void> {
  await escribirJsonSeguro(await rutaDatos(), datos);
}

// --------------------------------------------------------------- config.json

async function rutaConfig(): Promise<string> {
  return unir(await carpetaDeDatos(), "config.json");
}

export async function cargarConfig(): Promise<Config> {
  const guardada = await leerJson<Partial<Config>>(await rutaConfig());
  if (!guardada) return { ...CONFIG_POR_DEFECTO };
  // Merge contra los valores por defecto: al agregar opciones nuevas en el
  // futuro, una config vieja sigue siendo válida.
  return {
    ...CONFIG_POR_DEFECTO,
    ...guardada,
    atajos: { ...CONFIG_POR_DEFECTO.atajos, ...(guardada.atajos ?? {}) },
  };
}

export async function guardarConfig(config: Config): Promise<void> {
  await escribirJsonSeguro(await rutaConfig(), config);
}
