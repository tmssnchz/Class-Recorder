/**
 * Motor de grabación.
 *
 * Vive por encima de las pestañas a propósito: cambiar de vista (o irse a la
 * biblioteca a buscar algo) no debe cortar una clase en curso.
 *
 * Autoguardado: MediaRecorder entrega un chunk cada TROZO_MS y cada chunk se
 * escribe inmediatamente al archivo `.webm.part`. Si la app se cierra de golpe,
 * lo grabado hasta el último chunk sigue en disco y se puede recuperar.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { exists, remove, rename, writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { convertirAudio, duracionDe, unirTramos } from "../lib/audio";
import {
  buscarInterrumpidas,
  consultarEspacio,
  descartarInterrumpida,
  escribirMetaGrabacion,
  escribirMetaParcial,
  moverDestino,
  prepararDestino,
  raizDeClase,
  tamanoArchivo,
  type Destino,
  type GrabacionInterrumpida,
  type MetaParcial,
} from "../lib/grabaciones";
import { unir } from "../lib/paths";
import { fijarSuspension } from "../lib/suspensionSistema";
import {
  LIMITE_SIN_CHUNKS_MS,
  avisoDuracion,
  estaSinChunks,
  huecoEntreChunks,
  lineaLog,
  mensajeProblemaAudio,
  mensajeReapertura,
  type ProblemaAudio,
  type TramoAudio,
} from "../lib/vigilanciaGrabacion";
import type { ResultadoTranscripcion } from "../lib/transcripcion";
import {
  iniciarTranscripcionParalela,
  type EstadoParalela,
  type TranscripcionParalela,
} from "../lib/transcripcionParalela";
import {
  SIN_CLASE,
  SIN_UNIDAD,
  type FormatoAudio,
  type Grabacion,
  type Marca,
} from "../types";
import { nuevoId, useStore } from "./store";

/** Cada cuánto MediaRecorder entrega un pedazo para escribir a disco. */
const TROZO_MS = 5000;
/**
 * Por debajo de este nivel (0..1 de la escala del medidor) se considera que no
 * hay voz. Un aula en silencio con ruido ambiente ronda 0.02-0.03; un
 * micrófono desenchufado o silenciado da exactamente 0.
 */
const NIVEL_SILENCIO = 0.015;
/** Cada cuánto se refresca la metadata parcial en disco. */
const META_CADA_MS = 15000;
const BYTES_POR_GB = 1024 ** 3;

/** Tras un corte, cada cuánto se reintenta abrir el micrófono. */
const REINTENTO_MICROFONO_MS = 5000;
/** Tras reabrir, pausa mínima antes de poder reabrir de nuevo (evita un bucle). */
const ENFRIAMIENTO_REAPERTURA_MS = 3000;

const esperar = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

function restriccionesAudio(deviceId?: string): MediaStreamConstraints {
  return {
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true,
    },
  };
}

/** Resumen sin nombres de dispositivo: cuántas entradas hay y si la en uso sigue. */
async function describirEntradas(pista?: MediaStreamTrack): Promise<string> {
  try {
    const todos = await navigator.mediaDevices.enumerateDevices();
    const entradas = todos.filter((d) => d.kind === "audioinput");
    const id = pista?.getSettings().deviceId;
    const presente = id ? entradas.some((d) => d.deviceId === id) : null;
    const estado =
      presente === null ? "?" : presente ? "sigue en la lista" : "YA NO ESTÁ en la lista";
    return `entradas de audio=${entradas.length}, la en uso ${estado}`;
  } catch {
    return "no se pudieron listar los dispositivos";
  }
}

export type FaseGrabacion = "inactivo" | "grabando" | "pausado" | "finalizando";

export interface AvisoEspacio {
  libreBytes: number;
  totalBytes: number;
  umbralBytes: number;
}

interface OpcionesInicio {
  claseId?: string | null;
  unidadId?: string | null;
  /** El usuario ya vio el aviso de poco espacio y decidió grabar igual. */
  ignorarEspacio?: boolean;
}

/**
 * La clase y unidad elegidas viven en el proveedor, no en el panel: los atajos
 * globales pueden disparar "grabar" con la app minimizada, y ahí no hay panel
 * montado del que leer la selección.
 */
export interface Seleccion {
  claseId: string | null;
  unidadId: string | null;
}

interface Grabador {
  fase: FaseGrabacion;
  segundos: number;
  bytesEscritos: number;
  marcas: Marca[];
  destino: Destino | null;
  error: string | null;
  avisoEspacio: AvisoEspacio | null;
  cierrePendiente: boolean;
  /** id de grabación → fracción 0..1 de la conversión en curso. */
  conversiones: Record<string, number>;
  interrumpidas: GrabacionInterrumpida[];
  seleccion: Seleccion;
  /** true mientras se están moviendo los archivos a la nueva clase/unidad. */
  moviendoDestino: boolean;
  /** Segundos que lleva sin detectarse sonido, o null si se está captando. */
  segundosEnSilencio: number | null;
  /**
   * Aviso grave y visible: el micrófono dejó de entregar audio (pista
   * terminada o silenciada, o sin fragmentos de MediaRecorder). No detiene la
   * grabación. null si todo va bien.
   */
  avisoAudio: string | null;
  /**
   * Avance de la transcripción que corre junto a la grabación, o null si está
   * apagada en Configuración. Sigue vivo un rato después de detener: la cola
   * de la clase se transcribe con la grabación ya guardada.
   */
  paralela: EstadoParalela | null;
  /**
   * Grabación que quedó guardada sin transcripción porque la paralela falló o
   * no estaba activa. La consume `ProveedorTranscripciones`, que la manda a la
   * cola de siempre; el grabador no puede encolarla solo porque vive por
   * encima de esa cola.
   */
  pendienteTranscripcion: Grabacion | null;
  consumirPendienteTranscripcion(): void;

  elegirClase(claseId: string | null): void;
  elegirUnidad(unidadId: string | null): void;
  iniciar(opciones?: OpcionesInicio): Promise<void>;
  pausar(): void;
  reanudar(): void;
  alternarPausa(): void;
  /** Devuelve la grabación recién guardada (o null si no había nada grabando). */
  detener(): Promise<Grabacion | null>;
  marcar(): void;
  editarNotaMarca(id: string, nota: string): void;
  quitarMarca(id: string): void;
  limpiarError(): void;
  limpiarAvisoEspacio(): void;
  cancelarCierre(): void;
  detenerYCerrar(): Promise<void>;
  nivelActual(): number;
  refrescarInterrumpidas(): Promise<void>;
  recuperarInterrumpida(i: GrabacionInterrumpida): Promise<void>;
  descartarInterrumpidaGrabacion(i: GrabacionInterrumpida): Promise<void>;
}

