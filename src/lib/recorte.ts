/**
 * Recorte de grabaciones por rango horario.
 *
 * Dos modos:
 *  - "desde": conserva [0, hastaSeg] y descarta el resto. Para cuando te
 *    olvidaste de detener la grabación al terminar la clase.
 *  - "intervalo": quita [desdeSeg, hastaSeg) y pega lo de antes con lo de
 *    después. Para un recreo grabado a mitad de clase.
 *
 * Nunca recodifica (ffmpeg -c copy): es rápido y no pierde calidad de audio.
 * El resultado puede reemplazar el archivo original o guardarse como una
 * grabación nueva aparte — lo decide quien llama, grabación por grabación.
 */
import { exists, mkdir, remove, rename } from "@tauri-apps/plugin-fs";

import { carpetaDeDatos } from "./almacen";
import { concatenarArchivos, recortarSegmento } from "./audio";
import { tituloLibre } from "./biblioteca";
import { escribirMetaGrabacion, tamanoArchivo } from "./grabaciones";
import { unir } from "./paths";
import type { Grabacion, Marca } from "../types";

export type ModoRecorte = "desde" | "intervalo";
export type EtapaRecorte = "recortando" | "uniendo" | "guardando";

async function carpetaTemporal(): Promise<string> {
  const carpeta = unir(await carpetaDeDatos(), "temp");
  if (!(await exists(carpeta))) await mkdir(carpeta, { recursive: true });
  return carpeta;
}

/**
 * Convierte una hora de reloj ("HH:mm" o "HH:mm:ss") en segundos desde el
 * inicio de la grabación, usando su fecha/hora real de arranque. Devuelve
 * null si el texto no tiene ese formato — puede dar un número negativo o
 * mayor a la duración, eso lo valida quien llama.
 */
export function offsetDesdeHora(
  fechaInicioISO: string,
  horaReloj: string,
): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(horaReloj.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = m[3] ? Number(m[3]) : 0;
  if (h > 23 || min > 59 || s > 59) return null;

  const inicio = new Date(fechaInicioISO);
  const objetivo = new Date(
    inicio.getFullYear(),
    inicio.getMonth(),
    inicio.getDate(),
    h,
    min,
    s,
  );
  return (objetivo.getTime() - inicio.getTime()) / 1000;
}

