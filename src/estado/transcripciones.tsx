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
import {
  ModalElegirMotor,
  type MotorElegido,
  type OpcionMotor,
} from "../components/ui/ModalElegirMotor";
import { useDescargaNube } from "../hooks/useDescargaNube";
import { escribirMetaGrabacion } from "../lib/grabaciones";
import {
  cancelarTranscripcion,
  transcribirGrabacion,
  type Etapa,
} from "../lib/transcripcion";
import {
  ErrorLimiteApi,
  ErrorTamanoApi,
  motorSinPreguntar,
  perfilPorId,
  perfilesUsables,
  transcribirConApi,
} from "../lib/transcripcionApi";
import type { Config, Grabacion } from "../types";
import { useStore } from "./store";
import type { ResultadoTranscripcion } from "../lib/transcripcion";

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

/** Local + cada perfil de API con clave configurada, para el modal de elección. */
function opcionesMotor(config: Config): OpcionMotor[] {
  const opciones: OpcionMotor[] = [
    { motor: { tipo: "local" }, etiqueta: "Motor local (offline, gratis, sin límite)" },
  ];
  const usables = perfilesUsables(config);
  for (const p of usables) {
    opciones.push({
      motor: { tipo: "api", perfilId: p.id },
      etiqueta: `${p.nombre} (más rápida/precisa, requiere internet)`,
    });
  }
  if (usables.length > 0) {
    opciones.push({
      motor: { tipo: "multiapi" },
      etiqueta: "Multi-API (prueba cada perfil en orden; si uno llega al límite, sigue con el próximo)",
    });
  }
  return opciones;
}

export function ProveedorTranscripciones({ children }: { children: ReactNode }) {
  const { config, actualizarConfig, actualizarGrabacion } = useStore();
  const [tareas, setTareas] = useState<Record<string, TareaTranscripcion>>({});
  const {
    estado: estadoDescarga,
    asegurar: asegurarAudio,
    confirmar: confirmarDescarga,
    cancelar: cancelarDescarga,
    cerrar: cerrarDescarga,
  } = useDescargaNube();

  const pendientesRef = useRef<{ grabacion: Grabacion; motor: MotorElegido }[]>([]);
  const corriendoRef = useRef(0);
  const configRef = useRef(config);

  // Elección de motor: se pregunta una vez por lote (o ninguna, si no hay
  // ningún perfil de API usable — ahí se va derecho al motor local).
  const [pedidoMotor, setPedidoMotor] = useState<Grabacion[] | null>(null);
  const bufferMotorRef = useRef<Grabacion[]>([]);
  // Modo "multi-API": índice del perfil en uso. Solo avanza si uno se queda
  // sin cupo (ErrorLimiteApi) y no se resetea solo: pensado para dejar la
  // cola corriendo de noche y que vaya rotando de clave sin frenarse.
  const perfilRotacionRef = useRef(0);

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

  /** Resuelve un motor elegido a una transcripción real, con sus fallbacks. */
  const ejecutarTranscripcion = useCallback(
    async (
      grabacion: Grabacion,
      motor: MotorElegido,
      onEtapa: (etapa: Etapa) => void,
    ): Promise<ResultadoTranscripcion> => {
      const config = configRef.current;

      if (motor.tipo === "local") {
        return transcribirGrabacion(grabacion, config, grabacion.id, onEtapa);
      }

      if (motor.tipo === "api") {
        const perfil = perfilPorId(config, motor.perfilId);
        if (!perfil) {
          throw new Error("El perfil de API elegido ya no existe. Vuelve a intentar.");
        }
        try {
          return await transcribirConApi(grabacion, perfil, config.idiomaTranscripcion, grabacion.id, onEtapa);
        } catch (e) {
          // El audio comprimido no entró en el límite de tamaño de la API:
          // en vez de fallar la transcripción entera, se sigue en local.
          if (!(e instanceof ErrorTamanoApi)) throw e;
          return transcribirGrabacion(grabacion, config, grabacion.id, onEtapa);
        }
      }

      // motor.tipo === "multiapi": prueba los perfiles en orden, desde donde
      // haya quedado la rotación la última vez que uno se quedó sin cupo.
      const perfiles = perfilesUsables(config);
      while (perfilRotacionRef.current < perfiles.length) {
        const perfil = perfiles[perfilRotacionRef.current];
        try {
          return await transcribirConApi(grabacion, perfil, config.idiomaTranscripcion, grabacion.id, onEtapa);
        } catch (e) {
          if (e instanceof ErrorLimiteApi) {
            console.warn(`"${perfil.nombre}" llegó al límite de uso: sigue con el próximo perfil.`);
            perfilRotacionRef.current += 1;
            continue;
          }
          if (!(e instanceof ErrorTamanoApi)) throw e;
          // Este audio en particular no entra por tamaño en ninguna API: va
          // directo a local en vez de probarlo con cada perfil que queda.
          break;
        }
      }
      return transcribirGrabacion(grabacion, config, grabacion.id, onEtapa);
    },
    [],
  );

  const procesar = useCallback(() => {
    const limite = Math.max(1, configRef.current.transcripcionesSimultaneas);

    while (corriendoRef.current < limite && pendientesRef.current.length > 0) {
      const pendiente = pendientesRef.current.shift();
      if (!pendiente) break;
      const { grabacion, motor } = pendiente;
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
          const onEtapa = (etapa: Etapa) =>
            actualizarTarea(grabacion.id, { estado: etapa });

          const { transcripcion } = await ejecutarTranscripcion(grabacion, motor, onEtapa);

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
  }, [actualizarGrabacion, actualizarTarea, asegurarAudio, ejecutarTranscripcion]);

  const agregarACola = useCallback(
    (grabacion: Grabacion, motor: MotorElegido) => {
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
      if (!pendientesRef.current.some((p) => p.grabacion.id === grabacion.id)) {
        pendientesRef.current.push({ grabacion, motor });
      }
      procesar();
    },
    [procesar],
  );

  const encolar = useCallback(
    (grabacion: Grabacion) => {
      // Con un predeterminado resuelto no se pregunta nada: si está puesta la
      // API, se encola con la API desde el principio.
      const motor = motorSinPreguntar(configRef.current);
      if (motor) {
        agregarACola(grabacion, motor);
        return;
      }
      // Un click de "transcribir todas" llama a encolar() en bucle, síncrono:
      // el buffer junta todo el lote antes de que el modal pida elegir una vez.
      bufferMotorRef.current.push(grabacion);
      setPedidoMotor([...bufferMotorRef.current]);
    },
    [agregarACola],
  );

  const elegirMotor = useCallback(
    (motor: MotorElegido, comoPredeterminado: boolean) => {
      const lote = bufferMotorRef.current;
      bufferMotorRef.current = [];
      setPedidoMotor(null);
      if (comoPredeterminado) {
        void actualizarConfig({ apiTranscripcion: { predeterminado: motor } });
      }
      for (const grabacion of lote) agregarACola(grabacion, motor);
    },
    [actualizarConfig, agregarACola],
  );

  const cancelarPedidoMotor = useCallback(() => {
    bufferMotorRef.current = [];
    setPedidoMotor(null);
  }, []);

  const cancelar = useCallback((grabacionId: string) => {
    pendientesRef.current = pendientesRef.current.filter(
      (p) => p.grabacion.id !== grabacionId,
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
      <ModalElegirMotor
        abierto={pedidoMotor !== null}
        opciones={opcionesMotor(config)}
        predeterminado={config.apiTranscripcion.predeterminado}
        onElegir={elegirMotor}
        onCancelar={cancelarPedidoMotor}
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
