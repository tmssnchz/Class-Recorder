import { useEffect, useState } from "react";

export type MotorElegido =
  | { tipo: "local" }
  | { tipo: "api"; perfilId: string }
  | { tipo: "multiapi" };

export interface OpcionMotor {
  motor: MotorElegido;
  etiqueta: string;
}

function claveMotor(m: MotorElegido): string {
  return m.tipo === "api" ? `api:${m.perfilId}` : m.tipo;
}

function mismoMotor(a: MotorElegido, b: MotorElegido): boolean {
  return claveMotor(a) === claveMotor(b);
}

interface Props {
  abierto: boolean;
  /** Local + cada perfil de API con clave configurada. */
  opciones: OpcionMotor[];
  predeterminado: MotorElegido;
  onElegir(motor: MotorElegido, comoPredeterminado: boolean): void;
  onCancelar(): void;
}

export function ModalElegirMotor({
  abierto,
  opciones,
  predeterminado,
  onElegir,
  onCancelar,
}: Props) {
  const [comoPredeterminado, setComoPredeterminado] = useState(false);

  useEffect(() => {
    if (!abierto) return;
    setComoPredeterminado(false);
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancelar();
    };
    window.addEventListener("keydown", alTeclear);
    return () => window.removeEventListener("keydown", alTeclear);
  }, [abierto, onCancelar]);

  if (!abierto) return null;

  const opcionPredeterminada = opciones.find((o) => mismoMotor(o.motor, predeterminado));
  const otras = opciones.filter((o) => !mismoMotor(o.motor, predeterminado));

  return (
    <div className="modal-fondo" onClick={onCancelar}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="¿Cómo quieres transcribir esta grabación?"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>¿Cómo quieres transcribir esta grabación?</h3>

        {opcionPredeterminada && (
          <div className="modal-cuerpo">
            <button
              className="btn btn-primario"
              style={{ width: "100%" }}
              onClick={() => onElegir(opcionPredeterminada.motor, false)}
              autoFocus
            >
              Usar predeterminado: {opcionPredeterminada.etiqueta}
            </button>
          </div>
        )}

        {otras.length > 0 && (
          <div className="modal-cuerpo">
            <small className="sutil">O elegir otro para esta vez:</small>
            <div className="conmutador" style={{ flexDirection: "column" }}>
              {otras.map((o) => (
                <button key={claveMotor(o.motor)} onClick={() => onElegir(o.motor, comoPredeterminado)}>
                  {o.etiqueta}
                </button>
              ))}
            </div>
            <label className="ajuste" style={{ cursor: "pointer", marginTop: 8 }}>
              <input
                type="checkbox"
                checked={comoPredeterminado}
                onChange={(e) => setComoPredeterminado(e.target.checked)}
              />
              <span>Dejar como predeterminado</span>
            </label>
          </div>
        )}

        <div className="modal-acciones">
          <button className="btn" onClick={onCancelar}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
