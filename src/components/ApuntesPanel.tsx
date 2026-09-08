/**
 * Pestaña Digitalizar: el taller de los apuntes en papel.
 *
 * Acá se hace el trabajo sucio — imprimir la plantilla, recibir las fotos de
 * Drive, repartirlas en el mesón, recortarlas en ráfaga, mandarlas al
 * reconocimiento y corregir el texto. Leer un apunte ya terminado no es esto:
 * eso pasa en la Biblioteca, al lado de las grabaciones de la misma unidad.
 *
 * La división es a propósito: si las dos pestañas mostraran lo mismo, ninguna
 * diría para qué sirve.
 */
import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { useApuntes } from "../estado/apuntes";
import { useStore } from "../estado/store";
import { borrarArchivosApunte, progresoReconocimiento, vigentes, versionesAnteriores } from "../lib/apuntes";
import { construirArbol } from "../lib/arbol";
import { formatearBytes, formatearFecha } from "../lib/format";
import { guardarTexto } from "../lib/htr";
import type { AnalisisFoto } from "../lib/escaneo";
import type { GrupoOrganizado } from "../lib/organizar";
import type { Apunte, PaginaApunte } from "../types";
import { ColaFotos, archivarFoto } from "./apuntes/ColaFotos";
import { ColaReconocimiento } from "./apuntes/ColaReconocimiento";
import { EditorApunte } from "./apuntes/EditorApunte";
import { EscanearRafaga } from "./apuntes/EscanearRafaga";
import { OrganizarFotos } from "./apuntes/OrganizarFotos";
import { PlantillaImprimible } from "./apuntes/PlantillaImprimible";
import { Icono } from "./ui/Icono";
import { ModalConfirmacion } from "./ui/ModalConfirmacion";

type Modo =
  | { tipo: "lista" }
  | { tipo: "organizar"; fotos: string[]; claseId: string | null; unidadId: string | null }
  | {
      tipo: "rafaga";
      fotos: string[];
      claseId: string | null;
      unidadId: string | null;
      /** Solo cuando la tanda pasó antes por el mesón de organización. */
      grupos?: GrupoOrganizado[];
      analisisPrevio?: Map<string, AnalisisFoto>;
      giros?: Map<string, number>;
    }
  | { tipo: "editor"; apunteId: string };

interface Props {
  /** Apunte que hay que abrir al entrar (viene de un resultado de búsqueda). */
  apunteInicial?: string | null;
  onApunteAbierto?(): void;
}

