/**
 * Búsqueda de texto dentro de todas las transcripciones y las notas de clase.
 *
 * Las transcripciones no se guardan en datos.json a propósito: una clase de
 * dos horas son unos 70 KB y con cien grabaciones el archivo de datos se
 * volvería pesado de leer en cada arranque. Se leen los .txt bajo demanda y se
 * cachean en memoria. La nota de clase en cambio ya vive en memoria (es un
 * campo más de la grabación), así que se busca directo, sin leer nada.
 */
import { exists, readTextFile } from "@tauri-apps/plugin-fs";

import type { Apunte, Grabacion } from "../types";

/** ruta del .txt → contenido ya leído. */
const cache = new Map<string, string>();

export interface Coincidencia {
  grabacionId: string;
  cantidad: number;
  fragmentos: string[];
}

/** Lo mismo, pero para un apunte digitalizado. */
export interface CoincidenciaApunte {
  apunteId: string;
  cantidad: number;
  fragmentos: string[];
}

async function textoDe(g: Grabacion): Promise<string> {
  const ruta = g.transcripcion?.archivo;
  if (!ruta) return "";
  const guardado = cache.get(ruta);
  if (guardado !== undefined) return guardado;
  try {
    const texto = (await exists(ruta)) ? await readTextFile(ruta) : "";
    cache.set(ruta, texto);
    return texto;
  } catch {
    cache.set(ruta, "");
    return "";
  }
}

/** Se llama al reescribir una transcripción para no servir la versión vieja. */
export function olvidarCache(ruta?: string): void {
  if (ruta) cache.delete(ruta);
  else cache.clear();
}

function fragmentoAlrededor(texto: string, indice: number, largo: number): string {
  const desde = Math.max(0, indice - 60);
  const hasta = Math.min(texto.length, indice + largo + 60);
  const trozo = texto.slice(desde, hasta).replace(/\s+/g, " ").trim();
  return `${desde > 0 ? "…" : ""}${trozo}${hasta < texto.length ? "…" : ""}`;
}

/** Cuenta apariciones de `q` en `texto` y junta hasta `maxFragmentos` recortes. */
function contarEnTexto(
  texto: string,
  q: string,
  maxFragmentos: number,
): { cantidad: number; fragmentos: string[] } {
  const minusculas = texto.toLowerCase();
  const fragmentos: string[] = [];
  let cantidad = 0;
  let desde = 0;

  for (;;) {
    const i = minusculas.indexOf(q, desde);
    if (i === -1) break;
    cantidad += 1;
    if (fragmentos.length < maxFragmentos) {
      fragmentos.push(fragmentoAlrededor(texto, i, q.length));
    }
    desde = i + q.length;
  }

  return { cantidad, fragmentos };
}

export async function buscarEnTranscripciones(
  grabaciones: Grabacion[],
  consulta: string,
): Promise<Map<string, Coincidencia>> {
  const q = consulta.trim().toLowerCase();
  const resultado = new Map<string, Coincidencia>();
  if (q.length < 3) return resultado;

  for (const g of grabaciones) {
    const texto = g.transcripcion ? await textoDe(g) : "";
    const enTranscripcion = texto ? contarEnTexto(texto, q, 3) : { cantidad: 0, fragmentos: [] };
    const enNota = g.notaClase ? contarEnTexto(g.notaClase, q, 2) : { cantidad: 0, fragmentos: [] };

    const cantidad = enTranscripcion.cantidad + enNota.cantidad;
    if (cantidad === 0) continue;

    // Los de la nota primero: son más cortos y dan contexto más rápido que un
    // recorte de transcripción.
    const fragmentos = [...enNota.fragmentos, ...enTranscripcion.fragmentos].slice(0, 3);
    resultado.set(g.id, { grabacionId: g.id, cantidad, fragmentos });
  }

  return resultado;
}

/**
 * Busca dentro del texto reconocido de los apuntes escaneados.
 *
 * Se lee el .txt que deja el reconocimiento, con el mismo caché que las
 * transcripciones: el texto no vive en datos.json por la misma razón, y así
 * corregir una página invalida solo su archivo.
 */
export async function buscarEnApuntes(
  apuntes: Apunte[],
  consulta: string,
): Promise<Map<string, CoincidenciaApunte>> {
  const q = consulta.trim().toLowerCase();
  const resultado = new Map<string, CoincidenciaApunte>();
  if (q.length < 3) return resultado;

  for (const a of apuntes) {
    if (!a.archivoTexto) continue;
    const guardado = cache.get(a.archivoTexto);
    let texto = guardado;
    if (texto === undefined) {
      try {
        texto = (await exists(a.archivoTexto)) ? await readTextFile(a.archivoTexto) : "";
      } catch {
        texto = "";
      }
      cache.set(a.archivoTexto, texto);
    }
    if (!texto) continue;

    const { cantidad, fragmentos } = contarEnTexto(texto, q, 3);
    if (cantidad === 0) continue;
    resultado.set(a.id, { apunteId: a.id, cantidad, fragmentos });
  }

  return resultado;
}
