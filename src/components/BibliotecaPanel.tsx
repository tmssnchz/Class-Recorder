import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useGrabador } from "../estado/grabador";
import { useStore } from "../estado/store";
import { esPlaceholder } from "../lib/almacenamiento";
import { vigentes } from "../lib/apuntes";
import { construirArbol } from "../lib/arbol";
import {
  buscarEnApuntes,
  buscarEnTranscripciones,
  type Coincidencia,
  type CoincidenciaApunte,
} from "../lib/busqueda";
import { formatearDuracion, formatearFecha, formatearHora } from "../lib/format";
import { type Apunte, type Grabacion } from "../types";
import { Calendario } from "./biblioteca/Calendario";
import { DetalleGrabacion } from "./biblioteca/DetalleGrabacion";
import { Pendientes } from "./biblioteca/Pendientes";
import { VistaApunte } from "./biblioteca/VistaApunte";
import { Icono } from "./ui/Icono";

type Vista = "arbol" | "calendario" | "pendientes";

/**
 * El árbol de la Biblioteca muestra las dos cosas que cuelgan de una unidad:
 * lo grabado y lo escaneado. Se distinguen por `paginas`, que solo tiene el
 * apunte.
 */
type ItemBiblioteca = Grabacion | Apunte;
const esApunte = (i: ItemBiblioteca): i is Apunte => "paginas" in i;