const ContextoGrabador = createContext<Grabador | null>(null);

export function ProveedorGrabador({ children }: { children: ReactNode }) {
  const {
    datos,
    config,
    agregarGrabacion,
    actualizarGrabacion,
    cargando,
  } = useStore();

  const [fase, setFase] = useState<FaseGrabacion>("inactivo");
  const [segundos, setSegundos] = useState(0);
  const [bytesEscritos, setBytesEscritos] = useState(0);
  const [marcas, setMarcas] = useState<Marca[]>([]);
  const [destino, setDestino] = useState<Destino | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [avisoEspacio, setAvisoEspacio] = useState<AvisoEspacio | null>(null);
  const [cierrePendiente, setCierrePendiente] = useState(false);
  const [conversiones, setConversiones] = useState<Record<string, number>>({});
  const [interrumpidas, setInterrumpidas] = useState<GrabacionInterrumpida[]>([]);
  const [seleccion, setSeleccion] = useState<Seleccion>({
    claseId: null,
    unidadId: null,
  });
  const [moviendo, setMoviendo] = useState(false);
  const [segundosEnSilencio, setSegundosEnSilencio] = useState<number | null>(null);
  const [avisoAudio, setAvisoAudio] = useState<string | null>(null);
  const [paralela, setParalela] = useState<EstadoParalela | null>(null);
  const [pendienteTranscripcion, setPendienteTranscripcion] =
    useState<Grabacion | null>(null);
  const seleccionRef = useRef(seleccion);
  /** Última vez (performance.now) que el micrófono captó algo por encima del umbral. */
  const ultimoSonidoRef = useRef(0);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analizadorRef = useRef<AnalyserNode | null>(null);
  const bufferNivelRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const destinoRef = useRef<Destino | null>(null);
  // Ruta real donde escribe ondataavailable: separada de `destino` (el estado
  // de React) porque el handler del MediaRecorder necesita leer el valor más
  // reciente en cada chunk, incluso si se reasignó de clase/unidad recién.
  const rutaEscrituraRef = useRef<string | null>(null);
  // Serializa las reasignaciones de clase/unidad entre sí: si el usuario
  // cambia de selección dos veces seguido, la segunda tiene que esperar a que
  // la primera termine de mover los archivos antes de leer el destino actual.
  const reasignacionRef = useRef<Promise<void>>(Promise.resolve());
  const metaRef = useRef<MetaParcial | null>(null);
  const paralelaRef = useRef<TranscripcionParalela | null>(null);
  const marcasRef = useRef<Marca[]>([]);
  const faseRef = useRef<FaseGrabacion>("inactivo");
  const bytesRef = useRef(0);
  // Cola de escrituras: los chunks tienen que llegar al archivo en orden.
  const colaRef = useRef<Promise<void>>(Promise.resolve());
  const acumuladoMsRef = useRef(0);
  const inicioTramoRef = useRef(0);
  const intervaloRef = useRef<number | null>(null);
  const ultimaMetaRef = useRef(0);
  const configRef = useRef(config);
  const datosRef = useRef(datos);
  // Vigilancia del micrófono y log de diagnóstico de la grabación en curso.
  const ultimoChunkRef = useRef(0);
  const chunksRef = useRef(0);
  const vaciosRef = useRef(0);
  const ultimoTickRef = useRef(0);
  const inicioRelojRef = useRef(0);
  const problemasRef = useRef(new Set<ProblemaAudio>());
  const logRef = useRef<string[]>([]);
  const logColaRef = useRef<Promise<void>>(Promise.resolve());
  const quitarEscuchasRef = useRef<(() => void)[]>([]);
  // Reapertura del micrófono: cada corte abre un segmento nuevo (.segN.part) y
  // `silenciosRef[i]` es lo que duró el corte antes del segmento i+2.
  const silenciosRef = useRef<number[]>([]);
  const ultimoChunkCronRef = useRef(0);
  const reabriendoRef = useRef(false);
  const deteniendoRef = useRef(false);
  const fuenteRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const reabrirRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    configRef.current = config;
  }, [config]);
  useEffect(() => {
    datosRef.current = datos;
  }, [datos]);

  useEffect(() => {
    seleccionRef.current = seleccion;
  }, [seleccion]);

  const ponerFase = useCallback((f: FaseGrabacion) => {
    faseRef.current = f;
    setFase(f);
  }, []);

  const transcurridoMs = useCallback(() => {
    const enCurso =
      faseRef.current === "grabando" ? performance.now() - inicioTramoRef.current : 0;
    return acumuladoMsRef.current + enCurso;
  }, []);

  const rutaLog = (d: Destino) => unir(d.carpeta, `${d.base}.log.txt`);

  /** Reescribe el log entero junto al audio: pocos eventos, y así nunca queda a medias. */
  const volcarLog = useCallback((): Promise<void> => {
    const d = destinoRef.current;
    if (!d) return logColaRef.current;
    const ruta = rutaLog(d);
    const texto = `${logRef.current.join("\n")}\n`;
    logColaRef.current = logColaRef.current
      .then(() => writeTextFile(ruta, texto))
      .catch((e) => console.warn("No se pudo escribir el log de la grabación", e));
    return logColaRef.current;
  }, []);

  const registrar = useCallback(
    (evento: string, detalle?: string) => {
      logRef.current.push(
        lineaLog(
          (performance.now() - inicioRelojRef.current) / 1000,
          transcurridoMs() / 1000,
          evento,
          detalle,
        ),
      );
      void volcarLog();
    },
    [transcurridoMs, volcarLog],
  );

  const refrescarAviso = useCallback(() => {
    setAvisoAudio(
      mensajeProblemaAudio(
        problemasRef.current,
        (performance.now() - ultimoChunkRef.current) / 1000,
      ) ?? mensajeReapertura(silenciosRef.current),
    );
  }, []);

  const estadoPista = useCallback(() => {
    const pista = streamRef.current?.getAudioTracks()[0];
    return pista
      ? `readyState=${pista.readyState}, muted=${pista.muted}, enabled=${pista.enabled}`
      : "sin pista de audio";
  }, []);

  /** Dónde escribe el segmento n: el 1 es el .part de siempre. */
  const rutaSegmento = (n: number): string | null => {
    const d = destinoRef.current;
    if (!d) return null;
    return n === 1
      ? (rutaEscrituraRef.current ?? d.rutaParcial)
      : unir(d.carpeta, `${d.base}.seg${n}.part`);
  };

  const crearRecorder = useCallback(
    (stream: MediaStream, n: number): MediaRecorder => {
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const rec = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64000 });
      let primero = true;
      rec.ondataavailable = (evento) => {
        if (!evento.data || evento.data.size === 0) {
          vaciosRef.current++;
          return;
        }
        const ahora = performance.now();
        const hueco = huecoEntreChunks(ahora, ultimoChunkRef.current);
        ultimoChunkRef.current = ahora;
        ultimoChunkCronRef.current = transcurridoMs() / 1000;
        chunksRef.current++;
        if (hueco !== null) {
          registrar("hueco entre fragmentos", `${hueco.toFixed(1)} s sin datos`);
        }
        if (problemasRef.current.delete("sin-datos")) {
          registrar("fragmentos reanudados");
          refrescarAviso();
        }
        const blob = evento.data;
        colaRef.current = colaRef.current
          .then(async () => {
            const bytes = new Uint8Array(await blob.arrayBuffer());
            // Se lee en cada chunk: si hubo una reasignación de clase/unidad
            // de por medio, ya apunta al archivo movido.
            const ruta = rutaSegmento(n);
            if (!ruta) return;
            // El primer chunk de un segmento nuevo crea el archivo; el del
            // segmento 1 ya tiene su .part vacío creado al iniciar.
            const agregar = n === 1 || !primero;
            primero = false;
            await writeFile(ruta, bytes, { append: agregar });
            bytesRef.current += bytes.byteLength;
          })
          .catch((e) => {
            console.error("Error al guardar un fragmento", e);
            setError(
              `Se perdió un fragmento al escribir en disco: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          });
      };
      rec.onerror = (evento) => {
        registrar("error del grabador", String((evento as ErrorEvent).error));
        setError(`Error del grabador: ${String((evento as ErrorEvent).error)}`);
      };
      rec.addEventListener("stop", () =>
        registrar("MediaRecorder stop", `segmento=${n}, estado=${rec.state}`),
      );
      return rec;
    },
    [refrescarAviso, registrar, transcurridoMs],
  );

  const escucharPista = useCallback(
    (stream: MediaStream) => {
      const pista = stream.getAudioTracks()[0];
      if (!pista) return;
      const escuchar = (tipo: string, fn: () => void) => {
        pista.addEventListener(tipo, fn);
        quitarEscuchasRef.current.push(() => pista.removeEventListener(tipo, fn));
      };
      const marcar = (p: ProblemaAudio, activo: boolean) => {
        if (activo) problemasRef.current.add(p);
        else problemasRef.current.delete(p);
        refrescarAviso();
      };
      escuchar("ended", () => {
        registrar("pista ended", estadoPista());
        marcar("ended", true);
        reabrirRef.current();
      });
      escuchar("mute", () => {
        registrar("pista mute", estadoPista());
        marcar("mute", true);
      });
      escuchar("unmute", () => {
        registrar("pista unmute", estadoPista());
        marcar("mute", false);
      });
    },
    [estadoPista, refrescarAviso, registrar],
  );

  /**
   * Reabre el micrófono tras un corte y sigue grabando en un segmento nuevo;
   * `detener` los une rellenando el corte con silencio. Reintenta hasta que
   * vuelva o se detenga la grabación. Nunca toca lo ya guardado.
   */
  const reabrir = useCallback(async () => {
    if (reabriendoRef.current) return;
    reabriendoRef.current = true;
    const activa = () =>
      (faseRef.current === "grabando" || faseRef.current === "pausado") &&
      !deteniendoRef.current;
    try {
      // El grabador viejo suelta lo que tenga pendiente antes de medir el corte.
      const viejo = recorderRef.current;
      if (viejo && viejo.state !== "inactive") {
        await new Promise<void>((resolver) => {
          viejo.addEventListener("stop", () => resolver(), { once: true });
          try {
            viejo.stop();
          } catch {
            resolver();
          }
          window.setTimeout(resolver, 1500);
        });
      }

      let intento = 0;
      while (activa()) {
        intento++;
        const id = configRef.current.microfonoId;
        let stream: MediaStream | null = null;
        let predeterminado = false;
        let fallo = "";
        try {
          stream = await navigator.mediaDevices.getUserMedia(restriccionesAudio(id || undefined));
        } catch (e) {
          fallo = e instanceof Error ? e.name : String(e);
          if (id) {
            // El micrófono elegido no está: mejor el predeterminado que nada.
            try {
              stream = await navigator.mediaDevices.getUserMedia(restriccionesAudio());
              predeterminado = true;
            } catch (e2) {
              fallo = e2 instanceof Error ? e2.name : String(e2);
            }
          }
        }

        if (!stream) {
          if (intento <= 3 || intento % 12 === 0) {
            registrar("no se pudo reabrir el micrófono", `intento ${intento}: ${fallo}`);
          }
          await esperar(REINTENTO_MICROFONO_MS);
          continue;
        }
        if (!activa()) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        // Desde acá todo es síncrono: `detener` no puede colarse a mitad.
        const hueco = Math.max(0, transcurridoMs() / 1000 - ultimoChunkCronRef.current);
        silenciosRef.current.push(hueco);
        const n = silenciosRef.current.length + 1;
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = stream;
        const ctx = audioCtxRef.current;
        const analizador = analizadorRef.current;
        if (ctx && analizador) {
          fuenteRef.current?.disconnect();
          fuenteRef.current = ctx.createMediaStreamSource(stream);
          fuenteRef.current.connect(analizador);
        }
        const rec = crearRecorder(stream, n);
        recorderRef.current = rec;
        rec.start(TROZO_MS);
        if (faseRef.current === "pausado") rec.pause();
        escucharPista(stream);
        ultimoChunkRef.current = performance.now();
        problemasRef.current.delete("ended");
        problemasRef.current.delete("sin-datos");
        problemasRef.current.delete("mute");
        refrescarAviso();
        registrar(
          "micrófono reabierto",
          `segmento ${n}; corte de ${hueco.toFixed(1)} s; intento ${intento}; ${
            predeterminado ? "con el micrófono predeterminado" : "con el mismo dispositivo"
          }; ${estadoPista()}`,
        );
        await esperar(ENFRIAMIENTO_REAPERTURA_MS);
        return;
      }
    } finally {
      reabriendoRef.current = false;
    }
  }, [
    crearRecorder,
    escucharPista,
    estadoPista,
    refrescarAviso,
    registrar,
    transcurridoMs,
  ]);
  reabrirRef.current = () => void reabrir();

  // Que el equipo no se suspenda mientras se graba (ni en pausa: ahí no hace
  // falta). El control compartido no la suelta si la cola de transcripciones
  // todavía la necesita.
  useEffect(() => {
    fijarSuspension("grabacion", fase === "grabando");
  }, [fase]);
  useEffect(() => () => fijarSuspension("grabacion", false), []);

  /**
   * Mueve los archivos temporales a la carpeta de la nueva clase/unidad
   * mientras la grabación sigue en curso. No hace nada si no hay grabación
   * activa: en ese caso `elegirClase`/`elegirUnidad` solo tocan la selección.
   */
  const reasignarDestino = useCallback(
    (
      claseNombre: string,
      unidadNombre: string,
      claseId: string | null,
      unidadId: string | null,
    ) => {
      reasignacionRef.current = reasignacionRef.current.then(async () => {
        const d = destinoRef.current;
        const meta = metaRef.current;
        if (!d || !meta) return;
        // Se comparan también los ids: dos clases pueden llamarse igual, y en
        // ese caso la carpeta no cambia pero la grabación sí tiene que quedar
        // asociada a la clase correcta.
        const mismoDestino =
          meta.claseNombre === claseNombre &&
          meta.unidadNombre === unidadNombre &&
          meta.claseId === claseId &&
          meta.unidadId === unidadId;
        if (mismoDestino) return;

        const cfg = configRef.current;
        const logViejo = rutaLog(d);
        setMoviendo(true);
        try {
          // Igual que con las escrituras: si ffmpeg está leyendo el .part para
          // una ventana de la transcripción paralela, moverlo falla en Windows.
          await paralelaRef.current?.suspender();
          // Se encola detrás de las escrituras de audio pendientes: el rename
          // no puede pisar un chunk que todavía se está apendeando.
          const raiz = raizDeClase(datosRef.current.grabaciones, claseId, cfg.carpetaRaiz);
          const tarea = colaRef.current.then(async () => {
            const nuevo = await moverDestino(
              d,
              raiz,
              new Date(meta.fechaISO),
              claseNombre,
              unidadNombre,
            );
            // Los segmentos de la reapertura del micrófono van con el audio.
            for (let i = 0; i < silenciosRef.current.length; i++) {
              const de = unir(d.carpeta, `${d.base}.seg${i + 2}.part`);
              const a = unir(nuevo.carpeta, `${nuevo.base}.seg${i + 2}.part`);
              if (de !== a && (await exists(de))) await rename(de, a);
            }
            return nuevo;
          });
          colaRef.current = tarea.then(() => undefined).catch(() => undefined);

          const nuevo = await tarea;
          destinoRef.current = nuevo;
          rutaEscrituraRef.current = nuevo.rutaParcial;
          setDestino(nuevo);

          // El log se reescribe entero en la carpeta nueva; el viejo sobra.
          await logColaRef.current;
          try {
            if (logViejo !== rutaLog(nuevo) && (await exists(logViejo))) {
              await remove(logViejo);
            }
          } catch {
            // Es solo diagnóstico: si no se borra, queda un duplicado inofensivo.
          }
          registrar("clase/unidad reasignada");

          meta.claseId = claseId;
          meta.unidadId = unidadId;
          meta.claseNombre = claseNombre;
          meta.unidadNombre = unidadNombre;
          metaRef.current = meta;
          await escribirMetaParcial(nuevo.rutaMetaParcial, {
            ...meta,
            duracionSeg: transcurridoMs() / 1000,
            marcas: marcasRef.current,
          });
        } catch (e) {
          setError(
            `No se pudo cambiar la clase/unidad de la grabación en curso: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        } finally {
          paralelaRef.current?.reanudar();
          setMoviendo(false);
        }
      });
    },
    [registrar, transcurridoMs],
  );

  const elegirClase = useCallback(
    (claseId: string | null) => {
      if (faseRef.current === "grabando" || faseRef.current === "pausado") {
        const clase = datos.clases.find((c) => c.id === claseId) ?? null;
        reasignarDestino(clase?.nombre ?? SIN_CLASE, SIN_UNIDAD, clase?.id ?? null, null);
      }
      // Cambiar de clase invalida la unidad: pertenece a la clase anterior.
      setSeleccion({ claseId, unidadId: null });
    },
    [datos.clases, reasignarDestino],
  );

  const elegirUnidad = useCallback(
    (unidadId: string | null) => {
      if (faseRef.current === "grabando" || faseRef.current === "pausado") {
        const clase =
          datos.clases.find((c) => c.id === seleccionRef.current.claseId) ?? null;
        const unidad = clase?.unidades.find((u) => u.id === unidadId) ?? null;
        reasignarDestino(
          clase?.nombre ?? SIN_CLASE,
          unidad?.nombre ?? SIN_UNIDAD,
          clase?.id ?? null,
          unidad?.id ?? null,
        );
      }
      setSeleccion((s) => ({ ...s, unidadId }));
    },
    [datos.clases, reasignarDestino],
  );

  // -------------------------------------------------------------- conversión

  const convertir = useCallback(
    async (grabacion: Grabacion, formato: FormatoAudio) => {
      const salida = unir(grabacion.carpeta, `${grabacion.titulo}.${formato}`);
      setConversiones((c) => ({ ...c, [grabacion.id]: 0 }));
      try {
        await convertirAudio(grabacion.archivoAudio, salida, formato, {
          duracionSeg: grabacion.duracionSeg,
          onProgreso: (f) =>
            setConversiones((c) => ({ ...c, [grabacion.id]: f })),
        });

        const bytes = await tamanoArchivo(salida);
        // El .webm crudo solo se borra cuando el archivo final ya existe.
        if (bytes > 0 && (await exists(grabacion.archivoAudio))) {
          await remove(grabacion.archivoAudio);
        }
        // El cronómetro no sabe si el micrófono siguió entregando sonido: la
        // duración del MP3 sí es la verdad.
        const real = await duracionDe(salida).catch(() => 0);
        const cambios = {
          archivoAudio: salida,
          formato,
          bytes,
          estado: "listo" as const,
          errorConversion: null,
          ...(real > 0 ? { duracionSeg: real } : {}),
          avisoAudio:
            avisoDuracion(grabacion.duracionSeg, real) ?? grabacion.avisoAudio,
        };
        await actualizarGrabacion(grabacion.id, cambios);
        await escribirMetaGrabacion({ ...grabacion, ...cambios });
      } catch (e) {
        const mensaje = e instanceof Error ? e.message : String(e);
        console.error("Conversión fallida:", mensaje);
        await actualizarGrabacion(grabacion.id, {
          estado: "error-conversion",
          errorConversion: mensaje,
        });
      } finally {
        setConversiones((c) => {
          const copia = { ...c };
          delete copia[grabacion.id];
          return copia;
        });
      }
    },
    [actualizarGrabacion],
  );

  // Conversiones que quedaron a medias por un cierre inesperado.
  const reintentadoRef = useRef(false);
  useEffect(() => {
    if (cargando || reintentadoRef.current) return;
    reintentadoRef.current = true;
    const pendientes = datos.grabaciones.filter(
      (g) => g.estado === "convirtiendo" && g.formato === "webm",
    );
    for (const g of pendientes) {
      void (async () => {
        if (await exists(g.archivoAudio)) {
          await convertir(g, configRef.current.formatoAudio);
        } else {
          await actualizarGrabacion(g.id, {
            estado: "error-conversion",
            errorConversion: "No se encontró el archivo de audio original.",
          });
        }
      })();
    }
  }, [cargando, datos.grabaciones, convertir, actualizarGrabacion]);

  // ----------------------------------------------------- grabaciones caídas

  const refrescarInterrumpidas = useCallback(async () => {
    try {
      setInterrumpidas(await buscarInterrumpidas(configRef.current.carpetaRaiz));
    } catch (e) {
      console.error("No se pudieron buscar grabaciones interrumpidas", e);
    }
  }, []);

  useEffect(() => {
    if (!cargando) void refrescarInterrumpidas();
  }, [cargando, refrescarInterrumpidas]);

  // -------------------------------------------------------------- utilidades

  const limpiarRecursos = useCallback(() => {
    quitarEscuchasRef.current.forEach((f) => f());
    quitarEscuchasRef.current = [];
    fuenteRef.current = null;
    if (intervaloRef.current !== null) {
      window.clearInterval(intervaloRef.current);
      intervaloRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
      void audioCtxRef.current.close();
    }
    audioCtxRef.current = null;
    analizadorRef.current = null;
    bufferNivelRef.current = null;
  }, []);

  /**
   * Nivel de entrada 0..1. Se define antes que `iniciar` porque el intervalo
   * del cronómetro lo usa para vigilar que el micrófono siga captando.
   */
  const nivelActual = useCallback(() => {
    const analizador = analizadorRef.current;
    const buffer = bufferNivelRef.current;
    if (!analizador || !buffer || faseRef.current !== "grabando") return 0;
    analizador.getByteTimeDomainData(buffer);
    let suma = 0;
    for (let i = 0; i < buffer.length; i++) {
      const v = (buffer[i] - 128) / 128;
      suma += v * v;
    }
    // La RMS de voz normal ronda 0.05-0.15; escalamos para que se vea el movimiento.
    return Math.min(1, Math.sqrt(suma / buffer.length) * 4);
  }, []);

  const guardarMetaParcial = useCallback(async () => {
    const d = destinoRef.current;
    const m = metaRef.current;
    if (!d || !m) return;
    try {
      await escribirMetaParcial(d.rutaMetaParcial, {
        ...m,
        duracionSeg: transcurridoMs() / 1000,
        marcas: marcasRef.current,
      });
    } catch (e) {
      console.error("No se pudo actualizar la metadata parcial", e);
    }
  }, [transcurridoMs]);

  // ------------------------------------------------------------------ inicio

  const iniciar = useCallback(
    async (opciones: OpcionesInicio = {}) => {
      if (faseRef.current !== "inactivo") return;
      setError(null);
      setAvisoEspacio(null);

      const { ignorarEspacio } = opciones;
      const claseId = opciones.claseId ?? seleccionRef.current.claseId;
      const unidadId = opciones.unidadId ?? seleccionRef.current.unidadId;

      const cfg = configRef.current;
      const clase = datos.clases.find((c) => c.id === claseId) ?? null;
      const unidad = clase?.unidades.find((u) => u.id === unidadId) ?? null;
      const claseNombre = clase?.nombre ?? SIN_CLASE;
      const unidadNombre = unidad?.nombre ?? SIN_UNIDAD;

      try {
        // 1. Espacio en disco antes de tocar el micrófono.
        if (!ignorarEspacio) {
          try {
            const espacio = await consultarEspacio(cfg.carpetaRaiz);
            const umbralBytes = cfg.umbralDiscoGB * BYTES_POR_GB;
            if (espacio.libreBytes < umbralBytes) {
              setAvisoEspacio({
                libreBytes: espacio.libreBytes,
                totalBytes: espacio.totalBytes,
                umbralBytes,
              });
              return;
            }
          } catch (e) {
            // No poder medir el disco no debería impedir grabar la clase.
            console.warn("No se pudo consultar el espacio en disco", e);
          }
        }

        // 2. Micrófono.
        const stream = await navigator.mediaDevices.getUserMedia(
          restriccionesAudio(cfg.microfonoId || undefined),
        );
        streamRef.current = stream;

        // 3. Carpeta y archivo de destino.
        const raiz = raizDeClase(datosRef.current.grabaciones, clase?.id ?? null, cfg.carpetaRaiz);
        const d = await prepararDestino(raiz, claseNombre, unidadNombre, new Date());
        destinoRef.current = d;
        rutaEscrituraRef.current = d.rutaParcial;
        setDestino(d);
        // Crea el .part vacío: a partir de acá todas las escrituras son append.
        await writeFile(d.rutaParcial, new Uint8Array(0));

        const meta: MetaParcial = {
          id: nuevoId(),
          claseId: clase?.id ?? null,
          unidadId: unidad?.id ?? null,
          claseNombre,
          unidadNombre,
          fechaISO: new Date().toISOString(),
          duracionSeg: 0,
          marcas: [],
          formatoDestino: cfg.formatoAudio,
        };
        metaRef.current = meta;
        await escribirMetaParcial(d.rutaMetaParcial, meta);

        // 4. Medidor de nivel (para ver que el micrófono realmente capta).
        const ctx = new AudioContext();
        const analizador = ctx.createAnalyser();
        analizador.fftSize = 1024;
        fuenteRef.current = ctx.createMediaStreamSource(stream);
        fuenteRef.current.connect(analizador);
        audioCtxRef.current = ctx;
        analizadorRef.current = analizador;
        bufferNivelRef.current = new Uint8Array(new ArrayBuffer(analizador.fftSize));

        // 5. MediaRecorder.
        const rec = crearRecorder(stream, 1);
        recorderRef.current = rec;

        marcasRef.current = [];
        setMarcas([]);
        bytesRef.current = 0;
        setBytesEscritos(0);
        acumuladoMsRef.current = 0;
        inicioTramoRef.current = performance.now();
        ultimaMetaRef.current = performance.now();

        // Vigilancia y log de diagnóstico: solo observan, nunca tocan la grabación.
        inicioRelojRef.current = performance.now();
        ultimoChunkRef.current = performance.now();
        ultimoTickRef.current = performance.now();
        chunksRef.current = 0;
        vaciosRef.current = 0;
        problemasRef.current = new Set();
        logRef.current = [];
        setAvisoAudio(null);

        silenciosRef.current = [];
        ultimoChunkCronRef.current = 0;
        reabriendoRef.current = false;
        deteniendoRef.current = false;
        escucharPista(stream);
        const escuchar = (obj: EventTarget, tipo: string, fn: () => void) => {
          obj.addEventListener(tipo, fn);
          quitarEscuchasRef.current.push(() => obj.removeEventListener(tipo, fn));
        };
        escuchar(navigator.mediaDevices, "devicechange", () => {
          void describirEntradas(streamRef.current?.getAudioTracks()[0]).then((r) =>
            registrar("cambio de dispositivos", r),
          );
        });
        escuchar(document, "visibilitychange", () =>
          registrar("visibilidad de la ventana", document.visibilityState),
        );
        escuchar(ctx, "statechange", () => registrar("AudioContext", ctx.state));

        rec.start(TROZO_MS);
        ponerFase("grabando");
        void describirEntradas(stream.getAudioTracks()[0]).then((r) =>
          registrar(
            "inicio",
            `${rec.mimeType}; ${estadoPista()}; ${r}; ventana=${document.visibilityState}; empezó ${new Date().toISOString()}`,
          ),
        );
        setSegundos(0);
        ultimoSonidoRef.current = performance.now();
        setSegundosEnSilencio(null);

        // 6. Transcripción en paralelo, si está activada. Va después de que la
        // grabación ya arrancó: nada de esto puede impedir que se grabe.
        if (cfg.transcripcionParalela) {
          setParalela({
            porcentaje: 0,
            transcritoSeg: 0,
            error: null,
            finalizando: false,
          });
          // La transcripción de la clase anterior puede seguir cerrando su
          // cola cuando ya arrancó la siguiente: solo el handle vigente puede
          // escribir en la barra de progreso, o una clase pisaría a la otra.
          let propio: TranscripcionParalela | null = null;
          propio = iniciarTranscripcionParalela({
            rutaActual: () => rutaEscrituraRef.current,
            grabadoSeg: () => transcurridoMs() / 1000,
            config: () => configRef.current,
            tareaBase: meta.id,
            onEstado: (e) => {
              if (paralelaRef.current === propio) setParalela(e);
            },
          });
          paralelaRef.current = propio;
        } else {
          setParalela(null);
        }

        intervaloRef.current = window.setInterval(() => {
          setSegundos(transcurridoMs() / 1000);
          setBytesEscritos(bytesRef.current);

          // Si el reloj de la app se queda sin avanzar (equipo suspendido,
          // ahorro de energía, ventana en segundo plano) se ve en el log.
          const ahora = performance.now();
          const salto = ahora - ultimoTickRef.current;
          ultimoTickRef.current = ahora;
          if (salto > 3000) {
            registrar("reloj de la app detenido", `${(salto / 1000).toFixed(1)} s sin actividad`);
          }

          // Sin fragmentos de MediaRecorder = el micrófono no está entregando.
          if (
            faseRef.current === "grabando" &&
            estaSinChunks(ahora, ultimoChunkRef.current)
          ) {
            if (!problemasRef.current.has("sin-datos")) {
              problemasRef.current.add("sin-datos");
              registrar(
                "sin fragmentos",
                `más de ${LIMITE_SIN_CHUNKS_MS / 1000} s sin datos; ${estadoPista()}`,
              );
              reabrirRef.current();
            }
            refrescarAviso();
          }

          // Vigilancia del micrófono: mide el nivel en cada tick y lleva la
          // cuenta de cuánto hace que no entra sonido. Solo informa; cortar la
          // grabación por creer que hay silencio sería mucho peor que un aviso
          // de más si el profesor hace una pausa larga.
          if (faseRef.current === "grabando") {
            const minutos = configRef.current.minutosSilencioAviso;
            if (minutos <= 0) {
              setSegundosEnSilencio(null);
            } else {
              if (nivelActual() > NIVEL_SILENCIO) {
                ultimoSonidoRef.current = performance.now();
              }
              const callados = (performance.now() - ultimoSonidoRef.current) / 1000;
              setSegundosEnSilencio(callados >= minutos * 60 ? callados : null);
            }
          }

          if (performance.now() - ultimaMetaRef.current > META_CADA_MS) {
            ultimaMetaRef.current = performance.now();
            void guardarMetaParcial();
          }
        }, 250);
      } catch (e) {
        limpiarRecursos();
        destinoRef.current = null;
        setDestino(null);
        const mensaje = e instanceof Error ? e.message : String(e);
        setError(
          mensaje.includes("Permission") || mensaje.includes("NotAllowed")
            ? "Windows bloqueó el acceso al micrófono. Revisa Configuración › Privacidad › Micrófono."
            : `No se pudo iniciar la grabación: ${mensaje}`,
        );
      }
    },
    [
      datos.clases,
      crearRecorder,
      escucharPista,
      estadoPista,
      guardarMetaParcial,
      limpiarRecursos,
      nivelActual,
      ponerFase,
      refrescarAviso,
      registrar,
      transcurridoMs,
    ],
  );

  // ------------------------------------------------------------ pausa / stop

  const pausar = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || faseRef.current !== "grabando") return;
    rec.pause();
    acumuladoMsRef.current += performance.now() - inicioTramoRef.current;
    ponerFase("pausado");
    registrar("pausa");
    void guardarMetaParcial();
  }, [guardarMetaParcial, ponerFase, registrar]);

  const reanudar = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || faseRef.current !== "pausado") return;
    inicioTramoRef.current = performance.now();
    // Durante la pausa no llegan fragmentos: el vigilante parte de cero.
    ultimoChunkRef.current = performance.now();
    rec.resume();
    ponerFase("grabando");
    registrar("reanudación");
  }, [ponerFase, registrar]);

  const alternarPausa = useCallback(() => {
    if (faseRef.current === "grabando") pausar();
    else if (faseRef.current === "pausado") reanudar();
  }, [pausar, reanudar]);

  /**
   * Deja el audio de la grabación en `d.rutaWebm`. Sin cortes es un rename; con
   * cortes (micrófono reabierto) une los segmentos rellenando cada corte con
   * silencio. Si la unión falla se conserva al menos el primer segmento y los
   * demás quedan junto al audio para no perder nada.
   */
  const unirSegmentos = useCallback(async (d: Destino): Promise<void> => {
    const partes: { ruta: string; silencioAntesSeg: number }[] = [];
    let pendiente = 0;
    for (let i = 0; i < silenciosRef.current.length; i++) {
      const ruta = unir(d.carpeta, `${d.base}.seg${i + 2}.part`);
      pendiente += silenciosRef.current[i];
      if ((await exists(ruta)) && (await tamanoArchivo(ruta)) > 0) {
        partes.push({ ruta, silencioAntesSeg: pendiente });
        pendiente = 0;
      } else if (await exists(ruta)) {
        await remove(ruta);
      }
    }
    if (partes.length === 0) {
      await rename(d.rutaParcial, d.rutaWebm);
      return;
    }
    const tramos: TramoAudio[] = [{ ruta: d.rutaParcial, silencioAntesSeg: 0 }, ...partes];
    try {
      await unirTramos(tramos, d.rutaWebm);
      for (const t of tramos) await remove(t.ruta);
    } catch (e) {
      const mensaje = e instanceof Error ? e.message : String(e);
      registrar("no se pudieron unir los tramos", mensaje);
      if (await exists(d.rutaWebm)) await remove(d.rutaWebm);
      await rename(d.rutaParcial, d.rutaWebm);
      setError(
        `El micrófono se cortó y no se pudieron unir los tramos de audio. Se guardó el primero; los demás quedaron en ${d.carpeta} (archivos .seg*.part).`,
      );
    }
  }, [registrar]);

  const detener = useCallback(async (): Promise<Grabacion | null> => {
    if (faseRef.current !== "grabando" && faseRef.current !== "pausado") return null;
    // Si hay una reasignación de clase/unidad en curso, hay que dejarla
    // terminar: si no, podríamos leer destinoRef.current a mitad del rename.
    // Desde acá nadie puede reabrir el micrófono a mitad del cierre.
    deteniendoRef.current = true;
    await reasignacionRef.current;

    const rec = recorderRef.current;
    const d = destinoRef.current;
    const meta = metaRef.current;
    if (!rec || !d || !meta) {
      deteniendoRef.current = false;
      // Sin destino no hay nada que guardar; dejar viva la paralela sería
      // dejar un whisper corriendo contra un archivo que ya no existe.
      void paralelaRef.current?.cancelar();
      paralelaRef.current = null;
      setParalela(null);
      return null;
    }

    const paralela = paralelaRef.current;
    // Queda en true cuando la transcripción paralela ya está trabajando sobre
    // la grabación guardada: a partir de ahí se apaga sola y no hay que
    // cancelarla en el `finally`.
    let entregada = false;

    if (faseRef.current === "grabando") {
      acumuladoMsRef.current += performance.now() - inicioTramoRef.current;
    }
    ponerFase("finalizando");

    const duracionSeg = acumuladoMsRef.current / 1000;

    try {
      // Esperamos el último ondataavailable antes de tocar el archivo.
      await new Promise<void>((resolver) => {
        rec.onstop = () => resolver();
        try {
          rec.stop();
        } catch {
          resolver();
        }
      });
      await colaRef.current;
      registrar(
        "cierre",
        `cronómetro=${duracionSeg.toFixed(1)} s; fragmentos=${chunksRef.current} (~${chunksRef.current * (TROZO_MS / 1000)} s de audio), vacíos=${vaciosRef.current}; bytes=${bytesRef.current}; último fragmento hace ${((performance.now() - ultimoChunkRef.current) / 1000).toFixed(1)} s; problemas=${[...problemasRef.current].join(",") || "ninguno"}; tramos=${silenciosRef.current.length + 1}; cortes=${silenciosRef.current.map((s) => s.toFixed(1)).join("/") || "-"}`,
      );
      await volcarLog();
      limpiarRecursos();

      // Nadie puede tener abierto el .part cuando se renombra.
      await paralela?.suspender();
      await unirSegmentos(d);
      if (await exists(d.rutaMetaParcial)) await remove(d.rutaMetaParcial);

      const grabacion: Grabacion = {
        id: meta.id,
        claseId: meta.claseId,
        unidadId: meta.unidadId,
        claseNombre: meta.claseNombre,
        unidadNombre: meta.unidadNombre,
        titulo: d.base,
        archivoAudio: d.rutaWebm,
        carpeta: d.carpeta,
        fechaISO: meta.fechaISO,
        duracionSeg,
        formato: "webm",
        bytes: await tamanoArchivo(d.rutaWebm),
        estado: "convirtiendo",
        errorConversion: null,
        tags: [],
        marcas: marcasRef.current,
        avisoAudio: mensajeReapertura(silenciosRef.current) ?? undefined,
        transcripcion: null,
        notaClase: "",
      };

      await agregarGrabacion(grabacion);
      await escribirMetaGrabacion(grabacion);

      if (paralela) {
        entregada = true;
        // La cola de la clase y la conversión van en serie, no en paralelo:
        // convertir borra el .webm al terminar y es justo el archivo del que
        // sale esa última ventana.
        void (async () => {
          let resultado: ResultadoTranscripcion | null = null;
          try {
            resultado = await paralela.finalizar(grabacion);
          } catch (e) {
            console.error("La transcripción en paralelo no se pudo cerrar", e);
          }
          if (paralelaRef.current === paralela) setParalela(null);

          if (!resultado) {
            // Se rindió a mitad de camino: la clase se transcribe después,
            // entera y por la cola de siempre. El audio no se tocó.
            setPendienteTranscripcion(grabacion);
            await convertir(grabacion, configRef.current.formatoAudio);
            return;
          }

          // `finalizar` ya dejó el .txt y el .segmentos.json en la carpeta:
          // acá solo se anota en el índice y en el .meta.json.
          const { transcripcion } = resultado;
          const conTexto = { ...grabacion, transcripcion };
          await actualizarGrabacion(grabacion.id, { transcripcion });
          await escribirMetaGrabacion(conTexto);
          // Se le pasa la versión con transcripción: `convertir` reescribe el
          // .meta.json a partir del objeto que recibe y borraría el dato.
          await convertir(conTexto, configRef.current.formatoAudio);
        })().finally(() => {
          // Recién acá deja de haber a quién cancelar: hasta ese momento
          // `detenerYCerrar` tiene que poder matar el whisper de la cola.
          if (paralelaRef.current === paralela) paralelaRef.current = null;
        });
      } else {
        // La conversión sigue por su cuenta: la app queda libre enseguida.
        // Sin transcripción paralela nada se encola solo: transcribir sigue
        // siendo una decisión del usuario desde la biblioteca.
        void convertir(grabacion, configRef.current.formatoAudio);
      }
      return grabacion;
    } catch (e) {
      setError(
        `La grabación se detuvo pero hubo un problema al guardarla: ${
          e instanceof Error ? e.message : String(e)
        }. El audio crudo sigue en ${d.rutaParcial}`,
      );
      return null;
    } finally {
      if (!entregada && paralela) {
        void paralela.cancelar();
        setParalela(null);
        paralelaRef.current = null;
      }
      limpiarRecursos();
      destinoRef.current = null;
      rutaEscrituraRef.current = null;
      metaRef.current = null;
      marcasRef.current = [];
      setDestino(null);
      setMarcas([]);
      setSegundos(0);
      setBytesEscritos(0);
      setSegundosEnSilencio(null);
      setAvisoAudio(null);
      problemasRef.current = new Set();
      silenciosRef.current = [];
      deteniendoRef.current = false;
      logRef.current = [];
      acumuladoMsRef.current = 0;
      ponerFase("inactivo");
    }
  }, [
    actualizarGrabacion,
    agregarGrabacion,
    convertir,
    limpiarRecursos,
    ponerFase,
    registrar,
    unirSegmentos,
    volcarLog,
  ]);

  // ------------------------------------------------------------------ marcas

  const marcar = useCallback(() => {
    if (faseRef.current !== "grabando" && faseRef.current !== "pausado") return;
    const marca: Marca = {
      id: nuevoId(),
      segundo: transcurridoMs() / 1000,
      nota: "",
    };
    marcasRef.current = [...marcasRef.current, marca];
    setMarcas(marcasRef.current);
    void guardarMetaParcial();
  }, [guardarMetaParcial, transcurridoMs]);

  const editarNotaMarca = useCallback(
    (id: string, nota: string) => {
      marcasRef.current = marcasRef.current.map((m) =>
        m.id === id ? { ...m, nota } : m,
      );
      setMarcas(marcasRef.current);
      void guardarMetaParcial();
    },
    [guardarMetaParcial],
  );

  const quitarMarca = useCallback(
    (id: string) => {
      marcasRef.current = marcasRef.current.filter((m) => m.id !== id);
      setMarcas(marcasRef.current);
      void guardarMetaParcial();
    },
    [guardarMetaParcial],
  );

  // ------------------------------------------------------- cierre de ventana

  useEffect(() => {
    let desuscribir: (() => void) | undefined;
    void (async () => {
      try {
        desuscribir = await getCurrentWindow().onCloseRequested((evento) => {
          if (faseRef.current !== "inactivo") {
            evento.preventDefault();
            setCierrePendiente(true);
          }
        });
      } catch (e) {
        console.warn("No se pudo interceptar el cierre de la ventana", e);
      }
    })();
    return () => desuscribir?.();
  }, []);

  const detenerYCerrar = useCallback(async () => {
    await detener();
    // La cola de la transcripción paralela sigue corriendo en segundo plano y
    // no va a alcanzar a terminar: sin esto, whisper-cli queda huérfano
    // comiendo CPU después de que la ventana ya no está. La grabación quedó
    // guardada igual y se puede transcribir desde la biblioteca.
    await paralelaRef.current?.cancelar();
    paralelaRef.current = null;
    setCierrePendiente(false);
    await getCurrentWindow().destroy();
  }, [detener]);

  // ------------------------------------------------------------ recuperación

  const recuperarInterrumpida = useCallback(
    async (i: GrabacionInterrumpida) => {
      try {
        const rutaWebm = unir(i.carpeta, `${i.base}.webm`);
        await rename(i.rutaParcial, rutaWebm);
        if (await exists(i.rutaMetaParcial)) await remove(i.rutaMetaParcial);

        const grabacion: Grabacion = {
          id: i.meta?.id ?? nuevoId(),
          claseId: i.meta?.claseId ?? null,
          unidadId: i.meta?.unidadId ?? null,
          claseNombre: i.meta?.claseNombre ?? SIN_CLASE,
          unidadNombre: i.meta?.unidadNombre ?? SIN_UNIDAD,
          titulo: i.base,
          archivoAudio: rutaWebm,
          carpeta: i.carpeta,
          fechaISO: i.meta?.fechaISO ?? new Date().toISOString(),
          duracionSeg: i.meta?.duracionSeg ?? 0,
          formato: "webm",
          bytes: await tamanoArchivo(rutaWebm),
          estado: "convirtiendo",
          errorConversion: null,
          tags: ["recuperada"],
          marcas: i.meta?.marcas ?? [],
          transcripcion: null,
          notaClase: "",
        };

        await agregarGrabacion(grabacion);
        await escribirMetaGrabacion(grabacion);
        void convertir(grabacion, configRef.current.formatoAudio);
        await refrescarInterrumpidas();
      } catch (e) {
        setError(
          `No se pudo recuperar la grabación: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    },
    [agregarGrabacion, convertir, refrescarInterrumpidas],
  );

  const descartarInterrumpidaGrabacion = useCallback(
    async (i: GrabacionInterrumpida) => {
      await descartarInterrumpida(i);
      await refrescarInterrumpidas();
    },
    [refrescarInterrumpidas],
  );

  useEffect(() => limpiarRecursos, [limpiarRecursos]);

  const consumirPendienteTranscripcion = useCallback(
    () => setPendienteTranscripcion(null),
    [],
  );

  const valor = useMemo<Grabador>(
    () => ({
      fase,
      segundos,
      bytesEscritos,
      marcas,
      destino,
      error,
      avisoEspacio,
      cierrePendiente,
      conversiones,
      interrumpidas,
      seleccion,
      moviendoDestino: moviendo,
      segundosEnSilencio,
      avisoAudio,
      paralela,
      pendienteTranscripcion,
      consumirPendienteTranscripcion,
      elegirClase,
      elegirUnidad,
      iniciar,
      pausar,
      reanudar,
      alternarPausa,
      detener,
      marcar,
      editarNotaMarca,
      quitarMarca,
      limpiarError: () => setError(null),
      limpiarAvisoEspacio: () => setAvisoEspacio(null),
      cancelarCierre: () => setCierrePendiente(false),
      detenerYCerrar,
      nivelActual,
      refrescarInterrumpidas,
      recuperarInterrumpida,
      descartarInterrumpidaGrabacion,
    }),
    [
      fase,
      segundos,
      bytesEscritos,
      marcas,
      destino,
      error,
      avisoEspacio,
      cierrePendiente,
      conversiones,
      interrumpidas,
      seleccion,
      moviendo,
      segundosEnSilencio,
      avisoAudio,
      paralela,
      pendienteTranscripcion,
      consumirPendienteTranscripcion,
      elegirClase,
      elegirUnidad,
      iniciar,
      pausar,
      reanudar,
      alternarPausa,
      detener,
      marcar,
      editarNotaMarca,
      quitarMarca,
      detenerYCerrar,
      nivelActual,
      refrescarInterrumpidas,
      recuperarInterrumpida,
      descartarInterrumpidaGrabacion,
    ],
  );

  return (
    <ContextoGrabador.Provider value={valor}>{children}</ContextoGrabador.Provider>
  );
}

export function useGrabador(): Grabador {
  const ctx = useContext(ContextoGrabador);
  if (!ctx) throw new Error("useGrabador debe usarse dentro de <ProveedorGrabador>");
  return ctx;
}
