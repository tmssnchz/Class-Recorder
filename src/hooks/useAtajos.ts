/**
 * Registra los atajos de grabación.
 *
 * Según `config.atajosGlobales` funcionan a nivel sistema (sirven con la app
 * minimizada, mediante el plugin global-shortcut) o solo mientras la ventana
 * tiene el foco. Si otra aplicación ya se quedó con la combinación, el registro
 * global falla y se devuelve el error para mostrarlo en Configuración.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  register,
  unregister,
} from "@tauri-apps/plugin-global-shortcut";

import { coincideAtajo, describirAtajo, escribiendoEnCampo } from "../lib/atajos";
import { useGrabador } from "../estado/grabador";
import { useStore } from "../estado/store";

type Accion = "grabar" | "pausar" | "detener" | "marcar";

export function useAtajos(): { erroresAtajos: string[] } {
  const { config } = useStore();
  const grabador = useGrabador();
  const [erroresAtajos, setErroresAtajos] = useState<string[]>([]);

  // El handler se lee desde una ref para que registrar/desregistrar no dependa
  // de que cambien las funciones del grabador en cada render.
  const grabadorRef = useRef(grabador);
  useEffect(() => {
    grabadorRef.current = grabador;
  }, [grabador]);

  const ejecutar = useCallback((accion: Accion) => {
    const g = grabadorRef.current;
    switch (accion) {
      case "grabar":
        if (g.fase === "inactivo") void g.iniciar();
        break;
      case "pausar":
        g.alternarPausa();
        break;
      case "detener":
        if (g.fase === "grabando" || g.fase === "pausado") void g.detener();
        break;
      case "marcar":
        g.marcar();
        break;
    }
  }, []);

  const { atajos, atajosGlobales } = config;

  // ------------------------------------------------------- modo local
  useEffect(() => {
    if (atajosGlobales) return;
    const alTeclear = (e: KeyboardEvent) => {
      if (escribiendoEnCampo(e.target)) return;
      const pares: [Accion, string][] = [
        ["grabar", atajos.grabar],
        ["pausar", atajos.pausar],
        ["detener", atajos.detener],
        ["marcar", atajos.marcar],
      ];
      for (const [accion, acelerador] of pares) {
        if (coincideAtajo(e, acelerador)) {
          e.preventDefault();
          ejecutar(accion);
          return;
        }
      }
    };
    window.addEventListener("keydown", alTeclear);
    return () => window.removeEventListener("keydown", alTeclear);
  }, [atajos, atajosGlobales, ejecutar]);

  // ------------------------------------------------------- modo global
  useEffect(() => {
    if (!atajosGlobales) {
      setErroresAtajos([]);
      return;
    }

    let vigente = true;
    const registrados: string[] = [];
    const pares: [Accion, string][] = [
      ["grabar", atajos.grabar],
      ["pausar", atajos.pausar],
      ["detener", atajos.detener],
      ["marcar", atajos.marcar],
    ];

    void (async () => {
      const fallos: string[] = [];
      for (const [accion, acelerador] of pares) {
        if (!acelerador) continue;
        try {
          await register(acelerador, (evento) => {
            // El plugin avisa al presionar y al soltar: solo interesa el primero.
            if (evento.state === "Released") return;
            ejecutar(accion);
          });
          if (!vigente) {
            // El efecto se limpió mientras registrábamos: deshacemos enseguida.
            await unregister(acelerador);
            return;
          }
          registrados.push(acelerador);
        } catch (e) {
          fallos.push(
            `${describirAtajo(acelerador)} (${accion}) ya está en uso por otro programa.`,
          );
          console.warn(`No se pudo registrar ${acelerador}`, e);
        }
      }
      if (vigente) setErroresAtajos(fallos);
    })();

    return () => {
      vigente = false;
      for (const acelerador of registrados) {
        void unregister(acelerador).catch(() => undefined);
      }
    };
  }, [atajos, atajosGlobales, ejecutar]);

  return { erroresAtajos };
}
