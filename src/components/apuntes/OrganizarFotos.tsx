/**
 * Mesón de organización: ver toda una tanda junta y repartirla en apuntes.
 *
 * El modo ráfaga decide hoja por hoja y no deja ver el conjunto, que es
 * exactamente lo que hace falta cuando las hojas se mezclaron físicamente y el
 * número del marcador se repite entre corridas de impresión. Acá se ven las
 * fotos todas juntas, se agrupan, se ordenan, y recién después empieza el
 * recorte.
 *
 * Nada de esta pantalla escribe en disco. Lo único que produce es la lista de
 * apuntes a armar con sus fotos en orden; los archivos los sigue creando la
 * ráfaga, uno por hoja confirmada, igual que siempre.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { useStore } from "../../estado/store";
import { analizarFoto, type AnalisisFoto } from "../../lib/escaneo";
import { nombreArchivo } from "../../lib/paths";
import {
  asignar,
  devolverAlMeson,
  moverEnGrupo,
  numerosRepetidos,
  ordenDelMeson,
  sinAsignar,
  type GrupoOrganizado,
} from "../../lib/organizar";
import { SIN_CLASE, type Clase } from "../../types";
import { Icono } from "../ui/Icono";

/**
 * Cuántas fotos se analizan a la vez.
 *
 * Cada análisis carga una foto de 12 MP y le corre encima el detector de
 * marcadores, así que el techo es la memoria, no los núcleos: tres en vuelo son
 * unos 400 MB y bajan la espera de una tanda de 68 de minutos a poco más de uno.
 */
const CONCURRENCIA = 3;

/** Cuántos apuntes se pueden asignar con las teclas 1-9. */
const ATAJOS_MAXIMOS = 9;

interface Props {
  fotos: string[];
  /** Destino que traía la cola, para el primer apunte. */
  claseId: string | null;
  unidadId: string | null;
  onOrganizado(grupos: GrupoOrganizado[], analisis: Map<string, AnalisisFoto>): void;
  onCancelar(): void;
}

function tituloDe(clase: Clase | null, unidadNombre: string | null): string {
  const fecha = new Date().toISOString().slice(0, 10);
  return `Apunte ${fecha} - ${unidadNombre ?? clase?.nombre ?? SIN_CLASE}`;
}

