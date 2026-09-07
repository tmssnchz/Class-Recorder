/**
 * Corrección manual de las cuatro esquinas de la hoja.
 *
 * Es el plan B obligatorio, no un extra: la detección por contraste falla con
 * un mantel estampado o un escritorio del mismo color que el papel, y un
 * marcador estimado puede salir corrido. Sin esto, una foto mal detectada no
 * tendría arreglo.
 *
 * Las esquinas se guardan siempre en píxeles de la foto original; lo que se
 * dibuja acá está escalado al ancho que tenga el contenedor.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import type { Esquina } from "../../lib/escaneo";

const NOMBRES = ["superior izquierda", "superior derecha", "inferior derecha", "inferior izquierda"];

interface Props {
  /**
   * Ruta de la vista previa que devuelve el análisis, no la del archivo
   * original: viene con la orientación EXIF ya aplicada y en el mismo sistema
   * de coordenadas que las esquinas. Puede ser más chica que la foto — el
   * escalado se calcula contra `anchoFoto`, así que la proporción es lo único
   * que tiene que coincidir.
   */
  foto: string;
  anchoFoto: number;
  altoFoto: number;
  esquinas: Esquina[];
  onCambiar(esquinas: Esquina[]): void;
}

export function AjustarEsquinas({ foto, anchoFoto, altoFoto, esquinas, onCambiar }: Props) {
  const contenedor = useRef<HTMLDivElement>(null);
  const [escala, setEscala] = useState(1);
  const [arrastrando, setArrastrando] = useState<number | null>(null);

  // La escala depende del ancho real que termine teniendo el contenedor, así
  // que se mide después de montar y en cada resize de la ventana.
  useEffect(() => {
    const medir = () => {
      const ancho = contenedor.current?.clientWidth ?? 0;
      if (ancho > 0 && anchoFoto > 0) setEscala(ancho / anchoFoto);
    };
    medir();
    window.addEventListener("resize", medir);
    return () => window.removeEventListener("resize", medir);
  }, [anchoFoto]);

  const mover = useCallback(
    (indice: number, clienteX: number, clienteY: number) => {
      const caja = contenedor.current?.getBoundingClientRect();
      if (!caja) return;
      // Se limita al encuadre: una esquina fuera de la foto no aporta nada y
      // hace que la homografía devuelva un recorte con bordes vacíos.
      const x = Math.min(Math.max((clienteX - caja.left) / escala, 0), anchoFoto);
      const y = Math.min(Math.max((clienteY - caja.top) / escala, 0), altoFoto);
      onCambiar(esquinas.map((e, i) => (i === indice ? { x, y } : e)));
    },
    [altoFoto, anchoFoto, escala, esquinas, onCambiar],
  );

  useEffect(() => {
    if (arrastrando === null) return;
    const alMover = (e: PointerEvent) => mover(arrastrando, e.clientX, e.clientY);
    const alSoltar = () => setArrastrando(null);
    window.addEventListener("pointermove", alMover);
    window.addEventListener("pointerup", alSoltar);
    return () => {
      window.removeEventListener("pointermove", alMover);
      window.removeEventListener("pointerup", alSoltar);
    };
  }, [arrastrando, mover]);

  const puntos = esquinas.map((e) => `${e.x * escala},${e.y * escala}`).join(" ");

  return (
    <div className="ajustar-esquinas" ref={contenedor}>
      <img src={convertFileSrc(foto)} alt="Foto del apunte" draggable={false} />

      <svg
        className="capa-esquinas"
        width={anchoFoto * escala}
        height={altoFoto * escala}
        aria-hidden
      >
        <polygon points={puntos} />
      </svg>

      {esquinas.map((e, i) => (
        <button
          key={i}
          className={`tirador ${arrastrando === i ? "activo" : ""}`}
          style={{ left: e.x * escala, top: e.y * escala }}
          title={`Esquina ${NOMBRES[i]}`}
          aria-label={`Esquina ${NOMBRES[i]}`}
          onPointerDown={(ev) => {
            ev.preventDefault();
            setArrastrando(i);
          }}
          // También con teclado: arrastrar con el mouse no es la única forma
          // de ajustar un punto, y con la flecha se afina de a un píxel.
          onKeyDown={(ev) => {
            const paso = ev.shiftKey ? 20 : 2;
            const delta: Record<string, [number, number]> = {
              ArrowLeft: [-paso, 0],
              ArrowRight: [paso, 0],
              ArrowUp: [0, -paso],
              ArrowDown: [0, paso],
            };
            const d = delta[ev.key];
            if (!d) return;
            ev.preventDefault();
            onCambiar(
              esquinas.map((q, j) =>
                j === i
                  ? {
                      x: Math.min(Math.max(q.x + d[0], 0), anchoFoto),
                      y: Math.min(Math.max(q.y + d[1], 0), altoFoto),
                    }
                  : q,
              ),
            );
          }}
        />
      ))}
    </div>
  );
}