/** La hora de reloj (HH:mm:ss) correspondiente a un segundo de la grabación. */
export function horaDesdeOffset(fechaInicioISO: string, offsetSeg: number): string {
  const inicio = new Date(fechaInicioISO);
  const objetivo = new Date(inicio.getTime() + offsetSeg * 1000);
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${p(objetivo.getHours())}:${p(objetivo.getMinutes())}:${p(objetivo.getSeconds())}`;
}

function ajustarMarcas(
  marcas: Marca[],
  modo: ModoRecorte,
  desdeSeg: number,
  hastaSeg: number,
): Marca[] {
  if (modo === "desde") {
    return marcas.filter((m) => m.segundo <= hastaSeg);
  }
  const quitado = hastaSeg - desdeSeg;
  return marcas
    .filter((m) => m.segundo < desdeSeg || m.segundo >= hastaSeg)
    .map((m) => (m.segundo >= hastaSeg ? { ...m, segundo: m.segundo - quitado } : m));
}

export interface OpcionesRecorte {
  modo: ModoRecorte;
  /** Solo se usa en modo "intervalo": el otro extremo es siempre 0 en "desde". */
  desdeSeg: number;
  hastaSeg: number;
  /** true = pisa el archivo original. false = crea una grabación nueva aparte. */
  reemplazar: boolean;
  onEtapa?: (etapa: EtapaRecorte) => void;
  onProgreso?: (fraccion: number) => void;
}

export async function recortarGrabacion(
  grabacion: Grabacion,
  opciones: OpcionesRecorte,
): Promise<Grabacion> {
  const { modo, reemplazar, onEtapa, onProgreso } = opciones;
  const desdeSeg = modo === "intervalo" ? opciones.desdeSeg : 0;
  const hastaSeg = opciones.hastaSeg;

  if (modo === "desde") {
    if (hastaSeg <= 0 || hastaSeg >= grabacion.duracionSeg) {
      throw new Error(
        "El punto de corte tiene que estar dentro de la duración de la grabación.",
      );
    }
  } else {
    if (desdeSeg < 0 || hastaSeg > grabacion.duracionSeg || desdeSeg >= hastaSeg) {
      throw new Error("El intervalo a quitar no es válido.");
    }
    if (grabacion.duracionSeg - (hastaSeg - desdeSeg) <= 0) {
      throw new Error("No puede quedar audio vacío después de quitar el intervalo.");
    }
  }

  const ext = grabacion.formato;
  const temp = await carpetaTemporal();
  const sello = Date.now();
  const salidaFinal = unir(temp, `recorte_${grabacion.id}_${sello}.${ext}`);

  const duracionNueva =
    modo === "desde" ? hastaSeg : grabacion.duracionSeg - (hastaSeg - desdeSeg);

  let rutaResultado: string | null = null;
  let seg1: string | null = null;
  let seg2: string | null = null;

  try {
    onEtapa?.("recortando");

    if (modo === "desde") {
      await recortarSegmento(grabacion.archivoAudio, salidaFinal, 0, hastaSeg, {
        duracionSeg: duracionNueva,
        onProgreso,
      });
      rutaResultado = salidaFinal;
    } else {
      // Cada mitad solo se recorta si de verdad queda algo de ella: si se
      // quita desde el principio, no hay "primera mitad" que extraer.
      seg1 = desdeSeg > 0 ? unir(temp, `parte1_${grabacion.id}_${sello}.${ext}`) : null;
      seg2 =
        hastaSeg < grabacion.duracionSeg
          ? unir(temp, `parte2_${grabacion.id}_${sello}.${ext}`)
          : null;

      if (seg1) {
        await recortarSegmento(grabacion.archivoAudio, seg1, 0, desdeSeg, { onProgreso });
      }
      if (seg2) {
        await recortarSegmento(
          grabacion.archivoAudio,
          seg2,
          hastaSeg,
          grabacion.duracionSeg,
          { onProgreso },
        );
      }

      const partes = [seg1, seg2].filter((p): p is string => p !== null);
      if (partes.length === 0) {
        throw new Error("No puede quedar audio vacío después de quitar el intervalo.");
      }

      if (partes.length === 1) {
        // Solo quedó una mitad: no hace falta unir nada.
        rutaResultado = partes[0];
      } else {
        onEtapa?.("uniendo");
        await concatenarArchivos(partes, salidaFinal, temp, { onProgreso });
        rutaResultado = salidaFinal;
      }
    }

    onEtapa?.("guardando");

    const marcasNuevas = ajustarMarcas(grabacion.marcas, modo, desdeSeg, hastaSeg);

    if (reemplazar) {
      // Se recorta a un archivo aparte y recién se pisa el original al final:
      // si algo de lo anterior falla, la grabación original sigue intacta.
      if (await exists(grabacion.archivoAudio)) await remove(grabacion.archivoAudio);
      await rename(rutaResultado, grabacion.archivoAudio);
      rutaResultado = null; // ya no es un temporal a limpiar: es el archivo final

      // La transcripción vieja quedó con tiempos que ya no corresponden.
      if (grabacion.transcripcion) {
        for (const ruta of [
          grabacion.transcripcion.archivo,
          grabacion.transcripcion.archivoSegmentos,
        ]) {
          if (await exists(ruta)) await remove(ruta);
        }
      }

      const actualizada: Grabacion = {
        ...grabacion,
        duracionSeg: duracionNueva,
        bytes: await tamanoArchivo(grabacion.archivoAudio),
        marcas: marcasNuevas,
        transcripcion: null,
      };
      await escribirMetaGrabacion(actualizada);
      return actualizada;
    }

    // Copia nueva: título libre en la misma carpeta, el original no se toca.
    const tituloNuevo = await tituloLibre(
      grabacion.carpeta,
      `${grabacion.titulo}_recortado`,
      ext,
    );
    const archivoNuevo = unir(grabacion.carpeta, `${tituloNuevo}.${ext}`);
    await rename(rutaResultado, archivoNuevo);
    rutaResultado = null;

    const copia: Grabacion = {
      ...grabacion,
      id: crypto.randomUUID(),
      titulo: tituloNuevo,
      archivoAudio: archivoNuevo,
      duracionSeg: duracionNueva,
      bytes: await tamanoArchivo(archivoNuevo),
      marcas: marcasNuevas,
      transcripcion: null,
    };
    await escribirMetaGrabacion(copia);
    return copia;
  } finally {
    // Cualquier temporal que haya quedado sin usar (por un error a mitad de
    // camino, o la mitad descartada cuando partes.length === 1) se limpia.
    for (const ruta of [seg1, seg2, rutaResultado]) {
      if (ruta && (await exists(ruta))) {
        try {
          await remove(ruta);
        } catch {
          // No es crítico: es un temporal, no algo que el usuario vaya a notar.
        }
      }
    }
  }
}
