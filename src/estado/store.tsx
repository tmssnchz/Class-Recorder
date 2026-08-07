/**
 * Estado global de la app: la base de datos JSON y la configuración.
 * Toda mutación actualiza el estado en memoria y persiste a disco en cola.
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

import {
  cargarConfig,
  cargarDatos,
  enCola,
  guardarConfig,
  guardarDatos,
} from "../lib/almacen";
import { reconciliarConDisco } from "../lib/grabaciones";
import {
  BASE_DATOS_VACIA,
  COLORES_CLASE,
  CONFIG_POR_DEFECTO,
  type Atajos,
  type BaseDatos,
  type Clase,
  type Config,
  type Grabacion,
  type Unidad,
} from "../types";

export function nuevoId(): string {
  return crypto.randomUUID();
}

/** Los atajos se pueden actualizar de a uno sin repetir los otros tres. */
export type CambiosConfig = Partial<Omit<Config, "atajos">> & {
  atajos?: Partial<Atajos>;
};

interface Store {
  datos: BaseDatos;
  config: Config;
  cargando: boolean;
  error: string | null;

  // Clases y unidades
  agregarClase(nombre: string): Promise<Clase>;
  renombrarClase(claseId: string, nombre: string): Promise<void>;
  eliminarClase(claseId: string): Promise<void>;
  agregarUnidad(claseId: string, nombre: string): Promise<Unidad>;
  renombrarUnidad(
    claseId: string,
    unidadId: string,
    nombre: string,
  ): Promise<void>;
  eliminarUnidad(claseId: string, unidadId: string): Promise<void>;

  // Grabaciones (se usan a partir del módulo de grabación)
  agregarGrabacion(grabacion: Grabacion): Promise<void>;
  actualizarGrabacion(id: string, cambios: Partial<Grabacion>): Promise<void>;
  quitarGrabacion(id: string): Promise<void>;

  actualizarConfig(cambios: CambiosConfig): Promise<void>;
  recargar(): Promise<void>;
}

const ContextoStore = createContext<Store | null>(null);

