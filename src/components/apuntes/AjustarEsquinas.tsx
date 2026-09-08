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
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  /**
   * Cuartos de vuelta horarios con los que se muestra la foto. Es solo lo que
   * se ve: las esquinas se siguen guardando en coordenadas de la foto sin
   * girar, que es lo que espera el recorte.
   */
  giro?: number;
  esquinas: Esquina[];
  onCambiar(esquinas: Esquina[]): void;
}

export function AjustarEsquinas({
  foto,
  anchoFoto,
  altoFoto,
  giro = 0,
  esquinas,
  onCambiar,
}: Props) {
  const contenedor = useRef<HTMLDivElement>(null);
  const [escala, setEscala] = useState(0);
  const [arrastrando, setArrastrando] = useState<number | null>(null);

  // Con un cuarto de vuelta impar la foto se ve acostada: el lado que tiene que
  // entrar en el ancho del marco es el alto.
  const acostada = giro % 2 === 1;

  // La escala depende del ancho real que termine teniendo el contenedor, así
  // que se mide después de montar y en cada resize de la ventana. Antes de
  // pintar, y no después, porque el marco ya reserva alto: medir tarde deja un
  // salto visible.
  useLayoutEffect(() => {
    const medir = () => {
      const ancho = contenedor.current?.clientWidth ?? 0;
      const lado = acostada ? altoFoto : anchoFoto;
      if (ancho > 0 && lado > 0) setEscala(ancho / lado);
    };
    medir();
    window.addEventListener("resize", medir);
    return () => window.removeEventListener("resize", medir);
  }, [acostada, altoFoto, anchoFoto]);

  // Tamaño de la foto en pantalla, todavía sin girar.
  const ancho = anchoFoto * escala;
  const alto = altoFoto * escala;

  const mover = useCallback(
    (indice: number, clienteX: number, clienteY: number) => {
      const caja = contenedor.current?.getBoundingClientRect();
      if (!caja) return;
      const u = clienteX - caja.left;
      const v = clienteY - caja.top;
      // Deshace el giro con el que se está viendo la foto: el puntero cae sobre
      // la imagen girada, pero las esquinas se guardan sin girar.
      const [cx, cy] =
        giro === 1
          ? [v, alto - u]
          : giro === 2
            ? [ancho - u, alto - v]
            : giro === 3
              ? [ancho - v, u]
              : [u, v];
      // Se limita al encuadre: una esquina fuera de la foto no aporta nada y
      // hace que la homografía devuelva un recorte con bordes vacíos.
      const x = Math.min(Math.max(cx / escala, 0), anchoFoto);
      const y = Math.min(Math.max(cy / escala, 0), altoFoto);
      onCambiar(esquinas.map((e, i) => (i === indice ? { x, y } : e)));
    },
    [alto, altoFoto, ancho, anchoFoto, escala, esquinas, giro, onCambiar],
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

  // El giro se aplica a la capa entera —foto, polígono y tiradores— con el
  // origen en su esquina superior izquierda, así que hay que devolverla al
  // marco con una traslación.
  const transformacion = [
    "none",
    `translate(${alto}px, 0) rotate(90deg)`,
    `translate(${ancho}px, ${alto}px) rotate(180deg)`,
    `translate(0, ${ancho}px) rotate(270deg)`,
  ][giro % 4];

  return (
    <div
      className="ajustar-esquinas-marco"
      ref={contenedor}
      style={{ height: acostada ? ancho : alto }}
    >
      <div
        className="ajustar-esquinas"
        style={{ width: ancho, height: alto, transform: transformacion }}
      >
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
              // La flecha apunta a lo que se ve, no a los ejes de la foto: con la
              // foto girada hay que deshacer el giro también acá.
              const [du, dv] = d;
              const [dx, dy] =
                giro === 1
                  ? [dv, -du]
                  : giro === 2
                    ? [-du, -dv]
                    : giro === 3
                      ? [-dv, du]
                      : [du, dv];
              onCambiar(
                esquinas.map((q, j) =>
                  j === i
                    ? {
                        x: Math.min(Math.max(q.x + dx, 0), anchoFoto),
                        y: Math.min(Math.max(q.y + dy, 0), altoFoto),
                      }
                    : q,
                ),
              );
            }}
          />
        ))}
      </div>
    </div>
  );
}
