/**
 * Cola de reconocimiento de apuntes.
 *
 * Mismo patrón que la cola de transcripciones: vive por encima de las
 * pestañas para que una hoja larga siga procesándose aunque cambies de vista.
 * La unidad de trabajo es la **página**, no el apunte: un cuaderno de diez
 * hojas se ve avanzar hoja por hoja en vez de quedarse veinte minutos en
 * "procesando".
 *
 * De a una por vez a propósito: el modelo local ocupa varios GB de RAM y dos
 * en paralelo en un portátil terminan tardando más que en serie.
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
import { listen } from "@tauri-apps/api/event";

import { esSoloVisual } from "../lib/escaneo";
import { guardarTexto, reconocerConApi, reconocerLocal, type EtapaHtr } from "../lib/htr";
import { perfilesUsables } from "../lib/transcripcionApi";
import type { Apunte, MotorHtr, PaginaApunte } from "../types";
import { useStore } from "./store";

export interface TareaApunte {
  /** `${apunteId}:${paginaId}` — la clave con la que se cancela en Rust. */
  id: string;
  apunteId: string;
  paginaId: string;
  titulo: string;
  numero: number;
  estado: EtapaHtr;
  error?: string;
}

interface ColaApuntes {
  tareas: Record<string, TareaApunte>;
  /** Encola las páginas que todavía no tienen texto reconocido. */
  encolar(apunte: Apunte, soloPendientes?: boolean): void;
  /** Vuelve a reconocer una página concreta, pisando lo que hubiera. */
  reencolar(apunte: Apunte, pagina: PaginaApunte): void;
  descartarError(id: string): void;
  /** Vacía la cola. Lo que ya se reconoció queda guardado. */
  cancelarTodo(): void;
  /** Cuántas páginas quedan por procesar, para el indicador de la pestaña. */
  pendientes: number;
}

const Contexto = createContext<ColaApuntes | null>(null);

export const claveTarea = (apunteId: string, paginaId: string) => `${apunteId}:${paginaId}`;

