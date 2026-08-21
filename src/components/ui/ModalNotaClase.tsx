import { useState } from "react";

interface Props {
  /** Clase · unidad de la grabación recién guardada, para dar contexto. */
  subtitulo: string;
  onGuardar(texto: string): void;
  onOmitir(): void;
}

/**
 * Se muestra al detener una grabación. "Guardar nota" y "Omitir" quedan al
 * mismo nivel a propósito: no hay que presionar al usuario a llenarla.
 */
export function ModalNotaClase({ subtitulo, onGuardar, onOmitir }: Props) {
  const [texto, setTexto] = useState("");

  return (
    <div className="modal-fondo" onClick={onOmitir}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Nota de la clase"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>¿Qué se conversó en esta clase?</h3>
        <p className="sutil">{subtitulo}</p>
        <textarea
          rows={5}
          autoFocus
          placeholder="Temas vistos, tareas para la próxima, dudas que quedaron…"
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
        />
        <div className="modal-acciones">
          <button className="btn" onClick={onOmitir}>
            Omitir
          </button>
          <button className="btn" onClick={() => onGuardar(texto.trim())}>
            Guardar nota
          </button>
        </div>
      </div>
    </div>
  );
}
