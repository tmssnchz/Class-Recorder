/**
 * Recomendación de motor y modelo según la máquina.
 *
 * Vive suelto y no dentro del catálogo de apuntes ni del de whisper a
 * propósito: el problema es el mismo en los dos casos ("de estas nueve
 * opciones, ¿cuál entra en esta máquina?") y la respuesta se calcula igual.
 * Cada catálogo declara cuánta RAM pide cada opción y esto elige.
 */
import { invoke } from "@tauri-apps/api/core";

export interface InfoSistema {
  ramTotalBytes: number;
  ramLibreBytes: number;
  nucleos: number;
}

export const infoSistema = () => invoke<InfoSistema>("info_sistema");

/** Lo mínimo que hay que saber de una opción para poder recomendarla. */
export interface OpcionRecomendable {
  id: string;
  etiqueta: string;
  /** RAM que necesita en marcha, en GB. */
  ramGB: number;
  /**
   * Orden de calidad dentro del catálogo: a igualdad de si entra o no, gana el
   * número más alto. No es una métrica objetiva, es el orden del catálogo.
   */
  calidad: number;
}

export interface Recomendacion<T extends OpcionRecomendable> {
  /** La que conviene usar. */
  opcion: T;
  /** Frase lista para mostrar, explicando por qué. */
  motivo: string;
  /**
   * true cuando ninguna opción entra cómoda y se está recomendando la más
   * chica igual. La interfaz lo usa para avisar en vez de prometer.
   */
  ajustada: boolean;
}

/** GB de RAM que se dejan para Windows, la app y el navegador del usuario. */
const RESERVA_GB = 3;

export function gb(bytes: number): number {
  return bytes / 1024 ** 3;
}

/**
 * La mejor opción que entra en la RAM disponible. Si ninguna entra, devuelve la
 * más liviana y lo dice: es mejor que la app admita que va a ir justa a que el
 * usuario descargue 3 GB y descubra solo que no arranca.
 */
export function recomendar<T extends OpcionRecomendable>(
  opciones: T[],
  info: InfoSistema,
): Recomendacion<T> | null {
  if (opciones.length === 0) return null;

  const disponible = Math.max(gb(info.ramTotalBytes) - RESERVA_GB, 0);
  const entran = opciones.filter((o) => o.ramGB <= disponible);

  if (entran.length === 0) {
    const masChica = [...opciones].sort((a, b) => a.ramGB - b.ramGB)[0];
    return {
      opcion: masChica,
      ajustada: true,
      motivo:
        `Con ${gb(info.ramTotalBytes).toFixed(0)} GB de RAM ninguna opción entra holgada. ` +
        `"${masChica.etiqueta}" es la más liviana: va a funcionar, pero conviene no usar ` +
        `la máquina para otra cosa mientras corre.`,
    };
  }

  const mejor = entran.sort((a, b) => b.calidad - a.calidad)[0];
  return {
    opcion: mejor,
    ajustada: false,
    motivo:
      `Con ${gb(info.ramTotalBytes).toFixed(0)} GB de RAM y ${info.nucleos} núcleos, ` +
      `"${mejor.etiqueta}" es la mejor opción que corre cómoda en esta máquina.`,
  };
}
