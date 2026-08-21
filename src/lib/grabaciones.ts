/**
 * Rutas, archivos y recuperación de grabaciones.
 *
 * Estructura en disco:
 *   /grabaciones/{clase}/{unidad}/{fecha}_{hora}_{clase}_{unidad}.mp3
 *   /grabaciones/{clase}/{unidad}/{fecha}_{hora}_{clase}_{unidad}.txt   (transcripción)
 *   /grabaciones/{clase}/{unidad}/{fecha}_{hora}_{clase}_{unidad}.json  (metadata)
 *
 * Mientras se graba existen además dos archivos temporales que desaparecen al
 * detener: `.webm.part` (audio en curso) y `.parcial.json` (para recuperarlo si
 * la app se cierra de golpe).
 */
import { invoke } from "@tauri-apps/api/core";
import {
  exists,
  mkdir,
  readDir,
  readTextFile,
  remove,
  rename,
  stat,
  writeTextFile,
} from "@tauri-apps/plugin-fs";

import {
  carpetaDe,
  nombreBaseGrabacion,
  quitarExtension,
  sanitizarNombre,
  unir,
} from "./paths";
import { COLORES_CLASE, type BaseDatos, type Grabacion, type Marca } from "../types";

export const SUFIJO_PARCIAL = ".webm.part";
export const SUFIJO_META_PARCIAL = ".parcial.json";

export interface EspacioDisco {
  unidad: string;
  totalBytes: number;
  libreBytes: number;
}

export function consultarEspacio(ruta: string): Promise<EspacioDisco> {
  return invoke<EspacioDisco>("espacio_disco", { ruta });
}

/**
 * Raíz donde ya viven las grabaciones de una clase, si tiene alguna. Evita que
 * una clase quede repartida entre dos carpetas al cambiar la ubicación de
 * almacenamiento y elegir dejar las grabaciones existentes donde están: solo
 * las clases nuevas (sin grabaciones todavía) usan la raíz actual de la config.
 *
 * ponytail: no mira `datos.materiales`, así que una clase sin grabaciones pero
 * con material ya guardado no se detecta — agregar esa señal si aparece el caso.
 */
export function raizDeClase(
  grabaciones: Grabacion[],
  claseId: string | null,
  carpetaRaizActual: string,
): string {
  if (!claseId) return carpetaRaizActual;
  const existente = grabaciones.find((g) => g.claseId === claseId);
  if (!existente) return carpetaRaizActual;
  // carpeta = raiz/clase/unidad → subir dos niveles llega a la raíz.
  return carpetaDe(carpetaDe(existente.carpeta));
}

export interface Destino {
  carpeta: string;
  base: string; // nombre de archivo sin extensión
  rutaParcial: string;
  rutaMetaParcial: string;
  rutaWebm: string;
}

/**
 * Crea la carpeta de destino y reserva un nombre de archivo libre.
 * Si ya existe uno con el mismo minuto (dos grabaciones seguidas), agrega _2, _3…
 */
export async function prepararDestino(
  carpetaRaiz: string,
  claseNombre: string,
  unidadNombre: string,
  fecha: Date,
): Promise<Destino> {
  const carpeta = unir(
    carpetaRaiz,
    sanitizarNombre(claseNombre),
    sanitizarNombre(unidadNombre),
  );
  await mkdir(carpeta, { recursive: true });

  const baseInicial = nombreBaseGrabacion(fecha, claseNombre, unidadNombre);
  let base = baseInicial;
  let intento = 2;
  while (
    (await exists(unir(carpeta, `${base}.webm`))) ||
    (await exists(unir(carpeta, `${base}${SUFIJO_PARCIAL}`))) ||
    (await exists(unir(carpeta, `${base}.mp3`))) ||
    (await exists(unir(carpeta, `${base}.wav`)))
  ) {
    base = `${baseInicial}_${intento++}`;
  }

  return {
    carpeta,
    base,
    rutaParcial: unir(carpeta, `${base}${SUFIJO_PARCIAL}`),
    rutaMetaParcial: unir(carpeta, `${base}${SUFIJO_META_PARCIAL}`),
    rutaWebm: unir(carpeta, `${base}.webm`),
  };
}

/**
 * Mueve los archivos temporales de una grabación en curso a la carpeta de otra
 * clase/unidad. Se usa cuando el usuario reasigna la clase o la unidad sin
 * haber detenido la grabación. El rename es una operación de metadata dentro
 * del mismo volumen (no copia bytes), así que es seguro aunque el archivo
 * parcial ya pese varios cientos de MB.
 */