export function ProveedorStore({ children }: { children: ReactNode }) {
  const [datos, setDatos] = useState<BaseDatos>(BASE_DATOS_VACIA);
  const [config, setConfig] = useState<Config>(CONFIG_POR_DEFECTO);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Espejo del estado para poder mutar sin depender del closure de React.
  const datosRef = useRef(datos);
  const configRef = useRef(config);

  const recargar = useCallback(async () => {
    setCargando(true);
    try {
      const [cargados, c] = await Promise.all([cargarDatos(), cargarConfig()]);
      // Repara el índice contra lo que realmente hay en disco: si alguna
      // grabación quedó guardada como archivo pero no llegó a entrar en
      // datos.json (un cierre abrupto, por ejemplo), acá se recupera sola.
      let d = cargados;
      try {
        d = await reconciliarConDisco(cargados, c.carpetaRaiz);
        if (d !== cargados) await guardarDatos(d);
      } catch (e) {
        console.warn("No se pudo reconciliar la biblioteca con el disco", e);
      }
      datosRef.current = d;
      configRef.current = c;
      setDatos(d);
      setConfig(c);
      setError(null);
    } catch (e) {
      console.error(e);
      setError(
        `No se pudieron leer los datos guardados: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void recargar();
  }, [recargar]);

  const mutarDatos = useCallback(
    async (fn: (previo: BaseDatos) => BaseDatos) => {
      const siguiente = fn(datosRef.current);
      datosRef.current = siguiente;
      setDatos(siguiente);
      try {
        await enCola(() => guardarDatos(siguiente));
      } catch (e) {
        console.error(e);
        setError(
          `No se pudo guardar en disco: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        throw e;
      }
    },
    [],
  );

  const actualizarConfig = useCallback(async (cambios: CambiosConfig) => {
    const siguiente: Config = {
      ...configRef.current,
      ...cambios,
      atajos: { ...configRef.current.atajos, ...(cambios.atajos ?? {}) },
    };
    configRef.current = siguiente;
    setConfig(siguiente);
    await enCola(() => guardarConfig(siguiente));
  }, []);

  // ------------------------------------------------------------- clases

  const agregarClase = useCallback(
    async (nombre: string) => {
      const limpio = nombre.trim();
      if (!limpio) throw new Error("El nombre de la clase no puede estar vacío.");
      if (
        datosRef.current.clases.some(
          (c) => c.nombre.toLowerCase() === limpio.toLowerCase(),
        )
      ) {
        throw new Error(`Ya existe una clase llamada "${limpio}".`);
      }
      const clase: Clase = {
        id: nuevoId(),
        nombre: limpio,
        color: COLORES_CLASE[datosRef.current.clases.length % COLORES_CLASE.length],
        creadaEn: new Date().toISOString(),
        unidades: [],
      };
      await mutarDatos((d) => ({ ...d, clases: [...d.clases, clase] }));
      return clase;
    },
    [mutarDatos],
  );

  const renombrarClase = useCallback(
    async (claseId: string, nombre: string) => {
      const limpio = nombre.trim();
      if (!limpio) throw new Error("El nombre de la clase no puede estar vacío.");
      if (
        datosRef.current.clases.some(
          (c) => c.id !== claseId && c.nombre.toLowerCase() === limpio.toLowerCase(),
        )
      ) {
        throw new Error(`Ya existe una clase llamada "${limpio}".`);
      }
      await mutarDatos((d) => ({
        ...d,
        clases: d.clases.map((c) => (c.id === claseId ? { ...c, nombre: limpio } : c)),
      }));
    },
    [mutarDatos],
  );

  /**
   * Elimina la clase del índice. Los archivos de audio ya grabados NO se tocan:
   * siguen en disco, solo dejan de listarse en la biblioteca.
   */
  const eliminarClase = useCallback(
    async (claseId: string) => {
      await mutarDatos((d) => ({
        ...d,
        clases: d.clases.filter((c) => c.id !== claseId),
        grabaciones: d.grabaciones.filter((g) => g.claseId !== claseId),
      }));
    },
    [mutarDatos],
  );

  const agregarUnidad = useCallback(
    async (claseId: string, nombre: string) => {
      const limpio = nombre.trim();
      if (!limpio) throw new Error("El nombre de la unidad no puede estar vacío.");
      const clase = datosRef.current.clases.find((c) => c.id === claseId);
      if (!clase) throw new Error("La clase ya no existe.");
      if (
        clase.unidades.some((u) => u.nombre.toLowerCase() === limpio.toLowerCase())
      ) {
        throw new Error(`"${clase.nombre}" ya tiene una unidad llamada "${limpio}".`);
      }
      const unidad: Unidad = {
        id: nuevoId(),
        nombre: limpio,
        creadaEn: new Date().toISOString(),
      };
      await mutarDatos((d) => ({
        ...d,
        clases: d.clases.map((c) =>
          c.id === claseId ? { ...c, unidades: [...c.unidades, unidad] } : c,
        ),
      }));
      return unidad;
    },
    [mutarDatos],
  );

  const renombrarUnidad = useCallback(
    async (claseId: string, unidadId: string, nombre: string) => {
      const limpio = nombre.trim();
      if (!limpio) throw new Error("El nombre de la unidad no puede estar vacío.");
      const clase = datosRef.current.clases.find((c) => c.id === claseId);
      if (
        clase?.unidades.some(
          (u) => u.id !== unidadId && u.nombre.toLowerCase() === limpio.toLowerCase(),
        )
      ) {
        throw new Error(`"${clase.nombre}" ya tiene una unidad llamada "${limpio}".`);
      }
      await mutarDatos((d) => ({
        ...d,
        clases: d.clases.map((c) =>
          c.id === claseId
            ? {
                ...c,
                unidades: c.unidades.map((u) =>
                  u.id === unidadId ? { ...u, nombre: limpio } : u,
                ),
              }
            : c,
        ),
      }));
    },
    [mutarDatos],
  );

  const eliminarUnidad = useCallback(
    async (claseId: string, unidadId: string) => {
      await mutarDatos((d) => ({
        ...d,
        clases: d.clases.map((c) =>
          c.id === claseId
            ? { ...c, unidades: c.unidades.filter((u) => u.id !== unidadId) }
            : c,
        ),
        grabaciones: d.grabaciones.filter((g) => g.unidadId !== unidadId),
      }));
    },
    [mutarDatos],
  );

  // -------------------------------------------------------- grabaciones

  const agregarGrabacion = useCallback(
    async (grabacion: Grabacion) => {
      await mutarDatos((d) => ({
        ...d,
        grabaciones: [grabacion, ...d.grabaciones],
      }));
    },
    [mutarDatos],
  );

  const actualizarGrabacion = useCallback(
    async (id: string, cambios: Partial<Grabacion>) => {
      await mutarDatos((d) => ({
        ...d,
        grabaciones: d.grabaciones.map((g) =>
          g.id === id ? { ...g, ...cambios } : g,
        ),
      }));
    },
    [mutarDatos],
  );

  const quitarGrabacion = useCallback(
    async (id: string) => {
      await mutarDatos((d) => ({
        ...d,
        grabaciones: d.grabaciones.filter((g) => g.id !== id),
      }));
    },
    [mutarDatos],
  );

  const valor = useMemo<Store>(
    () => ({
      datos,
      config,
      cargando,
      error,
      agregarClase,
      renombrarClase,
      eliminarClase,
      agregarUnidad,
      renombrarUnidad,
      eliminarUnidad,
      agregarGrabacion,
      actualizarGrabacion,
      quitarGrabacion,
      actualizarConfig,
      recargar,
    }),
    [
      datos,
      config,
      cargando,
      error,
      agregarClase,
      renombrarClase,
      eliminarClase,
      agregarUnidad,
      renombrarUnidad,
      eliminarUnidad,
      agregarGrabacion,
      actualizarGrabacion,
      quitarGrabacion,
      actualizarConfig,
      recargar,
    ],
  );

  return <ContextoStore.Provider value={valor}>{children}</ContextoStore.Provider>;
}

export function useStore(): Store {
  const ctx = useContext(ContextoStore);
  if (!ctx) throw new Error("useStore debe usarse dentro de <ProveedorStore>");
  return ctx;
}
