/**
 * Transcripción que corre junto a la grabación.
 *
 * whisper necesita un archivo completo, y el `.webm.part` de una clase en
 * curso crece hasta que se detiene. La solución es no esperarlo: cada vez que
 * hay otra ventana entera de audio escrita en disco, se extrae ese tramo con
 * ffmpeg y se lo manda a transcribir. Los segmentos se van acumulando con sus
 * tiempos referidos al inicio de la clase, así que al detener solo queda la
 * cola —lo que se grabó después de la última ventana— y la transcripción está
 * lista en minutos en vez de en una hora.
 *
 * Tres cosas que no son negociables acá:
 *
 *  - El audio manda. Si algo de esto falla, la grabación sigue y el archivo
 *    queda intacto; el proveedor de transcripciones se encarga después.
 *  - Nadie puede tener el `.part` abierto cuando el grabador lo renombra o lo
 *    mueve de carpeta: en Windows eso falla y se pierde la grabación entera.
 *    De ahí `suspender()`, que corta la lectura y espera a la que esté en
 *    curso. Solo cubre a ffmpeg: whisper ya trabaja sobre un WAV temporal
 *    propio y no toca el archivo de la clase.
 *  - Los tiempos tienen que coincidir con el audio. Por eso las ventanas se
 *    miden en segundos grabados (la pausa no escribe nada, así que el reloj de
 *    la grabación y el del archivo son el mismo) y el corte es exacto.
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  cancelarTranscripcion,
  escribirTranscripcion,
  motorLocalDe,
  transcribirTramo,
  type ResultadoTranscripcion,
} from "./transcripcion.ts";
import type { Config, Grabacion, Segmento } from "../types.ts";

/**
 * Cuánto audio agarra cada pasada. Dos minutos es el equilibrio: más corto
 * corta demasiadas frases al medio y paga el arranque de whisper todo el
 * tiempo; más largo hace que al detener quede una cola incómoda.
 */
const VENTANA_SEG = 120;
/**
 * Colchón al final del archivo que no se toca. MediaRecorder entrega un trozo
 * cada 5 s y la escritura va en cola, así que los últimos segundos pueden no
 * estar todavía en disco.
 */
const MARGEN_SEG = 15;
/** Cada cuánto se revisa si ya hay otra ventana lista. */
const REVISAR_MS = 5000;
/**
 * Fallos seguidos antes de rendirse. Uno puede ser el antivirus mirando el
 * archivo justo en ese momento; dos seguidos ya es un problema de verdad.
 */
const FALLOS_MAX = 2;

export interface EstadoParalela {
  /** 0..100 del audio grabado que ya está transcrito. */
  porcentaje: number;
  /** Segundos de clase ya transcritos, para mostrarlos como tiempo. */
  transcritoSeg: number;
  /** null mientras vaya bien; el mensaje del fallo si se rindió. */
  error: string | null;
  /** true mientras se está transcribiendo la cola, después de detener. */
  finalizando: boolean;
}

export interface OpcionesParalela {
  /**
   * Ruta del `.webm.part` en curso. Se consulta en cada ventana: cambiar de
   * clase a mitad de la grabación mueve el archivo de carpeta.
   */
  rutaActual(): string | null;
  /** Segundos de audio ya grabados (sin contar el tiempo en pausa). */
  grabadoSeg(): number;
  /** Config al momento de cada ventana: el usuario puede cambiar de modelo. */
  config(): Config;
  /** Prefijo de los ids de tarea que se le pasan a Rust, para poder cancelar. */
  tareaBase: string;
  onEstado(estado: EstadoParalela): void;
}

export interface TranscripcionParalela {
  estado(): EstadoParalela;
  /**
   * Corta la lectura del archivo de la clase y espera a la que esté en curso.
   * Hay que llamarla antes de renombrar o mover el `.part`.
   */
  suspender(): Promise<void>;
  reanudar(): void;
  /**
   * Transcribe lo que quedó después de la última ventana y escribe el .txt y
   * el .segmentos.json. Devuelve null si no hay nada aprovechable (falló antes
   * o el audio no tenía voz): ahí hay que transcribir la grabación como
   * siempre, después.
   */
  finalizar(grabacion: Grabacion): Promise<ResultadoTranscripcion | null>;
  /** Mata whisper si está corriendo y deja de programar ventanas. */
  cancelar(): Promise<void>;
}

/**
 * Junta dos tandas de segmentos descartando lo que se pise en el tiempo.
 *
 * Whisper a veces estira el último segmento de un tramo más allá del corte, y
 * la cola final se pide con un poco de colchón. Sin esta limpieza el texto
 * repetiría frases en cada borde de ventana.
 */
export function fusionarSegmentos(
  previos: Segmento[],
  nuevos: Segmento[],
): Segmento[] {
  if (previos.length === 0) return [...nuevos];
  const finPrevio = previos[previos.length - 1].hastaMs;
  // Se conserva el que empieza después de donde terminó lo anterior. El
  // criterio es el comienzo, no el final: un segmento que arranca dentro de lo
  // ya transcrito es la misma frase dicha de nuevo.
  return [...previos, ...nuevos.filter((s) => s.desdeMs >= finPrevio)];
}

