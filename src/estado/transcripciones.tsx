/**
 * Cola de transcripciones.
 *
 * Vive por encima de las pestañas para que una transcripción larga siga
 * corriendo aunque cambies de vista. Cuántas corren a la vez lo decide
 * `config.transcripcionesSimultaneas`.
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

import { ModalDescargaNube } from "../components/ui/ModalDescargaNube";
import { useDescargaNube } from "../hooks/useDescargaNube";
import { escribirMetaGrabacion } from "../lib/grabaciones";
import {
  cancelarTranscripcion,
  transcribirGrabacion,
  type Etapa,
} from "../lib/transcripcion";
import type { Grabacion } from "../types";
import { useStore } from "./store";

export type EstadoTarea = "esperando" | Etapa | "error";

export interface TareaTranscripcion {
  grabacionId: string;
  titulo: string;
  estado: EstadoTarea;
  porcentaje: number;
  error?: string;
}

interface Cola {
  tareas: Record<string, TareaTranscripcion>;
  encolar(grabacion: Grabacion): void;
  cancelar(grabacionId: string): void;
  descartarError(grabacionId: string): void;
}

const ContextoCola = createContext<Cola | null>(null);

export function ProveedorTranscripciones({ children }: { children: ReactNode }) {
  const { config, actualizarGrabacion } = useStore();
  const [tareas, setTareas] = useState<Record<string, TareaTranscripcion>>({});
  const {
    estado: estadoDescarga,
    asegurar: asegurarAudio,
    confirmar: confirmarDescarga,
    cancelar: cancelarDescarga,
    cerrar: cerrarDescarga,
  } = useDescargaNube();

  const pendientesRef = useRef<Grabacion[]>([]);
  const corriendoRef = useRef(0);
  const configRef = useRef(config);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  const actualizarTarea = useCallback(
    (id: string, cambios: Partial<TareaTranscripcion>) => {
      setTareas((t) =>
        t[id] ? { ...t, [id]: { ...t[id], ...cambios } } : t,
      );
    },
    [],
  );

  // whisper informa el avance por eventos desde Rust.
  useEffect(() => {
    const promesa = listen<{ tarea: string; porcentaje: number }>(
      "transcripcion://progreso",
      (evento) => {
        actualizarTarea(evento.payload.tarea, {
          porcentaje: evento.payload.porcentaje,
        });
      },
    );
    return () => {
      void promesa.then((quitar) => quitar());
    };
  }, [actualizarTarea]);

  const procesar = useCallback(() => {
    const limite = Math.max(1, configRef.current.transcripcionesSimultaneas);

    while (corriendoRef.current < limite && pendientesRef.current.length > 0) {
      const grabacion = pendientesRef.current.shift();
      if (!grabacion) break;
      corriendoRef.current += 1;

      void (async () => {
        try {
          if (!(await asegurarAudio(grabacion.archivoAudio))) {
            setTareas((t) => {
              const copia = { ...t };
              delete copia[grabacion.id];
              return copia;
            });
            return;
          }
          const { transcripcion } = await transcribirGrabacion(
            grabacion,
            configRef.current,
            grabacion.id,
            (etapa) => actualizarTarea(grabacion.id, { estado: etapa }),
          );

          await actualizarGrabacion(grabacion.id, { transcripcion });
          await escribirMetaGrabacion({ ...grabacion, transcripcion });

          setTareas((t) => {
            const copia = { ...t };
            delete copia[grabacion.id];
            return copia;
          });
        } catch (e) {
          const mensaje = e instanceof Error ? e.message : String(e);
          console.error("Transcripción fallida:", mensaje);
          actualizarTarea(grabacion.id, { estado: "error", error: mensaje });
        } finally {
          corriendoRef.current -= 1;
          procesar();
        }
      })();
    }
  }, [actualizarGrabacion, actualizarTarea, asegurarAudio]);

  const encolar = useCallback(
    (grabacion: Grabacion) => {
      setTareas((t) => {
        if (t[grabacion.id] && t[grabacion.id].estado !== "error") return t;
        return {
          ...t,
          [grabacion.id]: {
            grabacionId: grabacion.id,
            titulo: grabacion.titulo,
            estado: "esperando",
            porcentaje: 0,
          },
        };
      });
      // Si ya estaba en cola no se duplica.
      if (!pendientesRef.current.some((g) => g.id === grabacion.id)) {
        pendientesRef.current.push(grabacion);
      }
      procesar();
    },
    [procesar],
  );

  const cancelar = useCallback((grabacionId: string) => {
    pendientesRef.current = pendientesRef.current.filter(
      (g) => g.id !== grabacionId,
    );
    void cancelarTranscripcion(grabacionId).catch(() => undefined);
    setTareas((t) => {
      const copia = { ...t };
      delete copia[grabacionId];
      return copia;
    });
  }, []);

  const descartarError = useCallback((grabacionId: string) => {
    setTareas((t) => {
      const copia = { ...t };
      delete copia[grabacionId];
      return copia;
    });
  }, []);

  const valor = useMemo<Cola>(
    () => ({ tareas, encolar, cancelar, descartarError }),
    [tareas, encolar, cancelar, descartarError],
  );

  return (
    <ContextoCola.Provider value={valor}>
      {children}
      <ModalDescargaNube
        estado={estadoDescarga}
        onConfirmar={confirmarDescarga}
        onCancelar={cancelarDescarga}
        onCerrar={cerrarDescarga}
      />
    </ContextoCola.Provider>
  );
}

export function useTranscripciones(): Cola {
  const ctx = useContext(ContextoCola);
  if (!ctx)
    throw new Error(
      "useTranscripciones debe usarse dentro de <ProveedorTranscripciones>",
    );
  return ctx;
}