export function ProveedorApuntes({ children }: { children: ReactNode }) {
  const { config, actualizarApunte } = useStore();
  const [tareas, setTareas] = useState<Record<string, TareaApunte>>({});

  const pendientesRef = useRef<{ apunte: Apunte; pagina: PaginaApunte }[]>([]);
  const corriendoRef = useRef(false);
  const configRef = useRef(config);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  const actualizarTarea = useCallback((id: string, cambios: Partial<TareaApunte>) => {
    setTareas((t) => (t[id] ? { ...t, [id]: { ...t[id], ...cambios } } : t));
  }, []);

  // El motor local informa etapas, no porcentaje: no hay forma honesta de
  // mostrar una barra de avance dentro de una sola hoja.
  useEffect(() => {
    const promesa = listen<{ tarea: string; etapa: string }>("htr://progreso", (evento) => {
      actualizarTarea(evento.payload.tarea, { estado: evento.payload.etapa as EtapaHtr });
    });
    return () => {
      void promesa.then((quitar) => quitar());
    };
  }, [actualizarTarea]);

  /** Resuelve qué motor usar según la config, con su fallback a local. */
  const reconocer = useCallback(
    async (pagina: PaginaApunte, tarea: string): Promise<{ texto: string; motor: MotorHtr }> => {
      const conf = configRef.current;

      if (conf.apuntes.motor === "api") {
        const perfiles = perfilesUsables(conf);
        const pre = conf.apiTranscripcion.predeterminado;
        const perfil =
          (pre.tipo === "api" && perfiles.find((p) => p.id === pre.perfilId)) || perfiles[0];
        if (!perfil) {
          throw new Error(
            "El motor de apuntes está puesto en API pero no hay ningún perfil con clave configurada.",
          );
        }
        return {
          texto: await reconocerConApi(pagina, perfil, conf.apuntes.idioma),
          motor: "api",
        };
      }

      return {
        texto: await reconocerLocal(pagina, conf, tarea),
        motor: conf.apuntes.modelo,
      };
    },
    [],
  );

  const procesar = useCallback(() => {
    if (corriendoRef.current) return;
    const siguiente = pendientesRef.current.shift();
    if (!siguiente) return;

    corriendoRef.current = true;
    const { apunte, pagina } = siguiente;
    const id = claveTarea(apunte.id, pagina.id);

    void (async () => {
      try {
        const { texto, motor } = await reconocer(pagina, id);

        const paginas = apunte.paginas.map((p) =>
          p.id === pagina.id
            ? { ...p, texto, motorHtr: motor, soloVisual: esSoloVisual(texto) }
            : p,
        );
        const actualizado = { ...apunte, paginas };
        const archivoTexto = await guardarTexto(actualizado);
        await actualizarApunte(apunte.id, { paginas, archivoTexto });

        // Las páginas que quedan en la cola son de este mismo apunte y traen
        // una copia vieja: se refrescan para no pisar lo recién reconocido.
        pendientesRef.current = pendientesRef.current.map((p) =>
          p.apunte.id === apunte.id ? { ...p, apunte: { ...actualizado, archivoTexto } } : p,
        );

        setTareas((t) => {
          const copia = { ...t };
          delete copia[id];
          return copia;
        });
      } catch (e) {
        const mensaje = e instanceof Error ? e.message : String(e);
        console.error("Reconocimiento fallido:", mensaje);
        actualizarTarea(id, { estado: "error", error: mensaje });
      } finally {
        corriendoRef.current = false;
        procesar();
      }
    })();
  }, [actualizarApunte, actualizarTarea, reconocer]);

  const agregar = useCallback(
    (apunte: Apunte, paginas: PaginaApunte[]) => {
      if (paginas.length === 0) return;

      setTareas((t) => {
        const copia = { ...t };
        for (const pagina of paginas) {
          const id = claveTarea(apunte.id, pagina.id);
          if (copia[id] && copia[id].estado !== "error") continue;
          copia[id] = {
            id,
            apunteId: apunte.id,
            paginaId: pagina.id,
            titulo: apunte.titulo,
            numero: pagina.numero,
            estado: "esperando",
          };
        }
        return copia;
      });

      for (const pagina of paginas) {
        const yaEsta = pendientesRef.current.some(
          (p) => p.apunte.id === apunte.id && p.pagina.id === pagina.id,
        );
        if (!yaEsta) pendientesRef.current.push({ apunte, pagina });
      }
      procesar();
    },
    [procesar],
  );

  const encolar = useCallback(
    (apunte: Apunte, soloPendientes = true) => {
      const paginas = soloPendientes
        ? apunte.paginas.filter((p) => p.motorHtr === null)
        : // Las que el usuario ya corrigió a mano no se pisan nunca: rehacer
          // el reconocimiento no debe borrar una corrección.
          apunte.paginas.filter((p) => !p.textoEditado);
      agregar(apunte, [...paginas].sort((a, b) => a.numero - b.numero));
    },
    [agregar],
  );

  const reencolar = useCallback(
    (apunte: Apunte, pagina: PaginaApunte) => agregar(apunte, [pagina]),
    [agregar],
  );

  const descartarError = useCallback((id: string) => {
    setTareas((t) => {
      const copia = { ...t };
      delete copia[id];
      return copia;
    });
  }, []);

  const cancelarTodo = useCallback(() => {
    // Lo que está corriendo ahora mismo termina igual: matar el proceso a mitad
    // dejaría la página sin texto y sin aviso. Se vacía lo que espera, que es
    // lo que de verdad tarda una hora.
    pendientesRef.current = [];
    setTareas((t) => {
      const copia: typeof t = {};
      for (const [id, tarea] of Object.entries(t)) {
        if (tarea.estado === "cargando" || tarea.estado === "leyendo") copia[id] = tarea;
      }
      return copia;
    });
  }, []);

  const valor = useMemo<ColaApuntes>(
    () => ({
      tareas,
      encolar,
      reencolar,
      descartarError,
      cancelarTodo,
      pendientes: Object.values(tareas).filter((t) => t.estado !== "error").length,
    }),
    [tareas, encolar, reencolar, descartarError, cancelarTodo],
  );

  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>;
}

export function useApuntes(): ColaApuntes {
  const ctx = useContext(Contexto);
  if (!ctx) throw new Error("useApuntes debe usarse dentro de <ProveedorApuntes>");
  return ctx;
}