export async function moverDestino(
  actual: Destino,
  carpetaRaiz: string,
  fecha: Date,
  claseNombre: string,
  unidadNombre: string,
): Promise<Destino> {
  const carpeta = unir(
    carpetaRaiz,
    sanitizarNombre(claseNombre),
    sanitizarNombre(unidadNombre),
  );
  await mkdir(carpeta, { recursive: true });

  const baseInicial = nombreBaseGrabacion(fecha, claseNombre, unidadNombre);
  let base = baseInicial;
  let intento = 2;
  const ocupado = async (b: string) =>
    (carpeta !== actual.carpeta || b !== actual.base) &&
    ((await exists(unir(carpeta, `${b}.webm`))) ||
      (await exists(unir(carpeta, `${b}${SUFIJO_PARCIAL}`))) ||
      (await exists(unir(carpeta, `${b}${SUFIJO_META_PARCIAL}`))) ||
      (await exists(unir(carpeta, `${b}.mp3`))) ||
      (await exists(unir(carpeta, `${b}.wav`))));
  while (await ocupado(base)) {
    base = `${baseInicial}_${intento++}`;
  }

  const nuevo: Destino = {
    carpeta,
    base,
    rutaParcial: unir(carpeta, `${base}${SUFIJO_PARCIAL}`),
    rutaMetaParcial: unir(carpeta, `${base}${SUFIJO_META_PARCIAL}`),
    rutaWebm: unir(carpeta, `${base}.webm`),
  };

  // El audio va primero y es el único paso que puede abortar el movimiento: si
  // falla, no se movió nada y el llamador sigue escribiendo donde estaba.
  if (nuevo.rutaParcial !== actual.rutaParcial && (await exists(actual.rutaParcial))) {
    await rename(actual.rutaParcial, nuevo.rutaParcial);
  }

  // A partir de acá el audio YA está en su ruta nueva, así que ningún fallo
  // puede impedir que se devuelva `nuevo`: si lo hiciera, el llamador seguiría
  // apendeando los chunks siguientes en la ruta vieja y el audio de la clase
  // terminaría partido en dos archivos.
  try {
    if (
      nuevo.rutaMetaParcial !== actual.rutaMetaParcial &&
      (await exists(actual.rutaMetaParcial))
    ) {
      await rename(actual.rutaMetaParcial, nuevo.rutaMetaParcial);
    }
  } catch (e) {
    // La metadata parcial se reescribe entera en el próximo autoguardado; lo
    // único que importa es no dejar el archivo viejo suelto en la carpeta.
    console.warn("No se pudo mover la metadata parcial", e);
    try {
      if (await exists(actual.rutaMetaParcial)) await remove(actual.rutaMetaParcial);
    } catch {
      // Se ignora: es un archivo temporal sin valor propio.
    }
  }

  // La carpeta de la clase/unidad anterior puede haber quedado vacía.
  if (carpeta !== actual.carpeta) {
    await eliminarSiVacia(actual.carpeta, carpetaRaiz);
  }

  return nuevo;
}

async function eliminarSiVacia(carpeta: string, tope: string): Promise<void> {
  if (!carpeta || carpeta === tope) return;
  try {
    const entradas = await readDir(carpeta);
    if (entradas.length > 0) return;
    await remove(carpeta);
    await eliminarSiVacia(carpetaDe(carpeta), tope);
  } catch {
    // No es crítico: si no se puede borrar, la carpeta vacía queda y ya.
  }
}

/** Metadata que se va escribiendo durante la grabación, por si la app se cierra. */
export interface MetaParcial {
  id: string;
  claseId: string | null;
  unidadId: string | null;
  claseNombre: string;
  unidadNombre: string;
  fechaISO: string;
  duracionSeg: number;
  marcas: Marca[];
  formatoDestino: string;
}

export async function escribirMetaParcial(
  ruta: string,
  meta: MetaParcial,
): Promise<void> {
  await writeTextFile(ruta, JSON.stringify(meta, null, 2));
}

/** Metadata definitiva, al lado del audio: hace la carpeta autocontenida. */
export async function escribirMetaGrabacion(
  grabacion: Grabacion,
): Promise<void> {
  const ruta = unir(
    grabacion.carpeta,
    `${quitarExtension(nombreDeArchivo(grabacion.archivoAudio))}.json`,
  );
  await writeTextFile(ruta, JSON.stringify(grabacion, null, 2));
}

function nombreDeArchivo(ruta: string): string {
  const partes = ruta.split(/[\\/]/);
  return partes[partes.length - 1] ?? ruta;
}

export async function tamanoArchivo(ruta: string): Promise<number> {
  try {
    const info = await stat(ruta);
    return info.size;
  } catch {
    return 0;
  }
}

// ------------------------------------------------------- grabaciones caídas

export interface GrabacionInterrumpida {
  rutaParcial: string;
  rutaMetaParcial: string;
  carpeta: string;
  base: string;
  bytes: number;
  meta: MetaParcial | null;
}

/**
 * Busca archivos `.webm.part` huérfanos: son grabaciones que quedaron a medias
 * porque la app se cerró o crasheó mientras grababa. El audio sigue siendo
 * válido (Opus en WebM tolera el corte).
 */
