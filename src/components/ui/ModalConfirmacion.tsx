import { useEffect } from "react";

interface Props {
  abierto: boolean;
  titulo: string;
  mensaje: React.ReactNode;
  textoConfirmar?: string;
  peligroso?: boolean;
  onConfirmar: () => void;
  onCancelar: () => void;
}

export function ModalConfirmacion({
  abierto,
  titulo,
  mensaje,
  textoConfirmar = "Confirmar",
  peligroso = false,
  onConfirmar,
  onCancelar,
}: Props) {
  useEffect(() => {
    if (!abierto) return;
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancelar();
    };
    window.addEventListener("keydown", alTeclear);
    return () => window.removeEventListener("keydown", alTeclear);
  }, [abierto, onCancelar]);

  if (!abierto) return null;

  return (
    <div className="modal-fondo" onClick={onCancelar}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={titulo}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{titulo}</h3>
        <div className="modal-cuerpo">{mensaje}</div>
        <div className="modal-acciones">
          <button className="btn" onClick={onCancelar}>
            Cancelar
          </button>
          <button
            className={peligroso ? "btn btn-peligro" : "btn btn-primario"}
            onClick={onConfirmar}
            autoFocus
          >
            {textoConfirmar}
          </button>
        </div>
      </div>
    </div>
  );
}