export function BibliotecaPanel({
  onCorregirApunte,
}: {
  /** Manda un apunte a la pestaña Digitalizar, ya abierto en su editor. */
  onCorregirApunte?(apunteId: string): void;
}) {
  const { datos } = useStore();
  const { conversiones } = useGrabador();

  const [vista, setVista] = useState<Vista>("arbol");
  const [busqueda, setBusqueda] = useState("");
  const [filtroClase, setFiltroClase] = useState<string>("");
  const [filtroTag, setFiltroTag] = useState<string | null>(null);
  const [diaSeleccionado, setDiaSeleccionado] = useState<string | null>(null);
  const [seleccionada, setSeleccionada] = useState<string | null>(null);
  // La columna de detalle muestra una grabación o un apunte: elegir uno suelta
  // el otro, igual que en cualquier lista de un solo panel de detalle.
  const [apunteAbierto, setApunteAbierto] = useState<string | null>(null);
  // Modo lectura: la lista se aparta y la hoja se queda con todo el ancho.
  // Solo tiene sentido con un apunte abierto, así que se suelta al cerrarlo.
  const [lectura, setLectura] = useState(false);
  // Colapsado por defecto; se pierde al reiniciar (no vale la pena persistirlo).
  const [expandidas, setExpandidas] = useState<Set<string>>(new Set());
  const [enTranscripciones, setEnTranscripciones] = useState(false);
  const [coincidencias, setCoincidencias] = useState<Map<string, Coincidencia>>(
    new Map(),
  );
  const [buscando, setBuscando] = useState(false);
  const [enApuntes, setEnApuntes] = useState<Map<string, CoincidenciaApunte>>(new Map());

  const hayTranscripciones = datos.grabaciones.some(
    (g) => g.transcripcion || g.notaClase,
  );
  const sinTranscribir = datos.grabaciones.filter(
    (g) => !g.transcripcion && g.estado !== "convirtiendo",
  ).length;

  // La búsqueda dentro del texto lee archivos: se espera a que dejes de escribir.
  useEffect(() => {
    if (!enTranscripciones || busqueda.trim().length < 3) {
      setCoincidencias(new Map());
      setEnApuntes(new Map());
      setBuscando(false);
      return;
    }
    setBuscando(true);
    let vigente = true;
    const temporizador = setTimeout(() => {
      void Promise.all([
        buscarEnTranscripciones(datos.grabaciones, busqueda),
        buscarEnApuntes(datos.apuntes, busqueda),
      ]).then(([enTexto, enHojas]) => {
        if (!vigente) return;
        setCoincidencias(enTexto);
        setEnApuntes(enHojas);
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
    for (const a of datos.apuntes) for (const t of a.tags) set.add(t);
    return [...set].sort();
  }, [datos.grabaciones, datos.apuntes]);

  const hayFiltros = Boolean(busqueda || filtroClase || filtroTag);

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
          g.marcas.some((m) => m.nota.toLowerCase().includes(q)) ||
          g.notaClase.toLowerCase().includes(q)
        );
      })
      .sort(
        (a, b) =>
          new Date(b.fechaISO).getTime() - new Date(a.fechaISO).getTime(),
      );
  }, [datos.grabaciones, busqueda, filtroClase, filtroTag]);

  // Los apuntes se filtran por su cuenta —no tienen duración ni marcas— y
  // después entran al mismo árbol, colgando de la misma unidad.
  const apuntes = useMemo(() => vigentes(datos.apuntes), [datos.apuntes]);

  const apuntesFiltrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return apuntes
      .filter((a) => {
        if (filtroClase && a.claseId !== filtroClase) return false;
        if (filtroTag && !a.tags.includes(filtroTag)) return false;
        if (!q) return true;
        return [a.titulo, a.claseNombre, a.unidadNombre, a.nota ?? "", ...a.tags]
          .join(" ")
          .toLowerCase()
          .includes(q);
      })
      .sort((a, b) => b.fechaISO.localeCompare(a.fechaISO));
  }, [apuntes, busqueda, filtroClase, filtroTag]);

  const arbol = useMemo(
    () =>
      construirArbol<ItemBiblioteca>(
        datos.clases,
        [...filtradas, ...apuntesFiltrados],
        hayFiltros,
      ),
    [filtradas, apuntesFiltrados, datos.clases, hayFiltros],
  );

  const alternarExpandida = (clave: string) => {
    setExpandidas((prev) => {
      const copia = new Set(prev);
      if (copia.has(clave)) copia.delete(clave);
      else copia.add(clave);
      return copia;
    });
  };

  const expandirTodo = () => {
    const todas = new Set<string>();
    for (const c of arbol) {
      todas.add(c.claveClase);
      for (const u of c.unidades) todas.add(u.claveUnidad);
    }
    setExpandidas(todas);
  };

  const colapsarTodo = () => setExpandidas(new Set());

  const elegirGrabacion = (id: string) => {
    setApunteAbierto(null);
    setLectura(false);
    setSeleccionada(id);
  };

  const elegirApunte = (id: string) => {
    setSeleccionada(null);
    setApunteAbierto(id);
  };

  const grabacion = datos.grabaciones.find((g) => g.id === seleccionada) ?? null;
  const apunte = datos.apuntes.find((a) => a.id === apunteAbierto) ?? null;

  // Si la seleccionada desaparece del filtro (o se elimina), soltamos el detalle.
  useEffect(() => {
    if (seleccionada && !datos.grabaciones.some((g) => g.id === seleccionada)) {
      setSeleccionada(null);
    }
  }, [datos.grabaciones, seleccionada]);

  useEffect(() => {
    if (apunteAbierto && !datos.apuntes.some((a) => a.id === apunteAbierto)) {
      setApunteAbierto(null);
      setLectura(false);
    }
  }, [datos.apuntes, apunteAbierto]);

  return (
    <section className="panel panel-ancho">
      <header className="panel-cabecera">
        <div>
          <h2>Biblioteca</h2>
          <p className="sutil">
            {datos.grabaciones.length}{" "}
            {datos.grabaciones.length === 1 ? "grabación" : "grabaciones"}
            {apuntes.length > 0 &&
              ` · ${apuntes.length} ${apuntes.length === 1 ? "apunte" : "apuntes"}`}
            {hayFiltros
              ? ` · ${filtradas.length + apuntesFiltrados.length} coinciden con el filtro`
              : ""}
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
            Buscar dentro del texto de las transcripciones y las notas de clase
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

      {datos.grabaciones.length === 0 && apuntes.length === 0 && datos.clases.length === 0 ? (
        <p className="vacio">
          Todavía no hay nada. Crea una clase en la pestaña Clases, o graba
          directamente desde Grabar.
        </p>
      ) : (
        <div className={`biblioteca-layout ${apunte && lectura ? "en-lectura" : ""}`}>
          <div className="columna-lista">
            {enTranscripciones && busqueda.trim().length >= 3 ? (
              <>
                <ResultadosTexto
                  coincidencias={coincidencias}
                  grabaciones={datos.grabaciones}
                  buscando={buscando}
                  seleccionada={seleccionada}
                  onSeleccionar={setSeleccionada}
                />
                <ResultadosApuntes
                  coincidencias={enApuntes}
                  apuntes={datos.apuntes}
                  onAbrir={elegirApunte}
                />
              </>
            ) : vista === "pendientes" ? (
              <Pendientes
                grabaciones={filtradas}
                seleccionada={seleccionada}
                onSeleccionar={setSeleccionada}
              />
            ) : vista === "arbol" ? (
              arbol.length === 0 ? (
                <p className="vacio">
                  {hayFiltros
                    ? "Nada coincide con el filtro."
                    : "Todavía no hay clases, grabaciones ni apuntes."}
                </p>
              ) : (
                <>
                  {!hayFiltros && (
                    <div className="arbol-acciones">
                      <button className="btn btn-mini" onClick={expandirTodo}>
                        Expandir todo
                      </button>
                      <button className="btn btn-mini" onClick={colapsarTodo}>
                        Colapsar todo
                      </button>
                    </div>
                  )}
                  {arbol.map((clase) => {
                    // Con un filtro activo se fuerza todo abierto: si no, un
                    // resultado quedaría escondido detrás de una clase colapsada.
                    const claseAbierta = hayFiltros || expandidas.has(clase.claveClase);
                    return (
                      <details
                        key={clase.claveClase}
                        open={claseAbierta}
                        onToggle={(e) => {
                          if (hayFiltros) return;
                          alternarExpandida(clase.claveClase);
                          e.stopPropagation();
                        }}
                        className="grupo"
                      >
                        <summary>
                          <span
                            className="punto"
                            style={{ background: clase.color }}
                          />
                          {clase.nombre}
                          <span
                            className="cuenta"
                            title="Grabaciones y apuntes de esta clase"
                          >
                            {clase.unidades.reduce(
                              (n, u) => n + u.items.length,
                              0,
                            )}
                          </span>
                        </summary>
                        {clase.unidades.length === 0 ? (
                          <p className="rama-vacia sutil">
                            Esta clase no tiene unidades todavía.
                          </p>
                        ) : (
                          clase.unidades.map((unidad) => {
                            const unidadAbierta =
                              hayFiltros || expandidas.has(unidad.claveUnidad);
                            return (
                              <details
                                key={unidad.claveUnidad}
                                open={unidadAbierta}
                                onToggle={(e) => {
                                  if (hayFiltros) return;
                                  alternarExpandida(unidad.claveUnidad);
                                  e.stopPropagation();
                                }}
                                className="subgrupo"
                              >
                                <summary>
                                  {unidad.nombre}
                                  <span
                                    className="cuenta"
                                    title="Grabaciones y apuntes de esta unidad"
                                  >
                                    {unidad.items.length}
                                  </span>
                                </summary>
                                {unidad.items.length === 0 ? (
                                  <p className="rama-vacia sutil">Sin grabaciones ni apuntes.</p>
                                ) : (
                                  <div className="unidad-columnas">
                                    <ColumnaUnidad
                                      singular="grabación"
                                      plural="grabaciones"
                                      vacia="Sin grabaciones."
                                      cantidad={unidad.items.filter((i) => !esApunte(i)).length}
                                    >
                                      {unidad.items
                                        .filter((i): i is Grabacion => !esApunte(i))
                                        .map((g) => (
                                          <FilaGrabacion
                                            key={g.id}
                                            grabacion={g}
                                            activa={g.id === seleccionada}
                                            onClick={() => elegirGrabacion(g.id)}
                                          />
                                        ))}
                                    </ColumnaUnidad>
                                    <ColumnaUnidad
                                      singular="apunte"
                                      plural="apuntes"
                                      vacia="Sin apuntes."
                                      cantidad={unidad.items.filter(esApunte).length}
                                    >
                                      {unidad.items.filter(esApunte).map((a) => (
                                        <FilaApunte
                                          key={a.id}
                                          apunte={a}
                                          activo={a.id === apunteAbierto}
                                          onClick={() => elegirApunte(a.id)}
                                        />
                                      ))}
                                    </ColumnaUnidad>
                                  </div>
                                )}
                              </details>
                            );
                          })
                        )}
                      </details>
                    );
                  })}
                </>
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
                onRecortada={elegirGrabacion}
              />
            ) : apunte ? (
              <VistaApunte
                key={apunte.id}
                apunte={apunte}
                lectura={lectura}
                onAlternarLectura={() => setLectura((v) => !v)}
                onCorregir={onCorregirApunte}
              />
            ) : (
              <p className="vacio">
                Selecciona una grabación para escucharla, o un apunte para leerlo.
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

/**
 * Lo encontrado dentro de los apuntes escaneados. Va aparte de las
 * transcripciones y no mezclado: son dos cosas distintas y el texto de un
 * apunte puede tener errores de reconocimiento, así que conviene que se vea
 * de dónde salió cada resultado.
 */
function ResultadosApuntes({
  coincidencias,
  apuntes,
  onAbrir,
}: {
  coincidencias: Map<string, CoincidenciaApunte>;
  apuntes: Apunte[];
  onAbrir?(apunteId: string): void;
}) {
  if (coincidencias.size === 0) return null;

  const ordenadas = [...coincidencias.values()].sort((a, b) => b.cantidad - a.cantidad);

  return (
    <>
      <h3 className="titulo-seccion">En apuntes escaneados</h3>
      <ul className="lista">
        {ordenadas.map((c) => {
          const a = apuntes.find((x) => x.id === c.apunteId);
          if (!a) return null;
          return (
            <li
              key={c.apunteId}
              className="item item-resultado"
              onClick={() => onAbrir?.(c.apunteId)}
            >
              <div className="item-texto">
                <strong>{a.titulo}</strong>
                <small className="sutil">
                  {a.claseNombre} · {a.unidadNombre} · {formatearFecha(a.fechaISO)} ·{" "}
                  {c.cantidad} {c.cantidad === 1 ? "aparición" : "apariciones"}
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
    </>
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
  const { config } = useStore();
  // Solo OneDrive deja placeholders; en local o Google Drive nunca hace falta consultar.
  const [enNube, setEnNube] = useState(false);

  useEffect(() => {
    if (config.modoAlmacenamiento !== "onedrive") {
      setEnNube(false);
      return;
    }
    let vigente = true;
    void esPlaceholder(grabacion.archivoAudio)
      .then((p) => vigente && setEnNube(p))
      .catch(() => undefined);
    return () => {
      vigente = false;
    };
  }, [grabacion.archivoAudio, config.modoAlmacenamiento]);

  return (
    <li className={`item ${activa ? "activo" : ""}`} onClick={onClick}>
      <div className="item-texto">
        <strong>
          <Icono nombre="micro" tamano={13} /> {formatearFecha(grabacion.fechaISO)} ·{" "}
          {formatearHora(grabacion.fechaISO)}
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
      {enNube && (
        <span className="chip" title="Solo en la nube: se descarga al reproducir">
          <Icono nombre="nube" tamano={13} />
        </span>
      )}
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

/**
 * Un apunte escaneado dentro del árbol. No abre el panel de detalle —ese es
 * para audio—: lleva al editor del apunte, en su propia pestaña.
 */
function FilaApunte({
  apunte,
  activo,
  onClick,
}: {
  apunte: Apunte;
  activo: boolean;
  onClick(): void;
}) {
  const paginas = apunte.paginas.length;
  return (
    <li className={`item ${activo ? "activo" : ""}`} onClick={onClick}>
      <div className="item-texto">
        <strong>
          <Icono nombre="apunte" tamano={13} /> {apunte.titulo}
        </strong>
        <small className="sutil">
          {formatearFecha(apunte.fechaISO)} · {paginas}{" "}
          {paginas === 1 ? "página" : "páginas"}
          {apunte.nota ? ` · ${apunte.nota}` : ""}
        </small>
      </div>
    </li>
  );
}

/**
 * Una de las dos columnas de una unidad. Se muestran las dos siempre, aunque
 * una esté vacía: el hueco dice "acá no hay apuntes de esta unidad", que es
 * información, y evita que las columnas bailen de lugar entre unidades.
 */
function ColumnaUnidad({
  singular,
  plural,
  vacia,
  cantidad,
  children,
}: {
  singular: string;
  plural: string;
  vacia: string;
  cantidad: number;
  children: ReactNode;
}) {
  return (
    <div className="unidad-columna">
      {/* El número va delante del sustantivo — "11 grabaciones" — porque
          suelto, al final del título, se lee como cualquier otra cosa. */}
      <h5>
        {cantidad} {cantidad === 1 ? singular : plural}
      </h5>
      {cantidad === 0 ? (
        <p className="rama-vacia sutil">{vacia}</p>
      ) : (
        <ul className="lista">{children}</ul>
      )}
    </div>
  );
}
