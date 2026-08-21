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
import { exists, remove, rename, writeFile } from "@tauri-apps/plugin-fs";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { convertirAudio } from "../lib/audio";
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
        setMoviendo(true);
        try {
          // Se encola detrás de las escrituras de audio pendientes: el rename
          // no puede pisar un chunk que todavía se está apendeando.
          const raiz = raizDeClase(datosRef.current.grabaciones, claseId, cfg.carpetaRaiz);
          const tarea = colaRef.current.then(() =>
            moverDestino(d, raiz, new Date(meta.fechaISO), claseNombre, unidadNombre),
          );
          colaRef.current = tarea.then(() => undefined).catch(() => undefined);

          const nuevo = await tarea;
          destinoRef.current = nuevo;
          rutaEscrituraRef.current = nuevo.rutaParcial;
          setDestino(nuevo);

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
          setMoviendo(false);
        }
      });
    },
    [transcurridoMs],
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
        const cambios = {
          archivoAudio: salida,
          formato,
          bytes,
          estado: "listo" as const,
          errorConversion: null,
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
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: cfg.microfonoId ? { exact: cfg.microfonoId } : undefined,
            channelCount: 1,
            echoCancellation: false,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
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
        ctx.createMediaStreamSource(stream).connect(analizador);
        audioCtxRef.current = ctx;
        analizadorRef.current = analizador;
        bufferNivelRef.current = new Uint8Array(new ArrayBuffer(analizador.fftSize));

        // 5. MediaRecorder.
        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm";
        const rec = new MediaRecorder(stream, {
          mimeType,
          audioBitsPerSecond: 64000,
        });
        rec.ondataavailable = (evento) => {
          if (!evento.data || evento.data.size === 0) return;
          const blob = evento.data;
          colaRef.current = colaRef.current
            .then(async () => {
              const bytes = new Uint8Array(await blob.arrayBuffer());
              // Se lee en cada chunk: si hubo una reasignación de clase/unidad
              // de por medio, ya apunta al archivo movido.
              await writeFile(rutaEscrituraRef.current ?? d.rutaParcial, bytes, {
                append: true,
              });
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
          setError(`Error del grabador: ${String((evento as ErrorEvent).error)}`);
        };
        recorderRef.current = rec;

        marcasRef.current = [];
        setMarcas([]);
        bytesRef.current = 0;
        setBytesEscritos(0);
        acumuladoMsRef.current = 0;
        inicioTramoRef.current = performance.now();
        ultimaMetaRef.current = performance.now();

        rec.start(TROZO_MS);
        ponerFase("grabando");
        setSegundos(0);
        ultimoSonidoRef.current = performance.now();
        setSegundosEnSilencio(null);

        intervaloRef.current = window.setInterval(() => {
          setSegundos(transcurridoMs() / 1000);
          setBytesEscritos(bytesRef.current);

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
      guardarMetaParcial,
      limpiarRecursos,
      nivelActual,
      ponerFase,
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
    void guardarMetaParcial();
  }, [guardarMetaParcial, ponerFase]);

  const reanudar = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || faseRef.current !== "pausado") return;
    inicioTramoRef.current = performance.now();
    rec.resume();
    ponerFase("grabando");
  }, [ponerFase]);

  const alternarPausa = useCallback(() => {
    if (faseRef.current === "grabando") pausar();
    else if (faseRef.current === "pausado") reanudar();
  }, [pausar, reanudar]);

  const detener = useCallback(async (): Promise<Grabacion | null> => {
    if (faseRef.current !== "grabando" && faseRef.current !== "pausado") return null;
    // Si hay una reasignación de clase/unidad en curso, hay que dejarla
    // terminar: si no, podríamos leer destinoRef.current a mitad del rename.
    await reasignacionRef.current;

    const rec = recorderRef.current;
    const d = destinoRef.current;
    const meta = metaRef.current;
    if (!rec || !d || !meta) return null;

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
      limpiarRecursos();

      await rename(d.rutaParcial, d.rutaWebm);
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
        transcripcion: null,
        notaClase: "",
      };

      await agregarGrabacion(grabacion);
      await escribirMetaGrabacion(grabacion);

      // La conversión sigue por su cuenta: la app queda libre enseguida.
      void convertir(grabacion, configRef.current.formatoAudio);
      return grabacion;
    } catch (e) {
      setError(
        `La grabación se detuvo pero hubo un problema al guardarla: ${
          e instanceof Error ? e.message : String(e)
        }. El audio crudo sigue en ${d.rutaParcial}`,
      );
      return null;
    } finally {
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
      acumuladoMsRef.current = 0;
      ponerFase("inactivo");
    }
  }, [agregarGrabacion, convertir, limpiarRecursos, ponerFase]);

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
