import { useMemo, useState } from "react";

import { useDescargaNube } from "../../hooks/useDescargaNube";
import {
  formatearDuracion,
  formatearHora,
  parsearDuracion,
} from "../../lib/format";
import {
  horaDesdeOffset,
  offsetDesdeHora,
  recortarGrabacion,
  type EtapaRecorte,
  type ModoRecorte,
} from "../../lib/recorte";
import type { Grabacion } from "../../types";
import { Icono } from "../ui/Icono";
import { ModalConfirmacion } from "../ui/ModalConfirmacion";
import { ModalDescargaNube } from "../ui/ModalDescargaNube";

const ETIQUETA_ETAPA: Record<EtapaRecorte, string> = {
  recortando: "Recortando…",
  uniendo: "Uniendo las partes…",
  guardando: "Guardando…",
};

interface Props {
  grabacion: Grabacion;
  onCancelar(): void;
  onListo(resultado: Grabacion, reemplazo: boolean): void;
}

export function RecortarAudio({ grabacion, onCancelar, onListo }: Props) {
  const [modo, setModo] = useState<ModoRecorte>("desde");
  const [desdeSeg, setDesdeSeg] = useState<number | null>(null);
  const [hastaSeg, setHastaSeg] = useState<number | null>(null);
  const [reemplazar, setReemplazar] = useState(false);
  const [confirmandoReemplazo, setConfirmandoReemplazo] = useState(false);
  const [procesando, setProcesando] = useState(false);
  const [etapa, setEtapa] = useState<EtapaRecorte | null>(null);
  const [error, setError] = useState<string | null>(null);
  const {
    estado: estadoDescarga,
    asegurar: asegurarAudio,
    confirmar: confirmarDescarga,
    cancelar: cancelarDescarga,
    cerrar: cerrarDescarga,
  } = useDescargaNube();

  /**
   * Cambiar de modo tiene que arrancar de cero: si no, un límite cargado en
   * "Cortar desde un punto" quedaría pisando el "Desde" de "Quitar un
   * intervalo" sin que el usuario lo haya tocado.
   */
  const cambiarModo = (nuevo: ModoRecorte) => {
    setModo(nuevo);
    setDesdeSeg(null);
    setHastaSeg(null);
  };

  const desdeMayorQueHasta =
    modo === "intervalo" && desdeSeg !== null && hastaSeg !== null && desdeSeg >= hastaSeg;

  const duracionResultante = useMemo(() => {
    if (modo === "desde") return hastaSeg;
    if (desdeSeg === null || hastaSeg === null || desdeSeg >= hastaSeg) return null;
    return grabacion.duracionSeg - (hastaSeg - desdeSeg);
  }, [modo, desdeSeg, hastaSeg, grabacion.duracionSeg]);

  const listo =
    modo === "desde"
      ? hastaSeg !== null && hastaSeg > 0 && hastaSeg < grabacion.duracionSeg
      : desdeSeg !== null &&
        hastaSeg !== null &&
        desdeSeg >= 0 &&
        hastaSeg <= grabacion.duracionSeg &&
        desdeSeg < hastaSeg &&
        (duracionResultante ?? 0) > 0;

  const ejecutar = async (reemplazoConfirmado: boolean) => {
    if (!listo || hastaSeg === null) return;
    if (!(await asegurarAudio(grabacion.archivoAudio))) return;
    setProcesando(true);
    setError(null);
    try {
      const resultado = await recortarGrabacion(grabacion, {
        modo,
        desdeSeg: modo === "intervalo" ? (desdeSeg ?? 0) : 0,
        hastaSeg,
        reemplazar: reemplazoConfirmado,
        onEtapa: setEtapa,
      });
      onListo(resultado, reemplazoConfirmado);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setProcesando(false);
      setEtapa(null);
    } finally {
      setConfirmandoReemplazo(false);
    }
  };

  return (
    <div className="modal-fondo" onClick={procesando ? undefined : onCancelar}>
      <div
        className="modal modal-recorte"
        role="dialog"
        aria-modal="true"
        aria-label="Recortar audio"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Recortar audio</h3>
        <p className="sutil">
          Esta grabación empezó a las{" "}
          <strong>{formatearHora(grabacion.fechaISO)}</strong> y dura{" "}
          {formatearDuracion(grabacion.duracionSeg)}.
        </p>

        {error && (
          <div className="aviso aviso-error">
            <Icono nombre="alerta" />
            <span>{error}</span>
            <button className="btn-icono" onClick={() => setError(null)}>
              <Icono nombre="equis" tamano={16} />
            </button>
          </div>
        )}

        <div className="conmutador conmutador-ancho">
          <button
            className={modo === "desde" ? "activo" : ""}
            disabled={procesando}
            onClick={() => cambiarModo("desde")}
          >
            Cortar desde un punto
          </button>
          <button
            className={modo === "intervalo" ? "activo" : ""}
            disabled={procesando}
            onClick={() => cambiarModo("intervalo")}
          >
            Quitar un intervalo
          </button>
        </div>

        {modo === "desde" ? (
          <>
            <p className="sutil recorte-explicacion">
              Se conserva desde el inicio hasta este punto; todo lo que sigue
              se descarta.
            </p>
            <EntradaLimite
              key="desde-hasta"
              etiqueta="Cortar en"
              fechaInicioISO={grabacion.fechaISO}
              duracionTotalSeg={grabacion.duracionSeg}
              disabled={procesando}
              onCambiar={setHastaSeg}
            />
          </>
        ) : (
          <>
            <p className="sutil recorte-explicacion">
              Se quita este tramo y se pega lo de antes con lo de después.
            </p>
            <EntradaLimite
              key="intervalo-desde"
              etiqueta="Desde"
              fechaInicioISO={grabacion.fechaISO}
              duracionTotalSeg={grabacion.duracionSeg}
              disabled={procesando}
              onCambiar={setDesdeSeg}
            />
            <EntradaLimite
              key="intervalo-hasta"
              etiqueta="Hasta"
              fechaInicioISO={grabacion.fechaISO}
              duracionTotalSeg={grabacion.duracionSeg}
              disabled={procesando}
              onCambiar={setHastaSeg}
            />
          </>
        )}

        {desdeMayorQueHasta ? (
          <small className="error-inline">
            "Desde" tiene que ser un momento anterior a "Hasta".
          </small>
        ) : (
          duracionResultante !== null &&
          duracionResultante > 0 && (
            <p className="sutil">
              Duración resultante:{" "}
              <strong>{formatearDuracion(duracionResultante)}</strong>
            </p>
          )
        )}

        <div className="ajuste ajuste-recorte">
          <div className="ajuste-texto">
            <strong>Reemplazar la grabación original</strong>
            <small className="sutil">
              {reemplazar
                ? "El audio actual se borra y se pisa con el recorte. No se puede deshacer."
                : "Se crea una grabación nueva con el audio recortado; la original queda intacta."}
            </small>
          </div>
          <div className="conmutador">
            <button
              className={!reemplazar ? "activo" : ""}
              disabled={procesando}
              onClick={() => setReemplazar(false)}
            >
              Copia nueva
            </button>
            <button
              className={reemplazar ? "activo" : ""}
              disabled={procesando}
              onClick={() => setReemplazar(true)}
            >
              Reemplazar
            </button>
          </div>
        </div>

        {procesando && (
          <p className="sutil recorte-procesando">
            {etapa ? ETIQUETA_ETAPA[etapa] : "Preparando…"}
          </p>
        )}

        <div className="modal-acciones">
          <button className="btn" disabled={procesando} onClick={onCancelar}>
            Cancelar
          </button>
          <button
            className={reemplazar ? "btn btn-peligro" : "btn btn-primario"}
            disabled={!listo || procesando}
            onClick={() =>
              reemplazar ? setConfirmandoReemplazo(true) : void ejecutar(false)
            }
          >
            {procesando ? "Procesando…" : "Recortar"}
          </button>
        </div>

        <ModalConfirmacion
          abierto={confirmandoReemplazo}
          titulo="Reemplazar la grabación original"
          peligroso
          textoConfirmar="Sí, reemplazar"
          mensaje={
            <p>
              Se va a borrar del disco la parte descartada del audio original
              y no hay forma de recuperarla después. Si tienes dudas, cancela
              y usa "Copia nueva" primero para revisar el resultado.
            </p>
          }
          onConfirmar={() => void ejecutar(true)}
          onCancelar={() => setConfirmandoReemplazo(false)}
        />

        <ModalDescargaNube
          estado={estadoDescarga}
          onConfirmar={confirmarDescarga}
          onCancelar={cancelarDescarga}
          onCerrar={cerrarDescarga}
        />
      </div>
    </div>
  );
}