export function iniciarTranscripcionParalela(
  opciones: OpcionesParalela,
): TranscripcionParalela {
  let cursorSeg = 0;
  let segmentos: Segmento[] = [];
  let error: string | null = null;
  let fallos = 0;
  let suspendido = false;
  let cancelado = false;
  let finalizando = false;
  /** Ventana en curso: la promesa completa (ffmpeg + whisper). */
  let enCurso: Promise<void> = Promise.resolve();
  /** Solo el tramo en el que ffmpeg tiene abierto el archivo de la clase. */
  let leyendo: Promise<void> = Promise.resolve();
  let indice = 0;
  /** Fracción 0..1 de la ventana que whisper lleva procesada. */
  let avanceVentana = 0;
  let tareaActual: string | null = null;
  let quitarEscucha: UnlistenFn | null = null;

  const comenzoEn = Date.now();
  const idTarea = (i: number) => `${opciones.tareaBase}#p${i}`;

  const estado = (): EstadoParalela => {
    const grabado = opciones.grabadoSeg();
    const transcritoSeg = cursorSeg + avanceVentana * VENTANA_SEG;
    return {
      porcentaje:
        grabado > 0
          ? Math.min(100, Math.round((transcritoSeg / grabado) * 100))
          : 0,
      transcritoSeg,
      error,
      finalizando,
    };
  };

  const avisar = () => opciones.onEstado(estado());

  // El avance de whisper llega por evento desde Rust, con el id de tarea que
  // le pasamos. Se filtra por prefijo para no mezclarse con las
  // transcripciones normales que puedan estar corriendo en la cola.
  void listen<{ tarea: string; porcentaje: number }>(
    "transcripcion://progreso",
    (evento) => {
      if (!evento.payload.tarea.startsWith(`${opciones.tareaBase}#p`)) return;
      avanceVentana = evento.payload.porcentaje / 100;
      avisar();
    },
  ).then((quitar) => {
    quitarEscucha = quitar;
    if (cancelado) quitar();
  });

  /** Transcribe [desdeSeg, desdeSeg+duracionSeg) del archivo `ruta`. */
  const procesarVentana = async (
    ruta: string,
    desdeSeg: number,
    duracionSeg: number,
  ) => {
    const tarea = idTarea(indice++);
    tareaActual = tarea;
    avanceVentana = 0;
    avisar();

    // La lectura del archivo de la clase es lo único que hay que esperar antes
    // de un rename: se publica aparte para que `suspender()` no quede colgada
    // los minutos que tarda whisper.
    let liberarLectura: () => void = () => undefined;
    leyendo = new Promise<void>((resolver) => {
      liberarLectura = resolver;
    });

    try {
      const nuevos = await transcribirTramo(
        ruta,
        opciones.config(),
        tarea,
        (etapa) => {
          // Cuando whisper arranca, ffmpeg ya cerró el archivo de la clase.
          if (etapa !== "preparando") liberarLectura();
        },
        { desdeSeg, duracionSeg },
      );
      segmentos = fusionarSegmentos(segmentos, nuevos);
      cursorSeg = desdeSeg + duracionSeg;
      fallos = 0;
    } finally {
      liberarLectura();
      tareaActual = null;
      avanceVentana = 0;
      avisar();
    }
  };

  const revisar = () => {
    if (cancelado || suspendido || error || finalizando) return;
    const ruta = opciones.rutaActual();
    if (!ruta) return;
    if (opciones.grabadoSeg() - cursorSeg < VENTANA_SEG + MARGEN_SEG) return;

    const desde = cursorSeg;
    enCurso = enCurso.then(async () => {
      // Se revalida acá dentro: entre que se programó y que le tocó el turno
      // pudo pasar un `suspender()` o un `detener()`.
      if (cancelado || suspendido || error || finalizando) return;
      const rutaAhora = opciones.rutaActual();
      if (!rutaAhora) return;
      try {
        await procesarVentana(rutaAhora, desde, VENTANA_SEG);
      } catch (e) {
        fallos += 1;
        const mensaje = e instanceof Error ? e.message : String(e);
        console.warn(
          `La transcripción en paralelo falló en el minuto ${Math.round(
            desde / 60,
          )}: ${mensaje}`,
        );
        if (fallos >= FALLOS_MAX) {
          error = mensaje;
          avisar();
        }
      }
    });
  };

  const reloj = window.setInterval(revisar, REVISAR_MS);
  const detenerReloj = () => window.clearInterval(reloj);

  return {
    estado,

    async suspender() {
      suspendido = true;
      await leyendo.catch(() => undefined);
    },

    reanudar() {
      suspendido = false;
    },

    async finalizar(grabacion) {
      detenerReloj();
      finalizando = true;
      avisar();
      try {
        // La ventana que estuviera a mitad de camino se deja terminar: ya pagó
        // el tramo caro y sus segmentos sirven igual.
        await enCurso.catch(() => undefined);

        const restanteSeg = grabacion.duracionSeg - cursorSeg;
        if (!error && restanteSeg > 1) {
          try {
            // Un par de segundos de colchón: la duración cronometrada y la del
            // archivo pueden diferir en fracciones. `fusionarSegmentos` limpia
            // lo que se repita.
            await procesarVentana(
              grabacion.archivoAudio,
              cursorSeg,
              restanteSeg + 2,
            );
          } catch (e) {
            error = e instanceof Error ? e.message : String(e);
            console.error("No se pudo transcribir la cola de la clase:", error);
          }
        }

        // Con un fallo de por medio lo transcrito a medias no sirve: mejor
        // transcribir la clase entera después que dejar un .txt cortado.
        if (error || segmentos.length === 0) return null;

        const { motor, modelo } = motorLocalDe(opciones.config());
        return await escribirTranscripcion(
          grabacion,
          segmentos,
          motor,
          modelo,
          (Date.now() - comenzoEn) / 1000,
        );
      } finally {
        finalizando = false;
        quitarEscucha?.();
        avisar();
      }
    },

    async cancelar() {
      cancelado = true;
      detenerReloj();
      quitarEscucha?.();
      if (tareaActual) {
        await cancelarTranscripcion(tareaActual).catch(() => undefined);
      }
      await enCurso.catch(() => undefined);
    },
  };
}
