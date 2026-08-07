import { useEffect, useMemo, useState } from "react";

import { useGrabador } from "../estado/grabador";
import { useStore } from "../estado/store";
import { buscarEnTranscripciones, type Coincidencia } from "../lib/busqueda";
import { formatearDuracion, formatearFecha, formatearHora } from "../lib/format";
import { SIN_CLASE, type Grabacion } from "../types";
import { Calendario } from "./biblioteca/Calendario";
import { DetalleGrabacion } from "./biblioteca/DetalleGrabacion";
import { Pendientes } from "./biblioteca/Pendientes";
import { Icono } from "./ui/Icono";

type Vista = "arbol" | "calendario" | "pendientes";

export function BibliotecaPanel() {
  const { datos } = useStore();
  const { conversiones } = useGrabador();

  const [vista, setVista] = useState<Vista>("arbol");
  const [busqueda, setBusqueda] = useState("");
  const [filtroClase, setFiltroClase] = useState<string>("");
  const [filtroTag, setFiltroTag] = useState<string | null>(null);
  const [diaSeleccionado, setDiaSeleccionado] = useState<string | null>(null);
  const [seleccionada, setSeleccionada] = useState<string | null>(null);
  const [enTranscripciones, setEnTranscripciones] = useState(false);
  const [coincidencias, setCoincidencias] = useState<Map<string, Coincidencia>>(
    new Map(),
  );
  const [buscando, setBuscando] = useState(false);

  const hayTranscripciones = datos.grabaciones.some((g) => g.transcripcion);
  const sinTranscribir = datos.grabaciones.filter(
    (g) => !g.transcripcion && g.estado !== "convirtiendo",
  ).length;

  // La búsqueda dentro del texto lee archivos: se espera a que dejes de escribir.
  useEffect(() => {
    if (!enTranscripciones || busqueda.trim().length < 3) {
      setCoincidencias(new Map());
      setBuscando(false);
      return;
    }
    setBuscando(true);
    let vigente = true;
    const temporizador = setTimeout(() => {
      void buscarEnTranscripciones(datos.grabaciones, busqueda).then((r) => {
        if (!vigente) return;
        setCoincidencias(r);
        setBuscando(false);
      });
    }, 350);
    return () => {
      vigente = false;
      clearTimeout(temporizador);
    };
  }, [enTranscripciones, busqueda, datos.grabaciones]);

  const todosLosTags = useMemo(() => {
    const set = new Set<string>();
    for (const g of datos.grabaciones) for (const t of g.tags) set.add(t);
    return [...set].sort();
  }, [datos.grabaciones]);

  const filtradas = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return datos.grabaciones
      .filter((g) => {
        if (filtroClase && g.claseId !== filtroClase) return false;
        if (filtroTag && !g.tags.includes(filtroTag)) return false;
        if (!q) return true;
        return (
          g.titulo.toLowerCase().includes(q) ||
          g.claseNombre.toLowerCase().includes(q) ||
          g.unidadNombre.toLowerCase().includes(q) ||
          g.tags.some((t) => t.includes(q)) ||
          g.marcas.some((m) => m.nota.toLowerCase().includes(q))
        );
      })
      .sort(
        (a, b) =>
          new Date(b.fechaISO).getTime() - new Date(a.fechaISO).getTime(),
      );
  }, [datos.grabaciones, busqueda, filtroClase, filtroTag]);

  /** Árbol clase › unidad › grabaciones, respetando el orden de las clases. */
  const arbol = useMemo(() => {
    const grupos: {
      claveClase: string;
      nombre: string;
      color: string;
      unidades: { claveUnidad: string; nombre: string; items: Grabacion[] }[];
    }[] = [];

    for (const g of filtradas) {
      const claveClase = g.claseId ?? SIN_CLASE;
      let clase = grupos.find((x) => x.claveClase === claveClase);
      if (!clase) {
        clase = {
          claveClase,
          nombre: g.claseNombre,
          color:
            datos.clases.find((c) => c.id === g.claseId)?.color ?? "#8b93a1",
          unidades: [],
        };
        grupos.push(clase);
      }
      const claveUnidad = g.unidadId ?? g.unidadNombre;
      let unidad = clase.unidades.find((u) => u.claveUnidad === claveUnidad);
      if (!unidad) {
        unidad = { claveUnidad, nombre: g.unidadNombre, items: [] };
        clase.unidades.push(unidad);
      }
      unidad.items.push(g);
    }
    return grupos;
  }, [filtradas, datos.clases]);

  const grabacion = datos.grabaciones.find((g) => g.id === seleccionada) ?? null;

  // Si la seleccionada desaparece del filtro (o se elimina), soltamos el detalle.
  useEffect(() => {
    if (seleccionada && !datos.grabaciones.some((g) => g.id === seleccionada)) {
      setSeleccionada(null);
    }
  }, [datos.grabaciones, seleccionada]);

  const hayFiltros = Boolean(busqueda || filtroClase || filtroTag);

  return (
    <section className="panel panel-ancho">
      <header className="panel-cabecera">
        <div>
          <h2>Biblioteca</h2>
          <p className="sutil">
            {datos.grabaciones.length}{" "}
            {datos.grabaciones.length === 1 ? "grabación" : "grabaciones"}
            {hayFiltros ? ` · ${filtradas.length} coinciden con el filtro` : ""}
          </p>
        </div>
        <div className="conmutador">
          <button
            className={vista === "arbol" ? "activo" : ""}
            onClick={() => setVista("arbol")}
          >
            Por clase
          </button>
          <button
            className={vista === "calendario" ? "activo" : ""}
            onClick={() => setVista("calendario")}
          >
            Calendario
          </button>
          <button
            className={vista === "pendientes" ? "activo" : ""}
            onClick={() => setVista("pendientes")}
          >
            Pendientes
            {sinTranscribir > 0 && (
              <span className="chip chip-mini">{sinTranscribir}</span>
            )}
          </button>
        </div>
      </header>

      <div className="filtros">
        <input
          className="buscador"
          value={busqueda}
          placeholder="Buscar por nombre, clase, unidad, etiqueta o nota…"
          onChange={(e) => setBusqueda(e.target.value)}
        />
        <select
          value={filtroClase}
          onChange={(e) => setFiltroClase(e.target.value)}
        >
          <option value="">Todas las clases</option>
          {datos.clases.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nombre}
            </option>
          ))}
        </select>
        {hayFiltros && (
          <button
            className="btn"
            onClick={() => {
              setBusqueda("");
              setFiltroClase("");
              setFiltroTag(null);
            }}
          >
            Limpiar
          </button>
        )}
      </div>

      {hayTranscripciones && (
        <label className="casilla">
          <input
            type="checkbox"
            checked={enTranscripciones}
            onChange={(e) => setEnTranscripciones(e.target.checked)}
          />
          <span>
            Buscar dentro del texto de las transcripciones
            {enTranscripciones && busqueda.trim().length < 3
              ? " (escribe al menos 3 letras)"
              : ""}
          </span>
        </label>
      )}

      {todosLosTags.length > 0 && (
        <div className="tags tags-filtro">
          {todosLosTags.map((t) => (
            <button
              key={t}
              className={`tag tag-boton ${filtroTag === t ? "activo" : ""}`}
              onClick={() => setFiltroTag(filtroTag === t ? null : t)}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      {datos.grabaciones.length === 0 ? (
        <p className="vacio">
          Todavía no hay grabaciones. Empieza por la pestaña Grabar.
        </p>
      ) : (
        <div className="biblioteca-layout">
          <div className="columna-lista">
            {enTranscripciones && busqueda.trim().length >= 3 ? (
              <ResultadosTexto
                coincidencias={coincidencias}
                grabaciones={datos.grabaciones}
                buscando={buscando}
                seleccionada={seleccionada}
                onSeleccionar={setSeleccionada}
              />
            ) : vista === "pendientes" ? (
              <Pendientes
                grabaciones={filtradas}
                seleccionada={seleccionada}
                onSeleccionar={setSeleccionada}
              />
            ) : vista === "arbol" ? (
              filtradas.length === 0 ? (
                <p className="vacio">Ninguna grabación coincide con el filtro.</p>
              ) : (
                arbol.map((clase) => (
                  <details key={clase.claveClase} open className="grupo">
                    <summary>
                      <span
                        className="punto"
                        style={{ background: clase.color }}
                      />
                      {clase.nombre}
                      <span className="sutil">
                        {clase.unidades.reduce(
                          (n, u) => n + u.items.length,
                          0,
                        )}
                      </span>
                    </summary>
                    {clase.unidades.map((unidad) => (
                      <details key={unidad.claveUnidad} open className="subgrupo">
                        <summary>
                          {unidad.nombre}
                          <span className="sutil">{unidad.items.length}</span>
                        </summary>
                        <ul className="lista">
                          {unidad.items.map((g) => (
                            <FilaGrabacion
                              key={g.id}
                              grabacion={g}
                              activa={g.id === seleccionada}
                              onClick={() => setSeleccionada(g.id)}
                            />
                          ))}
                        </ul>
                      </details>
                    ))}
                  </details>
                ))
              )
            ) : (
              <Calendario
                grabaciones={filtradas}
                clases={datos.clases}
                diaSeleccionado={diaSeleccionado}
                onSeleccionarDia={setDiaSeleccionado}
                seleccionada={seleccionada}
                onSeleccionarGrabacion={setSeleccionada}
              />
            )}
          </div>

          <div className="columna-detalle">
            {grabacion ? (
              <DetalleGrabacion
                key={grabacion.id}
                grabacion={grabacion}
                progresoConversion={conversiones[grabacion.id]}
                resaltar={enTranscripciones ? busqueda.trim() : undefined}
                onEliminada={() => setSeleccionada(null)}
              />
            ) : (
              <p className="vacio">
                Selecciona una grabación para escucharla y editarla.
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function ResultadosTexto({
  coincidencias,
  grabaciones,
  buscando,
  seleccionada,
  onSeleccionar,
}: {
  coincidencias: Map<string, Coincidencia>;
  grabaciones: Grabacion[];
  buscando: boolean;
  seleccionada: string | null;
  onSeleccionar(id: string): void;
}) {
  if (buscando) return <p className="sutil">Buscando en las transcripciones…</p>;
  if (coincidencias.size === 0) {
    return (
      <p className="vacio">
        No se encontró ese texto en ninguna transcripción.
      </p>
    );
  }

  const ordenadas = [...coincidencias.values()].sort(
    (a, b) => b.cantidad - a.cantidad,
  );

  return (
    <ul className="lista">
      {ordenadas.map((c) => {
        const g = grabaciones.find((x) => x.id === c.grabacionId);
        if (!g) return null;
        return (
          <li
            key={c.grabacionId}
            className={`item item-resultado ${
              c.grabacionId === seleccionada ? "activo" : ""
            }`}
            onClick={() => onSeleccionar(c.grabacionId)}
          >
            <div className="item-texto">
              <strong>
                {g.claseNombre} · {g.unidadNombre}
              </strong>
              <small className="sutil">
                {formatearFecha(g.fechaISO)} · {c.cantidad}{" "}
                {c.cantidad === 1 ? "aparición" : "apariciones"}
              </small>
              {c.fragmentos.map((f, i) => (
                <small key={i} className="fragmento">
                  {f}
                </small>
              ))}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function FilaGrabacion({
  grabacion,
  activa,
  mostrarClase,
  onClick,
}: {
  grabacion: Grabacion;
  activa: boolean;
  mostrarClase?: boolean;
  onClick(): void;
}) {
  return (
    <li className={`item ${activa ? "activo" : ""}`} onClick={onClick}>
      <div className="item-texto">
        <strong>
          {formatearFecha(grabacion.fechaISO)} · {formatearHora(grabacion.fechaISO)}
        </strong>
        <small className="sutil">
          {mostrarClase ? `${grabacion.claseNombre} · ` : ""}
          {formatearDuracion(grabacion.duracionSeg)}
          {grabacion.marcas.length > 0
            ? ` · ${grabacion.marcas.length} ${
                grabacion.marcas.length === 1 ? "marca" : "marcas"
              }`
            : ""}
          {grabacion.transcripcion ? " · transcrita" : ""}
        </small>
      </div>
      {grabacion.estado === "convirtiendo" && (
        <span className="chip">convirtiendo</span>
      )}
      {grabacion.estado === "error-conversion" && (
        <span className="chip chip-error" title={grabacion.errorConversion ?? ""}>
          <Icono nombre="alerta" tamano={13} />
        </span>
      )}
    </li>
  );
}
