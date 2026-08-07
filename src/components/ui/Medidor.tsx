import { useEffect, useRef } from "react";

/**
 * Medidor de nivel de entrada. Se actualiza por requestAnimationFrame escribiendo
 * directo en el DOM: pasar esto por estado de React re-renderizaría el árbol
 * 60 veces por segundo durante toda la clase.
 */
export function Medidor({
  leer,
  activo,
}: {
  leer: () => number;
  activo: boolean;
}) {
  const barraRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activo) {
      if (barraRef.current) barraRef.current.style.width = "0%";
      return;
    }
    let raf = 0;
    let suavizado = 0;
    const tick = () => {
      // Promedio móvil: sin esto la barra tiembla y marea.
      suavizado = suavizado * 0.75 + leer() * 0.25;
      if (barraRef.current) {
        barraRef.current.style.width = `${Math.round(suavizado * 100)}%`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [activo, leer]);

  return (
    <div className="medidor" aria-hidden="true">
      <div ref={barraRef} className="medidor-nivel" />
    </div>
  );
}
