import { useEffect, useRef, useState } from "react";

import { COLORES_CLASE } from "../../types";

interface Props {
  color: string;
  /** Colores ya tomados por otras clases, para marcarlos como repetidos. */
  usados: string[];
  onElegir(color: string): void;
  onCerrar(): void;
}

/**
 * Paleta de diez colores más un campo hexadecimal libre.
 *
 * Los colores ya usados por otra clase se marcan: en el calendario y en el
 * árbol, dos clases del mismo color son indistinguibles.
 */
export function SelectorColor({ color, usados, onElegir, onCerrar }: Props) {
  const [personalizado, setPersonalizado] = useState(color);
  const [error, setError] = useState<string | null>(null);
  const caja = useRef<HTMLDivElement | null>(null);

  // Cierra al hacer clic afuera o con Escape, como cualquier menú desplegable.
  useEffect(() => {
    const alClickear = (e: MouseEvent) => {
      if (caja.current && !caja.current.contains(e.target as Node)) onCerrar();
    };
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCerrar();
    };
    document.addEventListener("mousedown", alClickear);
    document.addEventListener("keydown", alTeclear);
    return () => {
      document.removeEventListener("mousedown", alClickear);
      document.removeEventListener("keydown", alTeclear);
    };
  }, [onCerrar]);

  const aplicarPersonalizado = () => {
    const valor = personalizado.trim().startsWith("#")
      ? personalizado.trim()
      : `#${personalizado.trim()}`;
    if (!/^#[0-9a-fA-F]{6}$/.test(valor)) {
      setError("Usa un hexadecimal de 6 dígitos, como #2f6fed.");
      return;
    }
    setError(null);
    onElegir(valor.toLowerCase());
  };

  return (
    <div className="selector-color" ref={caja} onClick={(e) => e.stopPropagation()}>
      <div className="paleta">
        {COLORES_CLASE.map((c) => {
          const enUso = usados.includes(c) && c !== color;
          return (
            <button
              key={c}
              className={`muestra ${c === color ? "elegido" : ""} ${enUso ? "en-uso" : ""}`}
              style={{ background: c }}
              title={enUso ? `${c} — ya lo usa otra clase` : c}
              onClick={() => onElegir(c)}
            />
          );
        })}
      </div>

      <div className="form-linea">
        <input
          value={personalizado}
          maxLength={7}
          placeholder="#2f6fed"
          onChange={(e) => setPersonalizado(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") aplicarPersonalizado();
          }}
        />
        <button className="btn btn-mini" onClick={aplicarPersonalizado}>
          Usar
        </button>
      </div>
      {error && <small className="error-inline">{error}</small>}
    </div>
  );
}