export function ApuntesPanel({ apunteInicial, onApunteAbierto }: Props) {
  const { datos, config, agregarApunte, quitarApunte } = useStore();
  const { encolar, tareas } = useApuntes();
  const [modo, setModo] = useState<Modo>({ tipo: "lista" });
  const [mostrarPlantilla, setMostrarPlantilla] = useState(false);
  const [aBorrar, setABorrar] = useState<Apunte | null>(null);

  useEffect(() => {
    if (!apunteInicial) return;
    setModo({ tipo: "editor", apunteId: apunteInicial });
    onApunteAbierto?.();
  }, [apunteInicial, onApunteAbierto]);

  const [busqueda, setBusqueda] = useState("");
  // Colapsado por defecto; se pierde al reiniciar, igual que en la Biblioteca.
  const [expandidas, setExpandidas] = useState<Set<string>>(new Set());

  const lista = vigentes(datos.apuntes).sort((a, b) => b.fechaISO.localeCompare(a.fechaISO));
  const porReconocer = lista.reduce(
    (total, a) => total + a.paginas.filter((p) => p.motorHtr === null).length,
    0,
  );

  const q = busqueda.trim().toLowerCase();
  const filtrados = q
    ? lista.filter((a) =>
        [a.titulo, a.claseNombre, a.unidadNombre, a.nota ?? "", ...a.tags]
          .join(" ")
          .toLowerCase()
          .includes(q),
      )
    : lista;

  // Mismo árbol que la Biblioteca: con sesenta y ocho hojas importadas, una
  // tira plana no se lee, y clase › unidad es como el usuario las busca.
  const arbol = construirArbol(datos.clases, filtrados, Boolean(q));

  const alternar = (clave: string) =>
    setExpandidas((previas) => {
      const copia = new Set(previas);
      if (copia.has(clave)) copia.delete(clave);
      else copia.add(clave);
      return copia;
    });

  // Una tanda puede repartirse en varios apuntes (hojas viejas de ramos
  // distintos mezcladas en un mismo cuaderno): se guardan todos y se abre el
  // último, que es el que probablemente se siga editando.
  const terminarRafaga = async (resultados: { apunte: Apunte; paginas: PaginaApunte[] }[]) => {
    let ultimo: Apunte | null = null;
    for (const { apunte, paginas } of resultados) {
      const archivoTexto = await guardarTexto(apunte);
      const completo = { ...apunte, paginas, archivoTexto };
      await agregarApunte(completo);
      // El reconocimiento no arranca solo: una tanda grande son horas de modelo
      // local, y en una importación de varias tandas eso se decide una vez, al
      // final, con "Reconocer todo". Los botones están siempre a mano.
      ultimo = completo;
    }
    setModo(ultimo ? { tipo: "editor", apunteId: ultimo.id } : { tipo: "lista" });
  };

  const borrar = async () => {
    if (!aBorrar) return;
    await borrarArchivosApunte(aBorrar);
    await quitarApunte(aBorrar.id);
    setABorrar(null);
    setModo({ tipo: "lista" });
  };

  if (modo.tipo === "organizar") {
    return (
      <div className="panel">
        <OrganizarFotos
          fotos={modo.fotos}
          claseId={modo.claseId}
          unidadId={modo.unidadId}
          onOrganizado={(grupos, analisisPrevio, giros) =>
            setModo({
              tipo: "rafaga",
              // Solo las fotos repartidas, en el orden que quedó: el mesón ya
              // decidió cuáles entran y en qué apunte.
              fotos: grupos.flatMap((g) => g.fotos),
              claseId: modo.claseId,
              unidadId: modo.unidadId,
              grupos,
              analisisPrevio,
              giros,
            })
          }
          onCancelar={() => setModo({ tipo: "lista" })}
        />
      </div>
    );
  }

  if (modo.tipo === "rafaga") {
    return (
      <div className="panel">
        <EscanearRafaga
          fotos={modo.fotos}
          claseId={modo.claseId}
          unidadId={modo.unidadId}
          grupos={modo.grupos}
          analisisPrevio={modo.analisisPrevio}
          giros={modo.giros}
          onTerminar={(resultados) => void terminarRafaga(resultados)}
          onCancelar={() => setModo({ tipo: "lista" })}
          onFotoUsada={(ruta) => void archivarFoto(ruta, config.carpetaInbox)}
        />
      </div>
    );
  }

  if (modo.tipo === "editor") {
    const apunte = datos.apuntes.find((a) => a.id === modo.apunteId);
    if (!apunte) {
      setModo({ tipo: "lista" });
      return null;
    }
    return (
      <div className="panel">
        <EditorApunte apunte={apunte} onCerrar={() => setModo({ tipo: "lista" })} />
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-cabecera">
        <div>
          <h2>Digitalizar apuntes</h2>
          <p className="sutil">
            Fotos de hojas escritas a mano: recortarlas, ordenarlas y reconocer
            la letra. Para leerlos después, la Biblioteca los muestra junto a
            las grabaciones de su unidad.
          </p>
        </div>
        <div className="acciones-fila">
          {porReconocer > 0 && (
            <button
              className="btn btn-primario"
              onClick={() => lista.forEach((a) => encolar(a))}
              title="Encola todas las páginas que todavía no tienen texto"
            >
              Reconocer todo ({porReconocer})
            </button>
          )}
          <button className="btn" onClick={() => setMostrarPlantilla((v) => !v)}>
            <Icono nombre="imprimir" />
            {mostrarPlantilla ? "Ocultar plantilla" : "Plantilla imprimible"}
          </button>
        </div>
      </div>

      {mostrarPlantilla && <PlantillaImprimible />}

      <ColaReconocimiento />

      <ColaFotos
        onEscanear={(fotos, claseId, unidadId) =>
          setModo({ tipo: "rafaga", fotos, claseId, unidadId })
        }
        onOrganizar={(fotos, claseId, unidadId) =>
          setModo({ tipo: "organizar", fotos, claseId, unidadId })
        }
      />

      <h3 className="titulo-seccion">Apuntes ya digitalizados</h3>

      {lista.length === 0 ? (
        <p className="vacio">Todavía no hay ninguno. Empieza subiendo fotos desde el celular.</p>
      ) : (
        <>
          <p className="sutil">
            Abre uno para corregir su texto, reordenar sus hojas o mandar una a
            otro apunte.
          </p>
          <div className="filtros">
            <input
              className="buscador"
              value={busqueda}
              placeholder="Buscar por título, clase, unidad, nota o etiqueta…"
              onChange={(e) => setBusqueda(e.target.value)}
            />
            {busqueda && (
              <button className="btn" onClick={() => setBusqueda("")}>
                Limpiar
              </button>
            )}
          </div>

          {arbol.length === 0 ? (
            <p className="vacio">Ningún apunte coincide con la búsqueda.</p>
          ) : (
            arbol.map((clase) => {
              // Con búsqueda activa se fuerza todo abierto: si no, un resultado
              // quedaría escondido detrás de una clase colapsada.
              const claseAbierta = Boolean(q) || expandidas.has(clase.claveClase);
              return (
                <details
                  key={clase.claveClase}
                  open={claseAbierta}
                  onToggle={(e) => {
                    if (q) return;
                    alternar(clase.claveClase);
                    e.stopPropagation();
                  }}
                  className="grupo"
                >
                  <summary>
                    <span className="punto" style={{ background: clase.color }} />
                    {clase.nombre}
                    <span className="sutil">
                      {clase.unidades.reduce((n, u) => n + u.items.length, 0)}
                    </span>
                  </summary>
                  {clase.unidades.length === 0 ? (
                    <p className="rama-vacia sutil">Esta clase no tiene unidades todavía.</p>
                  ) : (
                    clase.unidades.map((unidad) => (
                      <details
                        key={unidad.claveUnidad}
                        open={Boolean(q) || expandidas.has(unidad.claveUnidad)}
                        onToggle={(e) => {
                          if (q) return;
                          alternar(unidad.claveUnidad);
                          e.stopPropagation();
                        }}
                        className="subgrupo"
                      >
                        <summary>
                          {unidad.nombre}
                          <span className="sutil">{unidad.items.length}</span>
                        </summary>
                        {unidad.items.length === 0 ? (
                          <p className="rama-vacia sutil">Sin apuntes.</p>
                        ) : (
                          <div className="lista">
                            {unidad.items.map((a) => (
                              <FilaApunte
                                key={a.id}
                                apunte={a}
                                apuntes={datos.apuntes}
                                enCola={
                                  Object.values(tareas).filter((t) => t.apunteId === a.id).length
                                }
                                onAbrir={() => setModo({ tipo: "editor", apunteId: a.id })}
                                onReconocer={() => encolar(a)}
                                onBorrar={() => setABorrar(a)}
                              />
                            ))}
                          </div>
                        )}
                      </details>
                    ))
                  )}
                </details>
              );
            })
          )}
        </>
      )}

      <ModalConfirmacion
        abierto={aBorrar !== null}
        titulo="Eliminar el apunte"
        mensaje={
          aBorrar
            ? `Se van a borrar del disco las ${aBorrar.paginas.length} páginas de "${aBorrar.titulo}"` +
              `${aBorrar.paginas.some((p) => p.original) ? ", incluidas las fotos originales" : ""}.` +
              " El papel físico no se toca; esto solo borra la copia digital."
            : ""
        }
        onConfirmar={() => void borrar()}
        onCancelar={() => setABorrar(null)}
      />
    </div>
  );
}

/** Una fila de la lista de apuntes: portada, estado del reconocimiento y acciones. */
function FilaApunte({
  apunte,
  apuntes,
  enCola,
  onAbrir,
  onReconocer,
  onBorrar,
}: {
  apunte: Apunte;
  apuntes: Apunte[];
  enCola: number;
  onAbrir(): void;
  onReconocer(): void;
  onBorrar(): void;
}) {
  const progreso = progresoReconocimiento(apunte);
  const previas = versionesAnteriores(apuntes, apunte);
  const portada = [...apunte.paginas].sort((x, y) => x.numero - y.numero)[0];

  return (
    <div className="item">
      {portada && (
        <img
          className="portada-apunte"
          src={convertFileSrc(portada.archivo)}
          alt=""
          loading="lazy"
        />
      )}
      <button className="item-texto" onClick={onAbrir}>
        <strong>{apunte.titulo}</strong>
        <small>
          {formatearFecha(apunte.fechaISO)} · {apunte.paginas.length}{" "}
          {apunte.paginas.length === 1 ? "página" : "páginas"} ·{" "}
          {formatearBytes(apunte.paginas.reduce((t, p) => t + p.bytes, 0))}
        </small>
        <small>
          {enCola > 0
            ? `Reconociendo… (${progreso.hechas}/${progreso.total})`
            : progreso.hechas === progreso.total
              ? "Texto reconocido"
              : `${progreso.total - progreso.hechas} páginas sin reconocer`}
          {previas.length > 0 &&
            ` · ${previas.length} ${previas.length === 1 ? "versión anterior" : "versiones anteriores"}`}
        </small>
        {apunte.nota && <small className="nota-apunte">{apunte.nota}</small>}
      </button>

      <div className="item-acciones">
        {progreso.hechas < progreso.total && enCola === 0 && (
          <button className="btn" onClick={onReconocer}>
            Reconocer
          </button>
        )}
        <button
          className="btn-icono"
          title="Abrir la carpeta del apunte"
          onClick={() => void revealItemInDir(apunte.carpeta)}
        >
          <Icono nombre="carpeta" />
        </button>
        <button
          className="btn-icono peligro"
          title="Eliminar el apunte y sus archivos"
          onClick={onBorrar}
        >
          <Icono nombre="basura" />
        </button>
      </div>
    </div>
  );
}
