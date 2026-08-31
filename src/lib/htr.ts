/**
 * Reconocimiento de texto manuscrito sobre una página ya escaneada.
 *
 * Dos caminos, igual que en la transcripción de audio:
 *   - local: `llama-mtmd-cli.exe` con un modelo GGUF de OCR (ver htrModelos.ts)
 *   - api:   un endpoint compatible con `chat/completions` que acepte imágenes,
 *            usando los mismos perfiles y claves que ya existen para el audio
 *
 * El reconocimiento de manuscrita nunca es perfecto. Toda la interfaz que
 * consume esto muestra el texto como editable a propósito: la corrección a
 * mano es parte del flujo normal, no un caso de error.
 */
import { invoke } from "@tauri-apps/api/core";
import { exists, writeTextFile } from "@tauri-apps/plugin-fs";

import { MARCA_DIAGRAMA, textoDe } from "./escaneo";
import {
  buscarModeloHtr,
  rutaBinarioHtr,
  rutaMmprojHtr,
  rutaModeloHtr,
} from "./htrModelos";
import { unir } from "./paths";
import type { Apunte, Config, PaginaApunte, PerfilApi } from "../types";

export type EtapaHtr = "esperando" | "cargando" | "leyendo" | "listo" | "error";

/**
 * Prompt que se manda por API. El local usa el suyo, armado en Rust, para no
 * tener que pasar un texto largo por cada invocación; los dos dicen lo mismo.
 */
export function promptApi(idioma: string): string {
  const nombres: Record<string, string> = {
    es: "español",
    en: "inglés",
    pt: "portugués",
    fr: "francés",
    it: "italiano",
    de: "alemán",
    la: "latín",
  };
  const nombre = nombres[idioma] ?? "español";
  return (
    `Transcribe literalmente el texto manuscrito de esta hoja. ` +
    `El idioma principal es ${nombre}, pero respeta las palabras que estén en otro idioma ` +
    `tal como aparecen escritas. ` +
    `Devuelve únicamente el texto, conservando los saltos de línea, los títulos y las viñetas. ` +
    `Donde haya un diagrama, un esquema, un gráfico o un dibujo, escribe en su lugar una línea ` +
    `que diga ${MARCA_DIAGRAMA} y sigue con el texto. ` +
    `Si una palabra es ilegible, escríbela como [?]. ` +
    `No agregues comentarios, explicaciones ni texto que no esté escrito en la hoja.`
  );
}

/** Modelo de visión que se le pide a cada proveedor de API. */
export function modeloVisionDe(perfil: PerfilApi): string {
  switch (perfil.proveedor) {
    case "groq":
      return "meta-llama/llama-4-scout-17b-16e-instruct";
    case "openai":
      return "gpt-4o-mini";
    default:
      // En "personalizado" el usuario apunta a su propio endpoint; el nombre
      // del modelo lo pone él en la URL o en su gateway.
      return "gpt-4o-mini";
  }
}

/** URL de chat/completions a partir de la de audio que ya tiene el perfil. */
export function urlChatDe(perfil: PerfilApi): string {
  switch (perfil.proveedor) {
    case "groq":
      return "https://api.groq.com/openai/v1/chat/completions";
    case "openai":
      return "https://api.openai.com/v1/chat/completions";
    default:
      return perfil.urlPersonalizada
        .trim()
        .replace(/\/audio\/transcriptions\/?$/, "/chat/completions");
  }
}

export async function verificarInstalacionHtr(config: Config): Promise<void> {
  const modelo = buscarModeloHtr(config.apuntes.modelo);
  if (!(await exists(await rutaBinarioHtr()))) {
    throw new Error(
      "El motor de reconocimiento no está instalado. Instálalo desde Configuración › Apuntes.",
    );
  }
  if (!(await exists(await rutaModeloHtr(modelo)))) {
    throw new Error(
      `El modelo "${modelo.etiqueta}" no está descargado. Descárgalo desde Configuración › Apuntes.`,
    );
  }
}

/** Reconoce una página con el modelo local. */
export async function reconocerLocal(
  pagina: PaginaApunte,
  config: Config,
  tarea: string,
): Promise<string> {
  await verificarInstalacionHtr(config);
  const modelo = buscarModeloHtr(config.apuntes.modelo);
  const hilos = await invoke<number>("hilos_recomendados");

  return invoke<string>("reconocer_texto_local", {
    tarea,
    binario: await rutaBinarioHtr(),
    modelo: await rutaModeloHtr(modelo),
    mmproj: await rutaMmprojHtr(modelo),
    imagen: pagina.archivo,
    idioma: config.apuntes.idioma,
    hilos,
  });
}

/** Reconoce una página mandándola a la API del perfil indicado. */
export async function reconocerConApi(
  pagina: PaginaApunte,
  perfil: PerfilApi,
  idioma: string,
): Promise<string> {
  if (!perfil.claveCifrada) {
    throw new Error(`El perfil "${perfil.nombre}" no tiene una clave de API configurada.`);
  }
  return invoke<string>("reconocer_apunte_api", {
    url: urlChatDe(perfil),
    claveCifrada: perfil.claveCifrada,
    imagen: pagina.archivo,
    modelo: modeloVisionDe(perfil),
    prompt: promptApi(idioma),
  });
}

/**
 * Reescribe el .txt del apunte con el texto de todas sus páginas. Es lo que
 * indexa la búsqueda de la biblioteca, igual que el .txt de una transcripción.
 */
export async function guardarTexto(apunte: Apunte): Promise<string> {
  const ruta = apunte.archivoTexto || unir(apunte.carpeta, "texto.txt");
  await writeTextFile(ruta, textoDe(apunte));
  return ruta;
}
