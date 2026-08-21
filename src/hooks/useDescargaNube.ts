/**
 * Antes de tocar un audio que puede estar en modo ahorro de espacio (un
 * placeholder de OneDrive), pregunta si se descarga y espera a que termine.
 * Se usa en cada punto que lee el archivo directo: reproducir, recortar y
 * transcribir. Nunca descarga sin que el usuario lo pida.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { esPlaceholder, hidratarArchivo } from "../lib/almacenamiento";

export interface EstadoDescargaNube {
  ruta: string;
  /** null mientras espera confirmar o si hubo error; con valor, va bajando. */
  progreso: { bytes: number; total: number } | null;
  error: string | null;
}

export function useDescargaNube() {
  const [estado, setEstado] = useState<EstadoDescargaNube | null>(null);
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);

  // Solo se suscribe mientras hay una descarga en curso, y solo a la ruta pedida.
  useEffect(() => {
    if (!estado || estado.progreso === null) return;
    const ruta = estado.ruta;
    const promesa = listen<{ tarea: string; bytes: number; total: number }>(
      "hidratacion://progreso",
      (e) => {
        if (e.payload.tarea !== ruta) return;
        setEstado((s) =>
          s ? { ...s, progreso: { bytes: e.payload.bytes, total: e.payload.total } } : s,
        );
      },
    );
    return () => {
      void promesa.then((quitar) => quitar());
    };
  }, [estado?.ruta, estado?.progreso === null]);

  /** Devuelve true si ya se puede leer el archivo: no era placeholder, o se descargó. */
  const asegurar = useCallback(async (ruta: string): Promise<boolean> => {
    const placeholder = await esPlaceholder(ruta).catch(() => false);
    if (!placeholder) return true;

    const confirmado = await new Promise<boolean>((resolver) => {
      resolverRef.current = resolver;
      setEstado({ ruta, progreso: null, error: null });
    });
    if (!confirmado) {
      setEstado(null);
      return false;
    }

    setEstado({ ruta, progreso: { bytes: 0, total: 1 }, error: null });
    try {
      await hidratarArchivo(ruta, ruta);
      setEstado(null);
      return true;
    } catch (e) {
      setEstado({ ruta, progreso: null, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }, []);

  const confirmar = useCallback(() => {
    resolverRef.current?.(true);
    resolverRef.current = null;
  }, []);

  const cancelar = useCallback(() => {
    resolverRef.current?.(false);
    resolverRef.current = null;
  }, []);

  const cerrar = useCallback(() => setEstado(null), []);

  return { estado, asegurar, confirmar, cancelar, cerrar };
}
