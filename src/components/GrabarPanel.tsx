import { useEffect, useState } from "react";

import { useGrabador } from "../estado/grabador";
import { useStore } from "../estado/store";
import { describirAtajo } from "../lib/atajos";
import { formatearBytes, formatearDuracion } from "../lib/format";
import { consultarEspacio, type EspacioDisco } from "../lib/grabaciones";
import { SIN_CLASE, SIN_UNIDAD } from "../types";
import { Icono } from "./ui/Icono";
import { Medidor } from "./ui/Medidor";
import { ModalConfirmacion } from "./ui/ModalConfirmacion";

/** Opus mono a 64 kbps ≈ 28,8 MB por hora. Sirve para estimar cuánto entra. */
const MB_POR_HORA = 28.8;
const BYTES_POR_GB = 1024 ** 3;

export function GrabarPanel() {
  const { datos, config, agregarClase, agregarUnidad } = useStore();
  const g = useGrabador();
  const [espacio, setEspacio] = useState<EspacioDisco | null>(null);

  const [creandoClase, setCreandoClase] = useState(false);
  const [nombreClaseNueva, setNombreClaseNueva] = useState("");
  const [creandoUnidad, setCreandoUnidad] = useState(false);
  const [nombreUnidadNueva, setNombreUnidadNueva] = useState("");
  const [errorCreacion, setErrorCreacion] = useState<string | null>(null);

  const clase = datos.clases.find((c) => c.id === g.seleccion.claseId) ?? null;
  const grabando = g.fase === "grabando";
  const pausado = g.fase === "pausado";
  const activo = grabando || pausado;
  // Mientras se mueven los archivos a la nueva carpeta, o al detener, los
  // selectores se congelan un instante para no pisar el rename en curso.
  const bloqueado = g.fase === "finalizando" || g.moviendoDestino;

  const crearClase = async (nombre: string) => {
    try {
      setErrorCreacion(null);
      const creada = await agregarClase(nombre);
      g.elegirClase(creada.id);
      setNombreClaseNueva("");
      setCreandoClase(false);
    } catch (e) {
      setErrorCreacion(e instanceof Error ? e.message : String(e));
    }
  };

  const crearUnidad = async (nombre: string) => {
    if (!clase) return;
    try {
      setErrorCreacion(null);
      const creada = await agregarUnidad(clase.id, nombre);
      g.elegirUnidad(creada.id);
      setNombreUnidadNueva("");
      setCreandoUnidad(false);
    } catch (e) {
      setErrorCreacion(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    let vigente = true;
    void consultarEspacio(config.carpetaRaiz)
      .then((e) => vigente && setEspacio(e))
      .catch(() => undefined);
    return () => {
      vigente = false;
    };
  }, [config.carpetaRaiz, g.fase]);

  const horasQueEntran = espacio
    ? Math.floor(espacio.libreBytes / 1024 / 1024 / MB_POR_HORA)
    : null;

  return (
    <section className="panel">
      <header className="panel-cabecera">
        <div>
          <h2>Grabar</h2>
          <p className="sutil">
            El audio se guarda en disco cada 5 segundos: si la app se cierra, no
            se pierde lo grabado.
          </p>
        </div>
      </header>

      {g.error && (
        <div className="aviso aviso-error">
          <Icono nombre="alerta" />
          <span>{g.error}</span>
          <button className="btn-icono" onClick={g.limpiarError}>
            <Icono nombre="equis" tamano={16} />
          </button>
        </div>
      )}

      {g.interrumpidas.length > 0 && !activo && (
        <div className="tarjeta tarjeta-recuperacion">
          <h3>
            <Icono nombre="alerta" tamano={17} />
            {g.interrumpidas.length === 1
              ? "Hay una grabación interrumpida"
              : `Hay ${g.interrumpidas.length} grabaciones interrumpidas`}
          </h3>
          <p className="sutil">
            La app se cerró mientras grababa. El audio hasta el último fragmento
            sigue en disco y se puede recuperar.
          </p>
          <ul className="lista">
            {g.interrumpidas.map((i) => (
              <li key={i.rutaParcial} className="item item-estatico">
                <div className="item-texto">
                  <strong>
                    {i.meta
                      ? `${i.meta.claseNombre} · ${i.meta.unidadNombre}`
                      : i.base}
                  </strong>
                  <small className="sutil">
                    {formatearBytes(i.bytes)}
                    {i.meta
                      ? ` · ${formatearDuracion(i.meta.duracionSeg)} grabados`
                      : ""}
                  </small>
                </div>
                <button
                  className="btn btn-primario"
                  onClick={() => void g.recuperarInterrumpida(i)}
                >
                  Recuperar
                </button>
                <button
                  className="btn"
                  onClick={() => void g.descartarInterrumpidaGrabacion(i)}
                >
                  Descartar
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="tarjeta">
        {activo && (
          <p className="sutil aviso-cambio-destino">
            Podés cambiar la clase o la unidad sin cortar la grabación: el
            audio se mueve a la carpeta nueva sin perder nada.
          </p>
        )}
        {errorCreacion && (
          <div className="aviso aviso-error">
            <Icono nombre="alerta" />
            <span>{errorCreacion}</span>
            <button className="btn-icono" onClick={() => setErrorCreacion(null)}>
              <Icono nombre="equis" tamano={16} />
            </button>
          </div>
        )}

        <div className="selectores">
          <label>
            <span>Clase</span>
            <div className="selector-fila">
              <select
                value={g.seleccion.claseId ?? ""}
                disabled={bloqueado}
                onChange={(e) => g.elegirClase(e.target.value || null)}
              >
                <option value="">{SIN_CLASE}</option>
                {datos.clases.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nombre}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn-icono"
                title="Nueva clase"
                disabled={bloqueado}
                onClick={() => {
                  setCreandoClase((v) => !v);
                  setCreandoUnidad(false);
                }}
              >
                <Icono nombre="mas" tamano={16} />
              </button>
            </div>
            {creandoClase && (
              <form
                className="form-linea"
                onSubmit={(e) => {
                  e.preventDefault();
                  void crearClase(nombreClaseNueva);
                }}
              >
                <input
                  autoFocus
                  value={nombreClaseNueva}
                  onChange={(e) => setNombreClaseNueva(e.target.value)}
                  placeholder="Nombre de la clase"
                  maxLength={80}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setCreandoClase(false);
                  }}
                />
                <button className="btn-icono" type="submit" title="Crear">
                  <Icono nombre="check" tamano={16} />
                </button>
                <button
                  className="btn-icono"
                  type="button"
                  title="Cancelar"
                  onClick={() => setCreandoClase(false)}
                >
                  <Icono nombre="equis" tamano={16} />
                </button>
              </form>
            )}
          </label>

          <label>
            <span>Unidad</span>
            <div className="selector-fila">
              <select
                value={g.seleccion.unidadId ?? ""}
                disabled={bloqueado || !clase}
                onChange={(e) => g.elegirUnidad(e.target.value || null)}
              >
                <option value="">{SIN_UNIDAD}</option>
                {clase?.unidades.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.nombre}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn-icono"
                title={clase ? "Nueva unidad" : "Elegí una clase primero"}
                disabled={bloqueado || !clase}
                onClick={() => {
                  setCreandoUnidad((v) => !v);
                  setCreandoClase(false);
                }}
              >
                <Icono nombre="mas" tamano={16} />
              </button>
            </div>
            {creandoUnidad && (
              <form
                className="form-linea"
                onSubmit={(e) => {
                  e.preventDefault();
                  void crearUnidad(nombreUnidadNueva);
                }}
              >
                <input
                  autoFocus
                  value={nombreUnidadNueva}
                  onChange={(e) => setNombreUnidadNueva(e.target.value)}
                  placeholder="Nombre de la unidad"
                  maxLength={80}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setCreandoUnidad(false);
                  }}
                />
                <button className="btn-icono" type="submit" title="Crear">
                  <Icono nombre="check" tamano={16} />
                </button>
                <button
                  className="btn-icono"
                  type="button"
                  title="Cancelar"
                  onClick={() => setCreandoUnidad(false)}
                >
                  <Icono nombre="equis" tamano={16} />
                </button>
              </form>
            )}
          </label>
        </div>

        <div className="cronometro-fila">
          <div className={`cronometro ${grabando ? "activo" : ""}`}>
            {grabando && <span className="punto-rec" />}
            {formatearDuracion(g.segundos)}
          </div>
          <Medidor leer={g.nivelActual} activo={grabando} />
        </div>

        {g.segundosEnSilencio !== null && (
          <div className="aviso aviso-info aviso-silencio">
            <Icono nombre="alerta" />
            <span>
              Hace {formatearDuracion(g.segundosEnSilencio)} que no se detecta
              sonido. ¿El micrófono sigue conectado? La grabación continúa igual.
            </span>
          </div>
        )}

        <div className="controles">
          {!activo ? (
            <button
              className="btn btn-grabar"
              onClick={() => void g.iniciar()}
              disabled={g.fase === "finalizando"}
            >
              <Icono nombre="micro" tamano={18} />
              Grabar
              <kbd>{describirAtajo(config.atajos.grabar)}</kbd>
            </button>
          ) : (
            <>
              <button className="btn" onClick={g.alternarPausa}>
                {pausado ? "Reanudar" : "Pausar"}
                <kbd>{describirAtajo(config.atajos.pausar)}</kbd>
              </button>
              <button
                className="btn btn-peligro"
                onClick={() => void g.detener()}
              >
                Detener y guardar
                <kbd>{describirAtajo(config.atajos.detener)}</kbd>
              </button>
              <button className="btn btn-marcar" onClick={g.marcar}>
                Marcar momento
                <kbd>{describirAtajo(config.atajos.marcar)}</kbd>
              </button>
            </>
          )}
        </div>

        <div className="estado-grabacion sutil">
          {g.moviendoDestino ? (
            "Moviendo la grabación a la nueva carpeta…"
          ) : activo && g.destino ? (
            <>
              Guardando en <code>{g.destino.rutaParcial}</code> ·{" "}
              {formatearBytes(g.bytesEscritos)} escritos · formato final{" "}
              {config.formatoAudio.toUpperCase()}
            </>
          ) : espacio ? (
            <>
              Libre en {espacio.unidad}: {formatearBytes(espacio.libreBytes)}
              {horasQueEntran !== null && horasQueEntran < 500
                ? ` · alcanza para unas ${horasQueEntran} horas de clase`
                : ""}
            </>
          ) : (
            "Listo para grabar"
          )}
        </div>
      </div>

      {activo && (
        <div className="tarjeta">
          <h3 className="titulo-seccion">
            Momentos marcados{" "}
            <span className="sutil">({g.marcas.length})</span>
          </h3>
          {g.marcas.length === 0 ? (
            <p className="sutil">
              Sin marcas todavía. Usa{" "}
              <kbd>{describirAtajo(config.atajos.marcar)}</kbd> cuando el
              profesor diga algo importante; después puedes escribir la nota.
            </p>
          ) : (
            <ul className="lista-marcas">
              {[...g.marcas]
                .sort((a, b) => b.segundo - a.segundo)
                .map((m) => (
                  <li key={m.id}>
                    <span className="sello">{formatearDuracion(m.segundo)}</span>
                    <input
                      value={m.nota}
                      placeholder="Nota (opcional)"
                      maxLength={200}
                      onChange={(e) => g.editarNotaMarca(m.id, e.target.value)}
                    />
                    <button
                      className="btn-icono peligro"
                      title="Quitar marca"
                      onClick={() => g.quitarMarca(m.id)}
                    >
                      <Icono nombre="basura" tamano={15} />
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}

      {Object.keys(g.conversiones).length > 0 && (
        <div className="tarjeta">
          <h3 className="titulo-seccion">Convirtiendo</h3>
          {Object.entries(g.conversiones).map(([id, fraccion]) => {
            const grabacion = datos.grabaciones.find((x) => x.id === id);
            return (
              <div key={id} className="conversion">
                <div className="conversion-texto">
                  <span>
                    {grabacion
                      ? `${grabacion.claseNombre} · ${grabacion.unidadNombre}`
                      : "Grabación"}
                  </span>
                  <span className="sutil">{Math.round(fraccion * 100)}%</span>
                </div>
                <div className="progreso">
                  <div
                    className="progreso-valor"
                    style={{ width: `${Math.round(fraccion * 100)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ModalConfirmacion
        abierto={g.avisoEspacio !== null}
        titulo="Queda poco espacio en disco"
        textoConfirmar="Grabar igual"
        peligroso
        mensaje={
          g.avisoEspacio && (
            <>
              <p>
                Quedan <strong>{formatearBytes(g.avisoEspacio.libreBytes)}</strong>{" "}
                libres y el umbral de aviso está en{" "}
                {(g.avisoEspacio.umbralBytes / BYTES_POR_GB).toFixed(1)} GB.
              </p>
              <p className="sutil">
                Una clase de dos horas ocupa unos {Math.round(MB_POR_HORA * 2)} MB
                en crudo, más el archivo convertido.
              </p>
            </>
          )
        }
        onConfirmar={() => {
          g.limpiarAvisoEspacio();
          void g.iniciar({ ignorarEspacio: true });
        }}
        onCancelar={g.limpiarAvisoEspacio}
      />

      <ModalConfirmacion
        abierto={g.cierrePendiente}
        titulo="Hay una grabación en curso"
        textoConfirmar="Detener, guardar y cerrar"
        peligroso
        mensaje={
          <p>
            Si cierras ahora se pierde lo que no se haya escrito todavía. Lo
            recomendable es detener la grabación primero.
          </p>
        }
        onConfirmar={() => void g.detenerYCerrar()}
        onCancelar={g.cancelarCierre}
      />
    </section>
  );
}
