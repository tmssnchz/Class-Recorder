import { useEffect, useMemo, useState } from "react";

import { useTranscripciones } from "../../estado/transcripciones";
import { useStore } from "../../estado/store";
import { formatearDuracion } from "../../lib/format";
import { estimarConConfig, etiquetaDeModelo } from "../../lib/modelos";
import { leerSegmentos } from "../../lib/transcripcion";
import type { Grabacion, Segmento } from "../../types";
import { Icono } from "../ui/Icono";

const ETIQUETA_ETAPA: Record<string, string> = {
  esperando: "En cola",
  preparando: "Preparando el audio",
  transcribiendo: "Transcribiendo",
  guardando: "Guardando",
};

interface Props {
  grabacion: Grabacion;
  /** Texto a resaltar, cuando se llegó desde el buscador global. */
  resaltar?: string;
  onSaltar(segundo: number): void;
  onExportar(segmentos: Segmento[], formato: "pdf" | "docx" | "md"): void;
}

export function VistaTranscripcion({
  grabacion,
  resaltar,
  onSaltar,
  onExportar,
}: Props) {
  const { config } = useStore();
  const { tareas, encolar, cancelar, descartarError } = useTranscripciones();
  const [segmentos, setSegmentos] = useState<Segmento[]>([]);
  const [copiado, setCopiado] = useState(false);

  const tarea = tareas[grabacion.id];
  const transcripcion = grabacion.transcripcion;

  useEffect(() => {
    let vigente = true;
    if (!transcripcion) {
      setSegmentos([]);
      return;
    }
    void leerSegmentos(transcripcion).then((s) => {
      if (vigente) setSegmentos(s);
    });
    return () => {
      vigente = false;
    };
  }, [transcripcion]);

  const textoPlano = useMemo(
    () => segmentos.map((s) => s.texto).join(" "),
    [segmentos],
  );

  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(textoPlano);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    } catch (e) {
      console.error("No se pudo copiar", e);
    }
  };

  const estimacion = estimarConConfig(
    config.motorTranscripcion,
    config.modelo,
    config.modeloFaster,
    grabacion.duracionSeg,
  );

  // ------------------------------------------------------------ en proceso

  if (tarea && tarea.estado !== "error") {
    return (
      <div className="bloque">
        <h3 className="titulo-seccion">Transcripción</h3>
        <div className="conversion">
          <div className="conversion-texto">
            <span>
              {ETIQUETA_ETAPA[tarea.estado] ?? tarea.estado}
              {tarea.estado === "transcribiendo" ? ` — ${tarea.porcentaje}%` : "…"}
            </span>
            <button
              className="btn btn-mini"
              onClick={() => cancelar(grabacion.id)}
            >
              Cancelar
            </button>
          </div>
          <div className="progreso">
            <div
              className="progreso-valor"
              style={{
                width:
                  tarea.estado === "transcribiendo"
                    ? `${tarea.porcentaje}%`
                    : "100%",
                opacity: tarea.estado === "transcribiendo" ? 1 : 0.4,
              }}
            />
          </div>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------ error

  if (tarea?.estado === "error") {
    return (
      <div className="bloque">
        <h3 className="titulo-seccion">Transcripción</h3>
        <div className="aviso aviso-error">
          <Icono nombre="alerta" />
          <span>{tarea.error}</span>
        </div>
        <div className="acciones-detalle" style={{ marginTop: 0, border: "none" }}>
          <button className="btn" onClick={() => descartarError(grabacion.id)}>
            Entendido
          </button>
          <button
            className="btn btn-primario"
            onClick={() => encolar(grabacion)}
          >
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------ sin hacer

  if (!transcripcion) {
    return (
      <div className="bloque">
        <h3 className="titulo-seccion">Transcripción</h3>
        <p className="sutil">
          Todavía no se transcribió. Con {config.motorTranscripcion} y el modelo{" "}
          {estimacion.etiqueta}, esta grabación de{" "}
          {formatearDuracion(grabacion.duracionSeg)} tardaría unos{" "}
          <strong>{formatearDuracion(estimacion.segundos)}</strong>.
        </p>
        <button
          className="btn btn-primario"
          style={{ marginTop: 10 }}
          onClick={() => encolar(grabacion)}
        >
          Transcribir
        </button>
      </div>
    );
  }

  // --------------------------------------------------------------- lista

  return (
    <div className="bloque">
      <div className="cabecera-transcripcion">
        <h3 className="titulo-seccion">Transcripción</h3>
        <small className="sutil">
          {transcripcion.palabras} palabras ·{" "}
          {etiquetaDeModelo(transcripcion.modelo)} · tardó{" "}
          {formatearDuracion(transcripcion.duracionProcesoSeg)}
        </small>
      </div>

      <div className="acciones-transcripcion">
        <button className="btn btn-mini" onClick={() => void copiar()}>
          {copiado ? "Copiado" : "Copiar texto"}
        </button>
        <button
          className="btn btn-mini"
          title="Texto con secciones por minuto, para pegar en una IA o en un centro de estudios"
          onClick={() => onExportar(segmentos, "md")}
        >
          Exportar Markdown
        </button>
        <button
          className="btn btn-mini"
          onClick={() => onExportar(segmentos, "pdf")}
        >
          Exportar PDF
        </button>
        <button
          className="btn btn-mini"
          onClick={() => onExportar(segmentos, "docx")}
        >
          Exportar Word
        </button>
        <button className="btn btn-mini" onClick={() => encolar(grabacion)}>
          Volver a transcribir
        </button>
      </div>

      <div className="transcripcion">
        {segmentos.length === 0 ? (
          <p className="sutil">
            No se encontró el archivo de segmentos. El texto sigue en{" "}
            <code>{transcripcion.archivo}</code>
          </p>
        ) : (
          segmentos.map((s, i) => (
            <button
              key={i}
              className="segmento"
              onClick={() => onSaltar(s.desdeMs / 1000)}
              title="Ir a este momento del audio"
            >
              <span className="segmento-tiempo">
                {formatearDuracion(s.desdeMs / 1000)}
              </span>
              <span className="segmento-texto">
                {resaltar ? resaltarTexto(s.texto, resaltar) : s.texto}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function resaltarTexto(texto: string, consulta: string) {
  const q = consulta.trim();
  if (!q) return texto;
  // Escapamos la consulta: el usuario puede escribir paréntesis o puntos.
  const patron = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  // split con grupo de captura deja los tramos coincidentes como elementos sueltos.
  return texto
    .split(patron)
    .map((parte, i) =>
      parte.toLowerCase() === q.toLowerCase() ? (
        <mark key={i}>{parte}</mark>
      ) : (
        <span key={i}>{parte}</span>
      ),
    );
}