export function OrganizarFotos({
  fotos,
  claseId,
  unidadId,
  onOrganizado,
  onCancelar,
}: Props) {
  const { datos, config } = useStore();
  const plantilla = config.apuntes.plantilla;

  const [analisis, setAnalisis] = useState<Map<string, AnalisisFoto>>(new Map());
  const [fallidas, setFallidas] = useState<Map<string, string>>(new Map());
  const [analizadas, setAnalizadas] = useState(0);

  const [grupos, setGrupos] = useState<GrupoOrganizado[]>([]);
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const [ultimoClic, setUltimoClic] = useState<string | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const [tamano, setTamano] = useState<"chico" | "medio" | "grande">("medio");
  const [formGrupo, setFormGrupo] = useState<{ claseId: string | null; unidadId: string | null } | null>(
    null,
  );

  // Deshacer: copias del array de grupos, que es lo único que el usuario
  // modifica. Con 68 fotos cada copia son unos pocos kB, así que guardar el
  // estado entero es más simple y más seguro que invertir operaciones.
  const historial = useRef<GrupoOrganizado[][]>([]);
  const futuro = useRef<GrupoOrganizado[][]>([]);
  // La foto sobre la que está el mouse, para que la barra espaciadora sepa cuál
  // agrandar sin obligar a hacer clic antes.
  const encima = useRef<string | null>(null);

  const cambiar = useCallback((siguiente: GrupoOrganizado[]) => {
    setGrupos((actuales) => {
      historial.current = [...historial.current.slice(-49), actuales];
      futuro.current = [];
      return siguiente;
    });
  }, []);

  const deshacer = useCallback(() => {
    const previo = historial.current.pop();
    if (!previo) return;
    setGrupos((actuales) => {
      futuro.current = [...futuro.current, actuales];
      return previo;
    });
  }, []);

  const rehacer = useCallback(() => {
    const siguiente = futuro.current.pop();
    if (!siguiente) return;
    setGrupos((actuales) => {
      historial.current = [...historial.current, actuales];
      return siguiente;
    });
  }, []);

  // ------------------------------------------------------------- análisis

  useEffect(() => {
    let vigente = true;
    let siguiente = 0;

    const trabajador = async () => {
      while (vigente) {
        const i = siguiente++;
        if (i >= fotos.length) return;
        const ruta = fotos[i];
        try {
          const a = await analizarFoto(ruta, plantilla);
          if (!vigente) return;
          setAnalisis((m) => new Map(m).set(ruta, a));
        } catch (e) {
          if (!vigente) return;
          setFallidas((m) => new Map(m).set(ruta, e instanceof Error ? e.message : String(e)));
        } finally {
          if (vigente) setAnalizadas((n) => n + 1);
        }
      }
    };

    void Promise.all(Array.from({ length: CONCURRENCIA }, trabajador));
    return () => {
      vigente = false;
    };
  }, [fotos, plantilla]);

  const listo = analizadas >= fotos.length;

  // ------------------------------------------------------- orden del mesón

  const numeros = useMemo(
    () => new Map(fotos.map((f) => [f, analisis.get(f)?.pagina ?? null])),
    [fotos, analisis],
  );
  // Las que no se pudieron abrir no entran al mesón: no hay nada que mirar ni
  // nada que recortar después.
  const utilizables = useMemo(() => fotos.filter((f) => !fallidas.has(f)), [fotos, fallidas]);
  const ordenadas = useMemo(() => ordenDelMeson(utilizables, numeros), [utilizables, numeros]);
  const repetidos = useMemo(() => numerosRepetidos(utilizables, numeros), [utilizables, numeros]);
  const meson = useMemo(() => sinAsignar(ordenadas, grupos), [ordenadas, grupos]);

  // ---------------------------------------------------------- selección

  const clicEnFoto = (ruta: string, e: React.MouseEvent) => {
    if (e.shiftKey && ultimoClic) {
      const desde = meson.indexOf(ultimoClic);
      const hasta = meson.indexOf(ruta);
      if (desde !== -1 && hasta !== -1) {
        const [a, b] = desde < hasta ? [desde, hasta] : [hasta, desde];
        setSeleccion(new Set(meson.slice(a, b + 1)));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      setSeleccion((s) => {
        const n = new Set(s);
        if (n.has(ruta)) n.delete(ruta);
        else n.add(ruta);
        return n;
      });
    } else {
      setSeleccion(new Set([ruta]));
    }
    setUltimoClic(ruta);
  };

  const asignarSeleccion = useCallback(
    (clave: string) => {
      if (seleccion.size === 0) return;
      // En el orden del mesón, no en el que se fueron clickeando: es el orden
      // que el usuario está viendo, y el que espera que quede en el apunte.
      const enOrden = meson.filter((f) => seleccion.has(f));
      cambiar(asignar(grupos, clave, enOrden));
      setSeleccion(new Set());
    },
    [cambiar, grupos, meson, seleccion],
  );

  // ----------------------------------------------------------- atajos

  useEffect(() => {
    const alBajar = (e: KeyboardEvent) => {
      const enCampo =
        e.target instanceof HTMLElement &&
        ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName);
      if (enCampo) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) rehacer();
        else deshacer();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSeleccion(new Set(meson));
        return;
      }
      if (e.key === "Escape") {
        if (zoom) setZoom(null);
        else setSeleccion(new Set());
        return;
      }
      if (e.code === "Space") {
        // Mantener espacio agranda la hoja de abajo del mouse: sin esto la letra
        // manuscrita no se lee y la pantalla no sirve para lo que se hizo.
        if (encima.current) {
          e.preventDefault();
          setZoom(encima.current);
        }
        return;
      }
      const n = Number(e.key);
      if (n >= 1 && n <= ATAJOS_MAXIMOS && grupos[n - 1]) {
        e.preventDefault();
        asignarSeleccion(grupos[n - 1].clave);
      }
    };
    const alSubir = (e: KeyboardEvent) => {
      if (e.code === "Space") setZoom(null);
    };
    window.addEventListener("keydown", alBajar);
    window.addEventListener("keyup", alSubir);
    return () => {
      window.removeEventListener("keydown", alBajar);
      window.removeEventListener("keyup", alSubir);
    };
  }, [asignarSeleccion, deshacer, grupos, meson, rehacer, zoom]);

  // ----------------------------------------------------------- grupos

  const crearGrupo = () => {
    if (!formGrupo) return;
    const c = datos.clases.find((x) => x.id === formGrupo.claseId) ?? null;
    const u = c?.unidades.find((x) => x.id === formGrupo.unidadId) ?? null;
    cambiar([
      ...grupos,
      {
        clave: crypto.randomUUID(),
        claseId: formGrupo.claseId,
        unidadId: formGrupo.unidadId,
        titulo: tituloDe(c, u?.nombre ?? null),
        fotos: [],
      },
    ]);
    setFormGrupo(null);
  };

  const renombrar = (clave: string, titulo: string) =>
    setGrupos((gs) => gs.map((g) => (g.clave === clave ? { ...g, titulo } : g)));

  const borrarGrupo = (clave: string) => {
    const g = grupos.find((x) => x.clave === clave);
    if (!g) return;
    cambiar(grupos.filter((x) => x.clave !== clave));
  };

  // --------------------------------------------------------- arrastre

  const empezarArrastre = (ruta: string, e: React.DragEvent) => {
    // Arrastrar una hoja que no estaba seleccionada arrastra solo esa: si no,
    // el gesto movería una selección vieja que el usuario ya no tiene presente.
    if (!seleccion.has(ruta)) setSeleccion(new Set([ruta]));
    // Chrome y Firefox no inician el arrastre sin datos en el portapapeles.
    e.dataTransfer.setData("text/plain", ruta);
    e.dataTransfer.effectAllowed = "move";
  };

  const soltarEnGrupo = (clave: string, e: React.DragEvent) => {
    e.preventDefault();
    const suelta = e.dataTransfer.getData("text/plain");
    const fotosAMover = seleccion.size > 0 ? meson.filter((f) => seleccion.has(f)) : [suelta];
    cambiar(asignar(grupos, clave, fotosAMover.filter(Boolean)));
    setSeleccion(new Set());
  };

  const soltarEnMeson = (e: React.DragEvent) => {
    e.preventDefault();
    const suelta = e.dataTransfer.getData("text/plain");
    if (suelta) cambiar(devolverAlMeson(grupos, [suelta]));
  };

  // ------------------------------------------------------------ render

  if (!listo) {
    return (
      <div className="organizar">
        <h3>Preparando la tanda</h3>
        <div className="progreso">
          <div
            className="progreso-valor"
            style={{ width: `${fotos.length ? (analizadas / fotos.length) * 100 : 0}%` }}
          />
        </div>
        <p className="sutil">
          Analizando {analizadas} de {fotos.length} fotos: se buscan los marcadores y los
          bordes de cada hoja. Esto se hace una sola vez — el recorte de después
          reusa lo que salga de acá.
        </p>
        {fallidas.size > 0 && (
          <p className="sutil">
            {fallidas.size} {fallidas.size === 1 ? "foto no se pudo abrir" : "fotos no se pudieron abrir"}.
          </p>
        )}
        <button className="btn" onClick={onCancelar}>
          Cancelar
        </button>
      </div>
    );
  }

  const asignadas = grupos.reduce((t, g) => t + g.fotos.length, 0);
  const gruposConFotos = grupos.filter((g) => g.fotos.length > 0);
  const claseDelForm = datos.clases.find((c) => c.id === formGrupo?.claseId) ?? null;

  return (
    <div className="organizar">
      <div className="organizar-cabecera">
        <div>
          <h3>Organizar la tanda</h3>
          <p className="sutil">
            Arrastra las hojas al apunte que les toca, o selecciónalas y aprieta el
            número que aparece al lado. Mantén <kbd>Espacio</kbd> sobre una hoja para
            verla grande.
          </p>
        </div>
        <label className="selector-fila">
          <span>Tamaño</span>
          <select value={tamano} onChange={(e) => setTamano(e.target.value as typeof tamano)}>
            <option value="chico">Chico</option>
            <option value="medio">Mediano</option>
            <option value="grande">Grande</option>
          </select>
        </label>
        <button className="btn" onClick={onCancelar}>
          Cancelar
        </button>
      </div>

      {fallidas.size > 0 && (
        <div className="aviso aviso-error">
          <Icono nombre="alerta" />
          <span>
            {fallidas.size} {fallidas.size === 1 ? "foto quedó fuera" : "fotos quedaron fuera"} porque
            no se pudieron abrir: {[...fallidas.keys()].map(nombreArchivo).join(", ")}.
          </span>
        </div>
      )}

      {repetidos.size > 0 && (
        <div className="aviso aviso-cambio-destino">
          <Icono nombre="alerta" />
          <span>
            Hay números de página repetidos ({[...repetidos].sort((a, b) => a - b).join(", ")}):
            son hojas de corridas de impresión distintas. Ahí el número no alcanza para
            ordenar, hay que mirar el contenido.
          </span>
        </div>
      )}

      <div className="organizar-cuerpo">
        <aside className="organizar-apuntes">
          <div className="organizar-apuntes-cabecera">
            <strong>Apuntes</strong>
            <button
              className="btn"
              onClick={() => setFormGrupo({ claseId, unidadId })}
              disabled={formGrupo !== null}
            >
              Nuevo
            </button>
          </div>

          {formGrupo && (
            <div className="tarjeta organizar-form">
              <label>
                <span>Clase</span>
                <select
                  value={formGrupo.claseId ?? ""}
                  onChange={(e) =>
                    setFormGrupo((f) => f && { ...f, claseId: e.target.value || null, unidadId: null })
                  }
                >
                  <option value="">Sin clasificar</option>
                  {datos.clases.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nombre}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Unidad</span>
                <select
                  value={formGrupo.unidadId ?? ""}
                  onChange={(e) => setFormGrupo((f) => f && { ...f, unidadId: e.target.value || null })}
                  disabled={!claseDelForm}
                >
                  <option value="">Sin unidad</option>
                  {claseDelForm?.unidades.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.nombre}
                    </option>
                  ))}
                </select>
              </label>
              <div className="acciones-fila">
                <button className="btn" onClick={() => setFormGrupo(null)}>
                  Cancelar
                </button>
                <button className="btn btn-primario" onClick={crearGrupo}>
                  Crear apunte
                </button>
              </div>
            </div>
          )}

          {grupos.length === 0 && !formGrupo && (
            <p className="sutil">
              Todavía no hay ninguno. Crea el primero y arrástrale las hojas que le
              correspondan.
            </p>
          )}

          {grupos.map((g, i) => (
            <div
              key={g.clave}
              className="organizar-apunte"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => soltarEnGrupo(g.clave, e)}
            >
              <div className="organizar-apunte-cabecera">
                {i < ATAJOS_MAXIMOS && <kbd>{i + 1}</kbd>}
                <input
                  value={g.titulo}
                  onChange={(e) => renombrar(g.clave, e.target.value)}
                  title="Título del apunte"
                />
                <span className="sutil">{g.fotos.length}</span>
                <button
                  className="btn btn-icono"
                  onClick={() => borrarGrupo(g.clave)}
                  title="Quitar este apunte y devolver sus hojas al mesón"
                >
                  <Icono nombre="basura" />
                </button>
              </div>
              <p className="sutil">
                {datos.clases.find((c) => c.id === g.claseId)?.nombre ?? SIN_CLASE}
                {g.unidadId &&
                  ` · ${
                    datos.clases
                      .find((c) => c.id === g.claseId)
                      ?.unidades.find((u) => u.id === g.unidadId)?.nombre ?? ""
                  }`}
              </p>
              {g.fotos.length > 0 && (
                <ol className="organizar-paginas">
                  {g.fotos.map((f, indice) => (
                    <li
                      key={f}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", f);
                        e.dataTransfer.setData("application/x-indice", String(indice));
                      }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const desde = Number(e.dataTransfer.getData("application/x-indice"));
                        if (Number.isInteger(desde)) {
                          cambiar(moverEnGrupo(grupos, g.clave, desde, indice));
                        }
                      }}
                      onMouseEnter={() => (encima.current = f)}
                      onMouseLeave={() => (encima.current = null)}
                      title={`Página ${indice + 1} — arrastra para reordenar`}
                    >
                      <img
                        src={convertFileSrc(analisis.get(f)?.vistaPrevia ?? "")}
                        alt={`Página ${indice + 1}`}
                        loading="lazy"
                      />
                      <span>{indice + 1}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          ))}
        </aside>

        <section
          className={`organizar-meson meson-${tamano}`}
          onDragOver={(e) => e.preventDefault()}
          onDrop={soltarEnMeson}
        >
          {meson.length === 0 ? (
            <p className="vacio">
              Todas las hojas están repartidas. Puedes seguir al recorte.
            </p>
          ) : (
            meson.map((f) => {
              const a = analisis.get(f);
              const numero = a?.pagina ?? null;
              return (
                <figure
                  key={f}
                  className={`organizar-hoja${seleccion.has(f) ? " elegida" : ""}`}
                  draggable
                  onDragStart={(e) => empezarArrastre(f, e)}
                  onClick={(e) => clicEnFoto(f, e)}
                  onMouseEnter={() => (encima.current = f)}
                  onMouseLeave={() => (encima.current = null)}
                >
                  <img
                    src={convertFileSrc(a?.vistaPrevia ?? "")}
                    alt={nombreArchivo(f)}
                    loading="lazy"
                  />
                  <button
                    className="organizar-lupa"
                    onClick={(e) => {
                      e.stopPropagation();
                      setZoom(f);
                    }}
                    title="Ver grande"
                  >
                    <Icono nombre="lupa" />
                  </button>
                  <figcaption>
                    {numero === null ? (
                      <span className="sutil">sin marcador</span>
                    ) : (
                      <span className={repetidos.has(numero) ? "numero-repetido" : undefined}>
                        pág. {numero}
                        {repetidos.has(numero) && " ⚠"}
                      </span>
                    )}
                  </figcaption>
                </figure>
              );
            })
          )}
        </section>
      </div>

      <div className="organizar-pie">
        <span>
          {asignadas} de {utilizables.length} hojas repartidas
          {gruposConFotos.length > 0 &&
            ` en ${gruposConFotos.length} ${gruposConFotos.length === 1 ? "apunte" : "apuntes"}`}
        </span>
        <button className="btn" onClick={deshacer} disabled={historial.current.length === 0}>
          Deshacer
        </button>
        <button
          className="btn btn-primario"
          onClick={() => onOrganizado(gruposConFotos, analisis)}
          disabled={meson.length > 0 || gruposConFotos.length === 0}
          title={
            meson.length > 0
              ? `Faltan ${meson.length} hojas por repartir.`
              : "Empieza el recorte de todas las hojas."
          }
        >
          Seguir al recorte
        </button>
      </div>

      {zoom && (
        <div className="organizar-zoom" onClick={() => setZoom(null)}>
          <img src={convertFileSrc(analisis.get(zoom)?.vistaPrevia ?? "")} alt="Hoja ampliada" />
        </div>
      )}
    </div>
  );
}