export async function buscarInterrumpidas(
  carpetaRaiz: string,
): Promise<GrabacionInterrumpida[]> {
  if (!(await exists(carpetaRaiz))) return [];

  const encontradas: GrabacionInterrumpida[] = [];

  const recorrer = async (dir: string, profundidad: number): Promise<void> => {
    // La estructura es raíz/clase/unidad: más de 4 niveles es basura ajena.
    if (profundidad > 4) return;
    let entradas;
    try {
      entradas = await readDir(dir);
    } catch {
      return;
    }
    for (const entrada of entradas) {
      const ruta = unir(dir, entrada.name);
      if (entrada.isDirectory) {
        await recorrer(ruta, profundidad + 1);
      } else if (entrada.name.endsWith(SUFIJO_PARCIAL)) {
        const base = entrada.name.slice(0, -SUFIJO_PARCIAL.length);
        const rutaMetaParcial = unir(dir, `${base}${SUFIJO_META_PARCIAL}`);
        let meta: MetaParcial | null = null;
        try {
          if (await exists(rutaMetaParcial)) {
            meta = JSON.parse(await readTextFile(rutaMetaParcial)) as MetaParcial;
          }
        } catch {
          meta = null;
        }
        encontradas.push({
          rutaParcial: ruta,
          rutaMetaParcial,
          carpeta: dir,
          base,
          bytes: await tamanoArchivo(ruta),
          meta,
        });
      }
    }
  };

  await recorrer(carpetaRaiz, 0);
  return encontradas;
}

export async function descartarInterrumpida(
  interrumpida: GrabacionInterrumpida,
): Promise<void> {
  for (const ruta of [interrumpida.rutaParcial, interrumpida.rutaMetaParcial]) {
    try {
      if (await exists(ruta)) await remove(ruta);
    } catch (e) {
      console.error(`No se pudo borrar ${ruta}`, e);
    }
  }
}

// -------------------------------------------------------- reconciliación

/**
 * Cada grabación deja un .json al lado del audio (ver `escribirMetaGrabacion`):
 * la carpeta es autocontenida y no depende de `datos.json` para saber qué hay.
 * Al arrancar, comparamos ese registro en disco contra el índice y sumamos lo
 * que falte (clase, unidad y grabación) — así, si `datos.json` alguna vez no
 * llega a guardarse (la app se cierra de golpe, dos instancias pisándose,
 * etc.), la próxima vez que se abre la app la biblioteca se repara sola en
 * vez de perder la grabación para siempre.
 */
export async function reconciliarConDisco(
  datos: BaseDatos,
  carpetaRaiz: string,
): Promise<BaseDatos> {
  if (!(await exists(carpetaRaiz))) return datos;

  const idsConocidos = new Set(datos.grabaciones.map((g) => g.id));
  const encontradas: Grabacion[] = [];

  const recorrer = async (dir: string, profundidad: number): Promise<void> => {
    if (profundidad > 4) return;
    let entradas;
    try {
      entradas = await readDir(dir);
    } catch {
      return;
    }
    for (const entrada of entradas) {
      const ruta = unir(dir, entrada.name);
      if (entrada.isDirectory) {
        await recorrer(ruta, profundidad + 1);
        continue;
      }
      // Los .json de grabación son "{titulo}.json"; hay que excluir los otros
      // dos tipos de .json que puede haber al lado: parciales y segmentos.
      if (
        !entrada.name.endsWith(".json") ||
        entrada.name.endsWith(SUFIJO_META_PARCIAL) ||
        entrada.name.endsWith(".segmentos.json")
      ) {
        continue;
      }
      try {
        const contenido = JSON.parse(await readTextFile(ruta)) as Partial<Grabacion>;
        if (
          contenido.id &&
          contenido.archivoAudio &&
          !idsConocidos.has(contenido.id) &&
          (await exists(contenido.archivoAudio))
        ) {
          encontradas.push({ ...contenido, notaClase: contenido.notaClase ?? "" } as Grabacion);
          idsConocidos.add(contenido.id);
        }
      } catch {
        // No era un .json de grabación válido (o estaba corrupto): se ignora.
      }
    }
  };

  await recorrer(carpetaRaiz, 0);
  if (encontradas.length === 0) return datos;

  let clases = datos.clases;
  for (const g of encontradas) {
    if (!g.claseId) continue;
    const idxClase = clases.findIndex((c) => c.id === g.claseId);
    if (idxClase === -1) {
      clases = [
        ...clases,
        {
          id: g.claseId,
          nombre: g.claseNombre,
          color: COLORES_CLASE[clases.length % COLORES_CLASE.length],
          creadaEn: g.fechaISO,
          unidades: g.unidadId
            ? [{ id: g.unidadId, nombre: g.unidadNombre, creadaEn: g.fechaISO }]
            : [],
        },
      ];
    } else if (
      g.unidadId &&
      !clases[idxClase].unidades.some((u) => u.id === g.unidadId)
    ) {
      clases = clases.map((c, i) =>
        i === idxClase
          ? {
              ...c,
              unidades: [
                ...c.unidades,
                { id: g.unidadId!, nombre: g.unidadNombre, creadaEn: g.fechaISO },
              ],
            }
          : c,
      );
    }
  }

  return {
    ...datos,
    clases,
    grabaciones: [...encontradas, ...datos.grabaciones],
  };
}
