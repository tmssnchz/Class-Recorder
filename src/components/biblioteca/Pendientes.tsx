import { useMemo, useState } from "react";

import { useStore } from "../../estado/store";
import { useTranscripciones } from "../../estado/transcripciones";
import { formatearDuracion, formatearFecha } from "../../lib/format";
import { estimarConConfig } from "../../lib/modelos";
import { motorSinPreguntar } from "../../lib/transcripcionApi";
import type { Grabacion } from "../../types";
import { Icono } from "../ui/Icono";
import { ModalConfirmacion } from "../ui/ModalConfirmacion";

interface Props {
  /** Ya filtradas por el buscador y los filtros de la Biblioteca. */
  grabaciones: Grabacion[];
  seleccionada: string | null;
  onSeleccionar(id: string): void;
}

/**
 * Lista de todo lo que falta transcribir, sin tener que recorrer clase por
 * clase. La acción en lote avisa del tiempo total antes de encolar: con el
 * modelo Small, diez clases de dos horas son casi siete horas de CPU.
 */
export function Pendientes({ grabaciones, seleccionada, onSeleccionar }: Props) {
  const { config } = useStore();
  const { tareas, encolar } = useTranscripciones();
  const [confirmando, setConfirmando] = useState(false);

  const pendientes = useMemo(
    () =>
      grabaciones
        .filter((g) => !g.transcripcion)
        // Las que están convirtiéndose todavía no tienen audio final que leer.
        .filter((g) => g.estado !== "convirtiendo")
        .sort(
          (a, b) =>
            new Date(b.fechaISO).getTime() - new Date(a.fechaISO).getTime(),
        ),
    [grabaciones],
  );

  /**
   * Las que no están ya en la cola: son las que agregaría el botón. Las que
   * fallaron vuelven a contar, si no quedarían fuera del lote para siempre.
   */
  const encolables = useMemo(
    () =>
      pendientes.filter(
        (g) => !tareas[g.id] || tareas[g.id].estado === "error",
      ),
    [pendientes, tareas],
  );

  /**
   * El motor que va a correr de verdad. `null` significa que al confirmar se
   * abre el modal de elección, así que no se promete ninguno.
   */
  const motorFijo = useMemo(() => motorSinPreguntar(config), [config]);
  const enLocal = motorFijo?.tipo === "local";
  const nombreApi =
    motorFijo?.tipo === "api"
      ? config.apiTranscripcion.perfiles.find((p) => p.id === motorFijo.perfilId)
          ?.nombre
      : null;

  const totales = useMemo(() => {
    const segundosAudio = encolables.reduce((n, g) => n + g.duracionSeg, 0);
    const estimado = encolables.reduce(
      (n, g) =>
        n +
        estimarConConfig(
          config.motorTranscripcion,
          config.modelo,
          config.modeloFaster,
          g.duracionSeg,
        ).segundos,
      0,
    );
    return { segundosAudio, estimado };
  }, [encolables, config]);

  if (pendientes.length === 0) {
    return (
      <p className="vacio">
        No hay grabaciones pendientes: todas las que coinciden con el filtro ya
        están transcritas.
      </p>
    );
  }

  return (
    <>
      <div className="cabecera-pendientes">
        <div>
          <strong>
            {pendientes.length}{" "}
            {pendientes.length === 1 ? "grabación" : "grabaciones"} sin
            transcribir
          </strong>
          <small className="sutil">
            {formatearDuracion(
              pendientes.reduce((n, g) => n + g.duracionSeg, 0),
            )}{" "}
            de audio en total
          </small>
        </div>
        {encolables.length > 0 && (
          <button
            className="btn btn-primario"
            onClick={() => setConfirmando(true)}
          >
            Transcribir todas
          </button>
        )}
      </div>

      <ul className="lista">
        {pendientes.map((g) => {
          const tarea = tareas[g.id];
          const estimacion = estimarConConfig(
            config.motorTranscripcion,
            config.modelo,
            config.modeloFaster,
            g.duracionSeg,
          );
          return (
            <li
              key={g.id}
              className={`item ${g.id === seleccionada ? "activo" : ""}`}
              onClick={() => onSeleccionar(g.id)}
            >
              <div className="item-texto">
                <strong>
                  {g.claseNombre} · {g.unidadNombre}
                </strong>
                <small className="sutil">
                  {formatearFecha(g.fechaISO)} ·{" "}
                  {formatearDuracion(g.duracionSeg)}
                  {/* La estimación es la del motor local: con API no aplica. */}
                  {enLocal && ` · tardaría ~${formatearDuracion(estimacion.segundos)}`}
                </small>
              </div>
              {tarea && tarea.estado !== "error" ? (
                <span className="chip">
                  {tarea.estado === "esperando" ? "en cola" : "transcribiendo"}
                </span>
              ) : (
                <div className="acciones-item">
                  {tarea && (
                    <span className="chip chip-error" title={tarea.error}>
                      falló
                    </span>
                  )}
                  <button
                    className="btn btn-mini"
                    onClick={(e) => {
                      e.stopPropagation();
                      encolar(g);
                    }}
                  >
                    {tarea ? "Reintentar" : "Transcribir"}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <ModalConfirmacion
        abierto={confirmando}
        titulo="Transcribir todas las pendientes"
        textoConfirmar={`Encolar ${encolables.length}`}
        mensaje={
          <>
            <p>
              Se van a encolar <strong>{encolables.length}</strong>{" "}
              {encolables.length === 1 ? "grabación" : "grabaciones"} (
              {formatearDuracion(totales.segundosAudio)} de audio).
            </p>
            {enLocal && (
              <>
                <p>
                  Con {config.motorTranscripcion} eso son unas{" "}
                  <strong>{formatearDuracion(totales.estimado)}</strong> de
                  proceso.
                </p>
                {totales.estimado > 3600 && (
                  <p className="aviso aviso-info">
                    <Icono nombre="alerta" tamano={16} />
                    <span>
                      Es más de una hora con la CPU al máximo. Conviene dejarlo
                      corriendo de noche: mientras tanto la máquina va a ir lenta
                      y la batería dura bastante menos.
                    </span>
                  </p>
                )}
              </>
            )}
            {motorFijo && !enLocal && (
              <p>
                Se transcriben con{" "}
                <strong>{motorFijo.tipo === "multiapi" ? "Multi-API" : nombreApi}</strong>{" "}
                por API, sin ocupar la CPU de este equipo. Se puede cambiar en
                Configuración → Transcripción por API.
              </p>
            )}
            {!motorFijo && (
              <p>Al confirmar eliges con qué motor: local o uno de tus perfiles de API.</p>
            )}
          </>
        }
        onConfirmar={() => {
          for (const g of encolables) encolar(g);
          setConfirmando(false);
        }}
        onCancelar={() => setConfirmando(false)}
      />
    </>
  );
}
