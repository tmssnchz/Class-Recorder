import { formatearBytes } from "../../lib/format";
import type { EstadoDescargaNube } from "../../hooks/useDescargaNube";
import { Icono } from "./Icono";

interface Props {
  estado: EstadoDescargaNube | null;
  onConfirmar(): void;
  onCancelar(): void;
  onCerrar(): void;
}

/** Confirmación y progreso al forzar la descarga de un audio en modo ahorro de espacio. */
export function ModalDescargaNube({ estado, onConfirmar, onCancelar, onCerrar }: Props) {
  if (!estado) return null;
  const bajando = estado.progreso !== null;

  return (
    <div className="modal-fondo" onClick={bajando ? undefined : onCancelar}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Audio en la nube"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Audio en la nube</h3>

        {estado.error ? (
          <>
            <div className="aviso aviso-error">
              <Icono nombre="alerta" />
              <span>{estado.error}</span>
            </div>
            <div className="modal-acciones">
              <button className="btn btn-primario" onClick={onCerrar}>
                Cerrar
              </button>
            </div>
          </>
        ) : bajando ? (
          <>
            <p className="sutil">Descargando el audio…</p>
            <div className="descarga">
              <div className="progreso">
                <div
                  className="progreso-valor"
                  style={{
                    width: `${
                      estado.progreso!.total > 0
                        ? Math.round((estado.progreso!.bytes / estado.progreso!.total) * 100)
                        : 0
                    }%`,
                  }}
                />
              </div>
              <small className="sutil">
                {formatearBytes(estado.progreso!.bytes)} /{" "}
                {formatearBytes(estado.progreso!.total)}
              </small>
            </div>
          </>
        ) : (
          <>
            <div className="modal-cuerpo">
              <p>Este audio está en la nube. ¿Descargar para reproducir?</p>
            </div>
            <div className="modal-acciones">
              <button className="btn" onClick={onCancelar}>
                Cancelar
              </button>
              <button className="btn btn-primario" onClick={onConfirmar} autoFocus>
                Descargar
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
