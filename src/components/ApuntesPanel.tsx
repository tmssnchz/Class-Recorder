/**
 * Panel de apuntes escaneados: la tercera fuente de contenido de la app, junto
 * a la grabación de audio y la importación desde el celular.
 *
 * Tres cosas en un solo lugar: la cola de fotos que llegan por la carpeta de
 * Drive, el escaneo en ráfaga de esas fotos, y la lista de apuntes ya
 * digitalizados. La plantilla imprimible vive acá también porque es lo primero
 * que uno busca cuando decide empezar a usar esto.
 */
import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { useApuntes } from "../estado/apuntes";
import { useStore } from "../estado/store";
import { borrarArchivosApunte, progresoReconocimiento, vigentes, versionesAnteriores } from "../lib/apuntes";
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

  const lista = vigentes(datos.apuntes).sort((a, b) => b.fechaISO.localeCompare(a.fechaISO));
  const porReconocer = lista.reduce(
    (total, a) => total + a.paginas.filter((p) => p.motorHtr === null).length,
    0,
  );

  // Una tanda puede repartirse en varios apuntes (hojas viejas de ramos
  // distintos mezcladas en un mismo cuaderno): se guardan todos y se abre el
  // último, que es el que probablemente se siga editando.
  const terminarRafaga = async (resultados: { apunte: Apunte; paginas: PaginaApunte[] }[]) => {
    let ultimo: Apunte | null = null;
    for (const { apunte, paginas } of resultados) {
      const archivoTexto = await guardarTexto(apunte);
      const completo = { ...apunte, paginas, archivoTexto };
      await agregarApunte(completo);
      // El reconocimiento arranca solo, en background: la interfaz queda libre
      // igual que con la transcripción de audio.
      encolar(completo);
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
          onOrganizado={(grupos, analisisPrevio) =>
            setModo({
              tipo: "rafaga",
              // Solo las fotos repartidas, en el orden que quedó: el mesón ya
              // decidió cuáles entran y en qué apunte.
              fotos: grupos.flatMap((g) => g.fotos),
              claseId: modo.claseId,
              unidadId: modo.unidadId,
              grupos,
              analisisPrevio,
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
          <h2>Apuntes escaneados</h2>
          <p className="sutil">
            Fotos de hojas escritas a mano, recortadas y limpias, con el texto
            reconocido e indexado en la búsqueda de la biblioteca.
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

      <h3 className="titulo-seccion">Apuntes digitalizados</h3>

      {lista.length === 0 && (
        <p className="vacio">Todavía no hay ninguno. Empieza subiendo fotos desde el celular.</p>
      )}

      <div className="lista">
        {lista.map((a) => {
          const progreso = progresoReconocimiento(a);
          const enCola = Object.values(tareas).filter((t) => t.apunteId === a.id).length;
          const previas = versionesAnteriores(datos.apuntes, a);
          const portada = [...a.paginas].sort((x, y) => x.numero - y.numero)[0];

          return (
            <div className="item" key={a.id}>
              {portada && (
                <img
                  className="portada-apunte"
                  src={convertFileSrc(portada.archivo)}
                  alt=""
                  loading="lazy"
                />
              )}
              <button
                className="item-texto"
                onClick={() => setModo({ tipo: "editor", apunteId: a.id })}
              >
                <strong>{a.titulo}</strong>
                <small>
                  {a.claseNombre} › {a.unidadNombre} · {formatearFecha(a.fechaISO)} ·{" "}
                  {a.paginas.length} {a.paginas.length === 1 ? "página" : "páginas"} ·{" "}
                  {formatearBytes(a.paginas.reduce((t, p) => t + p.bytes, 0))}
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
              </button>

              <div className="item-acciones">
                {progreso.hechas < progreso.total && enCola === 0 && (
                  <button className="btn" onClick={() => encolar(a)}>
                    Reconocer
                  </button>
                )}
                <button
                  className="btn-icono"
                  title="Abrir la carpeta del apunte"
                  onClick={() => void revealItemInDir(a.carpeta)}
                >
                  <Icono nombre="carpeta" />
                </button>
                <button
                  className="btn-icono peligro"
                  title="Eliminar el apunte y sus archivos"
                  onClick={() => setABorrar(a)}
                >
                  <Icono nombre="basura" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

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