function EntradaLimite({
  etiqueta,
  fechaInicioISO,
  duracionTotalSeg,
  disabled,
  onCambiar,
}: {
  etiqueta: string;
  fechaInicioISO: string;
  duracionTotalSeg: number;
  disabled: boolean;
  onCambiar(seg: number | null): void;
}) {
  const [relojTexto, setRelojTexto] = useState("");
  const [duracionTexto, setDuracionTexto] = useState("");
  const [error, setError] = useState<string | null>(null);

  /** Deja los dos campos sincronizados y avisa el valor hacia arriba. */
  const aplicar = (seg: number) => {
    if (seg < 0 || seg > duracionTotalSeg) {
      setError("Esa hora queda fuera de la duración de la grabación.");
      onCambiar(null);
      return;
    }
    setError(null);
    onCambiar(seg);
    setRelojTexto(horaDesdeOffset(fechaInicioISO, seg).slice(0, 5));
    setDuracionTexto(formatearDuracion(seg));
  };

  return (
    <div className="limite-corte">
      <span className="limite-etiqueta">{etiqueta}</span>
      <div className="limite-campos">
        <label>
          <span className="sutil">Hora de reloj</span>
          <input
            value={relojTexto}
            placeholder="11:20"
            disabled={disabled}
            onChange={(e) => setRelojTexto(e.target.value)}
            onBlur={() => {
              if (!relojTexto.trim()) return;
              const seg = offsetDesdeHora(fechaInicioISO, relojTexto);
              if (seg === null) {
                setError("Formato inválido: usa HH:mm.");
                onCambiar(null);
                return;
              }
              aplicar(seg);
            }}
          />
        </label>
        <label>
          <span className="sutil">Minuto de la grabación</span>
          <input
            value={duracionTexto}
            placeholder="mm:ss"
            disabled={disabled}
            onChange={(e) => setDuracionTexto(e.target.value)}
            onBlur={() => {
              if (!duracionTexto.trim()) return;
              const seg = parsearDuracion(duracionTexto);
              if (seg === null) {
                setError("Formato inválido: usa mm:ss.");
                onCambiar(null);
                return;
              }
              aplicar(seg);
            }}
          />
        </label>
      </div>
      {error && <small className="error-inline">{error}</small>}
    </div>
  );
}
