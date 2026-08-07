import { useMemo, useState } from "react";

import { formatearDuracion, formatearHora } from "../../lib/format";
import type { Clase, Grabacion } from "../../types";

const DIAS = ["L", "M", "X", "J", "V", "S", "D"];
const DIAS_LARGOS = [
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
  "domingo",
];
const MESES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

const COLOR_SIN_CLASE = "#8b93a1";

type Alcance = "mes" | "semana";

/** Clave local yyyy-mm-dd. No se usa toISOString: eso pasa a UTC y corre el día. */
export function claveDia(fecha: Date): string {
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${fecha.getFullYear()}-${p(fecha.getMonth() + 1)}-${p(fecha.getDate())}`;
}

/** Lunes de la semana que contiene a `fecha`. */
function lunesDe(fecha: Date): Date {
  const d = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate());
  // getDay() devuelve 0 para domingo; la semana acá arranca en lunes.
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

interface Props {
  grabaciones: Grabacion[];
  clases: Clase[];
  diaSeleccionado: string | null;
  onSeleccionarDia(clave: string | null): void;
  /** Grabación abierta en el panel de detalle, para resaltarla en la lista. */
  seleccionada: string | null;
  onSeleccionarGrabacion(id: string): void;
}

export function Calendario({
  grabaciones,
  clases,
  diaSeleccionado,
  onSeleccionarDia,
  seleccionada,
  onSeleccionarGrabacion,
}: Props) {
  const [alcance, setAlcance] = useState<Alcance>("mes");
  const [ancla, setAncla] = useState(() => new Date());
  /** Clases cuyos puntos se ocultan. Vacío = se ven todas. */
  const [ocultas, setOcultas] = useState<Set<string>>(new Set());

  const visibles = useMemo(
    () => grabaciones.filter((g) => !ocultas.has(g.claseId ?? "sin-clase")),
    [grabaciones, ocultas],
  );

  const porDia = useMemo(() => {
    const mapa = new Map<string, Grabacion[]>();
    for (const g of visibles) {
      const clave = claveDia(new Date(g.fechaISO));
      const lista = mapa.get(clave);
      if (lista) lista.push(g);
      else mapa.set(clave, [g]);
    }
    // Dentro de cada día van en orden cronológico.
    for (const lista of mapa.values()) {
      lista.sort(
        (a, b) => new Date(a.fechaISO).getTime() - new Date(b.fechaISO).getTime(),
      );
    }
    return mapa;
  }, [visibles]);

  const colorDe = (g: Grabacion) =>
    clases.find((c) => c.id === g.claseId)?.color ?? COLOR_SIN_CLASE;

  const celdas = useMemo(() => {
    if (alcance === "semana") {
      const inicio = lunesDe(ancla);
      return Array.from({ length: 7 }, (_, i) => {
        const f = new Date(inicio);
        f.setDate(inicio.getDate() + i);
        return f;
      });
    }
    const primero = new Date(ancla.getFullYear(), ancla.getMonth(), 1);
    const inicio = lunesDe(primero);
    return Array.from({ length: 42 }, (_, i) => {
      const f = new Date(inicio);
      f.setDate(inicio.getDate() + i);
      return f;
    });
  }, [ancla, alcance]);

  const hoy = claveDia(new Date());

  const mover = (pasos: number) => {
    const d = new Date(ancla);
    if (alcance === "semana") d.setDate(d.getDate() + pasos * 7);
    else d.setMonth(d.getMonth() + pasos);
    setAncla(d);
  };

  const titulo = useMemo(() => {
    if (alcance === "mes") {
      return `${MESES[ancla.getMonth()]} ${ancla.getFullYear()}`;
    }
    const inicio = lunesDe(ancla);
    const fin = new Date(inicio);
    fin.setDate(inicio.getDate() + 6);
    const mismoMes = inicio.getMonth() === fin.getMonth();
    return mismoMes
      ? `${inicio.getDate()} – ${fin.getDate()} de ${MESES[inicio.getMonth()]}`
      : `${inicio.getDate()} ${MESES[inicio.getMonth()].slice(0, 3)} – ${fin.getDate()} ${MESES[
          fin.getMonth()
        ].slice(0, 3)}`;
  }, [ancla, alcance]);

  const alternarClase = (id: string) => {
    setOcultas((previas) => {
      const siguiente = new Set(previas);
      if (siguiente.has(id)) siguiente.delete(id);
      else siguiente.add(id);
      return siguiente;
    });
  };

  const conSinClase = grabaciones.some((g) => !g.claseId);
  const delDia = diaSeleccionado ? (porDia.get(diaSeleccionado) ?? []) : [];

  return (
    <div className="calendario">
      <div className="calendario-cabecera">
        <button className="btn-icono" title="Anterior" onClick={() => mover(-1)}>
          ‹
        </button>
        <strong>{titulo}</strong>
        <button className="btn-icono" title="Siguiente" onClick={() => mover(1)}>
          ›
        </button>
        <button
          className="btn btn-mini"
          onClick={() => {
            const h = new Date();
            setAncla(h);
            onSeleccionarDia(claveDia(h));
          }}
        >
          Hoy
        </button>
        <div className="conmutador conmutador-mini">
          <button
            className={alcance === "mes" ? "activo" : ""}
            onClick={() => setAlcance("mes")}
          >
            Mes
          </button>
          <button
            className={alcance === "semana" ? "activo" : ""}
            onClick={() => setAlcance("semana")}
          >
            Semana
          </button>
        </div>
      </div>

      {(clases.length > 0 || conSinClase) && (
        <div className="calendario-leyenda">
          {clases.map((c) => (
            <button
              key={c.id}
              className={`leyenda-clase ${ocultas.has(c.id) ? "apagada" : ""}`}
              title={ocultas.has(c.id) ? "Mostrar en el calendario" : "Ocultar"}
              onClick={() => alternarClase(c.id)}
            >
              <span className="punto" style={{ background: c.color }} />
              {c.nombre}
            </button>
          ))}
          {conSinClase && (
            <button
              className={`leyenda-clase ${ocultas.has("sin-clase") ? "apagada" : ""}`}
              onClick={() => alternarClase("sin-clase")}
            >
              <span className="punto" style={{ background: COLOR_SIN_CLASE }} />
              Sin clasificar
            </button>
          )}
        </div>
      )}

      <div className={`calendario-grilla ${alcance === "semana" ? "semanal" : ""}`}>
        {DIAS.map((d) => (
          <div key={d} className="calendario-dia-nombre">
            {d}
          </div>
        ))}

        {celdas.map((fecha) => {
          const clave = claveDia(fecha);
          const delMes = alcance === "semana" || fecha.getMonth() === ancla.getMonth();
          const items = porDia.get(clave) ?? [];
          // Un día "pendiente" es el que tiene algo grabado sin transcribir:
          // se marca distinto para poder barrerlos sin abrir uno por uno.
          const pendiente = items.some(
            (g) => !g.transcripcion && g.estado !== "convirtiendo",
          );
          return (
            <button
              key={clave}
              className={[
                "calendario-celda",
                delMes ? "" : "fuera",
                clave === hoy ? "hoy" : "",
                clave === diaSeleccionado ? "elegido" : "",
                items.length > 0 ? "con-grabaciones" : "",
                pendiente ? "con-pendientes" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              title={
                pendiente ? "Tiene grabaciones sin transcribir" : undefined
              }
              onClick={() =>
                onSeleccionarDia(clave === diaSeleccionado ? null : clave)
              }
            >
              <span className="numero">
                {alcance === "semana"
                  ? `${DIAS_LARGOS[(fecha.getDay() + 6) % 7].slice(0, 3)} ${fecha.getDate()}`
                  : fecha.getDate()}
              </span>
              <span className="puntos">
                {items.slice(0, 4).map((g) => (
                  <span
                    key={g.id}
                    className="punto"
                    style={{ background: colorDe(g) }}
                  />
                ))}
                {items.length > 4 && (
                  <span className="mas">+{items.length - 4}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      {diaSeleccionado && (
        <div className="calendario-detalle">
          <h4>
            {new Date(`${diaSeleccionado}T12:00:00`).toLocaleDateString("es-ES", {
              weekday: "long",
              day: "numeric",
              month: "long",
            })}
            <span className="sutil">
              {delDia.length === 0
                ? "sin grabaciones"
                : `${delDia.length} ${
                    delDia.length === 1 ? "grabación" : "grabaciones"
                  } · ${formatearDuracion(
                    delDia.reduce((n, g) => n + g.duracionSeg, 0),
                  )}`}
            </span>
          </h4>

          {delDia.length > 0 && (
            <ul className="lista">
              {delDia.map((g) => (
                <li
                  key={g.id}
                  className={`item ${g.id === seleccionada ? "activo" : ""}`}
                  onClick={() => onSeleccionarGrabacion(g.id)}
                >
                  <span
                    className="punto"
                    style={{ background: colorDe(g) }}
                  />
                  <div className="item-texto">
                    <strong>
                      {formatearHora(g.fechaISO)} · {g.claseNombre}
                    </strong>
                    <small className="sutil">
                      {g.unidadNombre} · {formatearDuracion(g.duracionSeg)}
                      {g.transcripcion ? " · transcrita" : ""}
                    </small>
                  </div>
                  {!g.transcripcion && g.estado !== "convirtiendo" && (
                    <span className="chip chip-mini chip-aviso">
                      sin transcribir
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
