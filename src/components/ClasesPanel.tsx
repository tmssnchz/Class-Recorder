import { useEffect, useMemo, useState } from "react";

import { useStore } from "../estado/store";
import { materialesDeClase, materialesDeUnidad } from "../lib/materiales";
import { sanitizarNombre, unir } from "../lib/paths";
import type { Clase } from "../types";
import { Icono } from "./ui/Icono";
import { ListaMateriales } from "./ui/ListaMateriales";
import { SelectorColor } from "./ui/SelectorColor";
import { ModalConfirmacion } from "./ui/ModalConfirmacion";

type Borrado =
  | { tipo: "clase"; claseId: string }
  | { tipo: "unidad"; claseId: string; unidadId: string };

export function ClasesPanel() {
  const {
    datos,
    config,
    agregarClase,
    renombrarClase,
    cambiarColorClase,
    eliminarClase,
    agregarUnidad,
    renombrarUnidad,
    eliminarUnidad,
  } = useStore();

  const [seleccionada, setSeleccionada] = useState<string | null>(null);
  const [nombreClaseNueva, setNombreClaseNueva] = useState("");
  const [nombreUnidadNueva, setNombreUnidadNueva] = useState("");
  const [editando, setEditando] = useState<string | null>(null);
  const [borrado, setBorrado] = useState<Borrado | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Unidad abierta para ver/cargar su material. */
  const [unidadSel, setUnidadSel] = useState<string | null>(null);
  /** Id de la clase cuyo selector de color está abierto. */
  const [colorAbierto, setColorAbierto] = useState<string | null>(null);

  const clase: Clase | undefined = useMemo(
    () => datos.clases.find((c) => c.id === seleccionada),
    [datos.clases, seleccionada],
  );

  // Al abrir el panel (o al borrar la clase activa) seleccionamos la primera.
  useEffect(() => {
    if (!clase && datos.clases.length > 0) setSeleccionada(datos.clases[0].id);
    if (datos.clases.length === 0) setSeleccionada(null);
  }, [clase, datos.clases]);

  const unidadSelObj = clase?.unidades.find((u) => u.id === unidadSel) ?? null;

  // Cambiar de clase cierra la unidad que estaba abierta: pertenece a la otra.
  useEffect(() => {
    setUnidadSel(null);
  }, [seleccionada]);

  const grabacionesDeClase = (claseId: string) =>
    datos.grabaciones.filter((g) => g.claseId === claseId).length;
  const grabacionesDeUnidad = (unidadId: string) =>
    datos.grabaciones.filter((g) => g.unidadId === unidadId).length;

  const intentar = async (accion: () => Promise<unknown>) => {
    try {
      setError(null);
      await accion();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const confirmarBorrado = async () => {
    if (!borrado) return;
    if (borrado.tipo === "clase") {
      await intentar(() => eliminarClase(borrado.claseId));
      setSeleccionada(null);
    } else {
      await intentar(() => eliminarUnidad(borrado.claseId, borrado.unidadId));
    }
    setBorrado(null);
  };

  const claseDelBorrado =
    borrado && datos.clases.find((c) => c.id === borrado.claseId);
  const unidadDelBorrado =
    borrado?.tipo === "unidad"
      ? claseDelBorrado?.unidades.find((u) => u.id === borrado.unidadId)
      : undefined;
  const grabacionesAfectadas = borrado
    ? borrado.tipo === "clase"
      ? grabacionesDeClase(borrado.claseId)
      : grabacionesDeUnidad(borrado.unidadId)
    : 0;

  return (
    <section className="panel">
      <header className="panel-cabecera">
        <div>
          <h2>Clases y unidades</h2>
          <p className="sutil">
            Cada clase y unidad se convierte en una carpeta dentro de{" "}
            <code>{config.carpetaRaiz}</code>
          </p>
        </div>
      </header>

      {error && (
        <div className="aviso aviso-error">
          <Icono nombre="alerta" />
          <span>{error}</span>
          <button className="btn-icono" onClick={() => setError(null)}>
            <Icono nombre="equis" tamano={16} />
          </button>
        </div>
      )}

      <div className="clases-layout">
        {/* ------------------------------------------------ columna clases */}
        <div className="columna">
          <form
            className="form-linea"
            onSubmit={(e) => {
              e.preventDefault();
              const nombre = nombreClaseNueva;
              void intentar(async () => {
                const creada = await agregarClase(nombre);
                setNombreClaseNueva("");
                setSeleccionada(creada.id);
              });
            }}
          >
            <input
              value={nombreClaseNueva}
              onChange={(e) => setNombreClaseNueva(e.target.value)}
              placeholder="Nueva clase (ej: Derecho Constitucional)"
              maxLength={80}
            />
            <button className="btn btn-primario" type="submit">
              <Icono nombre="mas" tamano={16} /> Agregar
            </button>
          </form>

          {datos.clases.length === 0 ? (
            <p className="vacio">
              Todavía no hay clases. Añade la primera arriba para empezar.
            </p>
          ) : (
            <ul className="lista">
              {datos.clases.map((c) => (
                <li
                  key={c.id}
                  className={`item ${c.id === seleccionada ? "activo" : ""}`}
                  onClick={() => setSeleccionada(c.id)}
                >
                  <span className="envoltorio-color">
                    <button
                      className="punto punto-boton"
                      style={{ background: c.color }}
                      title="Cambiar color"
                      onClick={(e) => {
                        e.stopPropagation();
                        setColorAbierto(colorAbierto === c.id ? null : c.id);
                      }}
                    />
                    {colorAbierto === c.id && (
                      <SelectorColor
                        color={c.color}
                        usados={datos.clases
                          .filter((x) => x.id !== c.id)
                          .map((x) => x.color)}
                        onElegir={(color) =>
                          void intentar(async () => {
                            await cambiarColorClase(c.id, color);
                            setColorAbierto(null);
                          })
                        }
                        onCerrar={() => setColorAbierto(null)}
                      />
                    )}
                  </span>
                  {editando === c.id ? (
                    <EdicionNombre
                      valor={c.nombre}
                      onGuardar={(v) =>
                        intentar(async () => {
                          await renombrarClase(c.id, v);
                          setEditando(null);
                        })
                      }
                      onCancelar={() => setEditando(null)}
                    />
                  ) : (
                    <>
                      <div className="item-texto">
                        <strong>{c.nombre}</strong>
                        <small className="sutil">
                          {c.unidades.length}{" "}
                          {c.unidades.length === 1 ? "unidad" : "unidades"} ·{" "}
                          {grabacionesDeClase(c.id)}{" "}
                          {grabacionesDeClase(c.id) === 1
                            ? "grabación"
                            : "grabaciones"}
                        </small>
                      </div>
                      <div className="item-acciones">
                        <button
                          className="btn-icono"
                          title="Renombrar"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditando(c.id);
                          }}
                        >
                          <Icono nombre="lapiz" tamano={15} />
                        </button>
                        <button
                          className="btn-icono peligro"
                          title="Eliminar"
                          onClick={(e) => {
                            e.stopPropagation();
                            setBorrado({ tipo: "clase", claseId: c.id });
                          }}
                        >
                          <Icono nombre="basura" tamano={15} />
                        </button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ----------------------------------------------- columna unidades */}
        <div className="columna">
          {!clase ? (
            <p className="vacio">Selecciona una clase para ver sus unidades.</p>
          ) : (
            <>
              <div className="detalle-cabecera">
                <h3>
                  <span className="punto" style={{ background: clase.color }} />
                  {clase.nombre}
                </h3>
                <code className="ruta">
                  {unir(config.carpetaRaiz, sanitizarNombre(clase.nombre))}
                </code>
              </div>

              <form
                className="form-linea"
                onSubmit={(e) => {
                  e.preventDefault();
                  const nombre = nombreUnidadNueva;
                  void intentar(async () => {
                    await agregarUnidad(clase.id, nombre);
                    setNombreUnidadNueva("");
                  });
                }}
              >
                <input
                  value={nombreUnidadNueva}
                  onChange={(e) => setNombreUnidadNueva(e.target.value)}
                  placeholder="Nueva unidad (ej: Unidad 3 - Kelsen)"
                  maxLength={80}
                />
                <button className="btn btn-primario" type="submit">
                  <Icono nombre="mas" tamano={16} /> Agregar
                </button>
              </form>

              {clase.unidades.length === 0 ? (
                <p className="vacio">
                  Esta clase no tiene unidades todavía. Se puede grabar igual,
                  pero organizar las grabaciones por unidad después da más
                  trabajo.
                </p>
              ) : (
                <ul className="lista">
                  {clase.unidades.map((u) => (
                    <li key={u.id} className="item">
                      {editando === u.id ? (
                        <EdicionNombre
                          valor={u.nombre}
                          onGuardar={(v) =>
                            intentar(async () => {
                              await renombrarUnidad(clase.id, u.id, v);
                              setEditando(null);
                            })
                          }
                          onCancelar={() => setEditando(null)}
                        />
                      ) : (
                        <>
                          <div
                            className="item-texto"
                            onClick={() =>
                              setUnidadSel(unidadSel === u.id ? null : u.id)
                            }
                          >
                            <strong>{u.nombre}</strong>
                            <small className="sutil">
                              {grabacionesDeUnidad(u.id)}{" "}
                              {grabacionesDeUnidad(u.id) === 1
                                ? "grabación"
                                : "grabaciones"}
                              {materialesDeUnidad(datos.materiales, u.id).length > 0
                                ? ` · ${
                                    materialesDeUnidad(datos.materiales, u.id).length
                                  } material`
                                : ""}
                            </small>
                          </div>
                          <div className="item-acciones">
                            <button
                              className="btn-icono"
                              title="Renombrar"
                              onClick={() => setEditando(u.id)}
                            >
                              <Icono nombre="lapiz" tamano={15} />
                            </button>
                            <button
                              className="btn-icono peligro"
                              title="Eliminar"
                              onClick={() =>
                                setBorrado({
                                  tipo: "unidad",
                                  claseId: clase.id,
                                  unidadId: u.id,
                                })
                              }
                            >
                              <Icono nombre="basura" tamano={15} />
                            </button>
                          </div>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {unidadSelObj && (
                <ListaMateriales
                  key={unidadSelObj.id}
                  titulo={`Material de ${unidadSelObj.nombre}`}
                  materiales={materialesDeUnidad(datos.materiales, unidadSelObj.id)}
                  vacio="Esta unidad todavía no tiene material."
                  destino={{
                    carpetaRaiz: config.carpetaRaiz,
                    claseNombre: clase.nombre,
                    unidadNombre: unidadSelObj.nombre,
                    claseId: null,
                    unidadId: unidadSelObj.id,
                    grabacionId: null,
                  }}
                />
              )}

              <ListaMateriales
                key={clase.id}
                titulo={`Material de ${clase.nombre}`}
                materiales={materialesDeClase(datos.materiales, clase.id)}
                vacio="Esta clase todavía no tiene material. Sirve para el programa de la materia, la bibliografía, o cualquier apunte que valga para todas las unidades."
                destino={{
                  carpetaRaiz: config.carpetaRaiz,
                  claseNombre: clase.nombre,
                  unidadNombre: null,
                  claseId: clase.id,
                  unidadId: null,
                  grabacionId: null,
                }}
              />
            </>
          )}
        </div>
      </div>

      <ModalConfirmacion
        abierto={borrado !== null}
        peligroso
        titulo={
          borrado?.tipo === "clase" ? "Eliminar clase" : "Eliminar unidad"
        }
        textoConfirmar="Eliminar"
        mensaje={
          <>
            <p>
              Se eliminará{" "}
              <strong>
                {borrado?.tipo === "clase"
                  ? claseDelBorrado?.nombre
                  : unidadDelBorrado?.nombre}
              </strong>
              {borrado?.tipo === "clase" && claseDelBorrado
                ? ` y sus ${claseDelBorrado.unidades.length} unidades`
                : ""}
              .
            </p>
            {grabacionesAfectadas > 0 && (
              <p className="aviso aviso-info">
                <Icono nombre="alerta" tamano={16} />
                <span>
                  {grabacionesAfectadas}{" "}
                  {grabacionesAfectadas === 1 ? "grabación" : "grabaciones"}{" "}
                  dejarán de aparecer en la biblioteca.{" "}
                  <strong>Los archivos de audio no se borran</strong>: siguen en{" "}
                  <code>{config.carpetaRaiz}</code>.
                </span>
              </p>
            )}
          </>
        }
        onConfirmar={() => void confirmarBorrado()}
        onCancelar={() => setBorrado(null)}
      />
    </section>
  );
}

function EdicionNombre({
  valor,
  onGuardar,
  onCancelar,
}: {
  valor: string;
  onGuardar: (v: string) => void;
  onCancelar: () => void;
}) {
  const [texto, setTexto] = useState(valor);
  return (
    <form
      className="form-linea edicion"
      onClick={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault();
        onGuardar(texto);
      }}
    >
      <input
        autoFocus
        value={texto}
        maxLength={80}
        onChange={(e) => setTexto(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancelar();
        }}
      />
      <button className="btn-icono" type="submit" title="Guardar">
        <Icono nombre="check" tamano={16} />
      </button>
      <button
        className="btn-icono"
        type="button"
        title="Cancelar"
        onClick={onCancelar}
      >
        <Icono nombre="equis" tamano={16} />
      </button>
    </form>
  );
}
