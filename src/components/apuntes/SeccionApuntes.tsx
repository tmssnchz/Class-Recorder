/**
 * Configuración del reconocimiento de apuntes: motor, modelo, idioma y
 * calidad del escaneo.
 *
 * Vive en su propio archivo, igual que `SeccionApiTranscripcion`, para no
 * seguir engordando ConfiguracionPanel.
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { useStore } from "../../estado/store";
import { formatearBytes } from "../../lib/format";
import { gb, infoSistema, recomendar, type InfoSistema } from "../../lib/hardware";
import {
  MODELOS_HTR,
  URL_MOTOR_HTR,
  borrarModeloHtr,
  carpetaHtr,
  revisarInstalacionHtr,
  rutaMmprojHtr,
  rutaModeloHtr,
  urlArchivoHtr,
  type EstadoInstalacionHtr,
  type ModeloHtrInfo,
} from "../../lib/htrModelos";
import { apiDisponible } from "../../lib/transcripcionApi";
import { unir } from "../../lib/paths";
import type { IdModeloHtr } from "../../types";
import { Icono } from "../ui/Icono";

interface ProgresoDescarga {
  tarea: string;
  bytes: number;
  total: number;
  etapa: string;
}

const IDIOMAS = [
  { id: "es", nombre: "Español" },
  { id: "en", nombre: "Inglés" },
  { id: "pt", nombre: "Portugués" },
  { id: "fr", nombre: "Francés" },
  { id: "it", nombre: "Italiano" },
  { id: "de", nombre: "Alemán" },
  { id: "la", nombre: "Latín" },
];

export function SeccionApuntes() {
  const { config, actualizarConfig } = useStore();
  const [instalacion, setInstalacion] = useState<EstadoInstalacionHtr>({
    motorInstalado: false,
    instalados: [],
  });
  const [descargas, setDescargas] = useState<Record<string, ProgresoDescarga>>({});
  const [error, setError] = useState<string | null>(null);
  const [sistema, setSistema] = useState<InfoSistema | null>(null);

  const refrescar = useCallback(async () => {
    setInstalacion(await revisarInstalacionHtr());
  }, []);

  useEffect(() => {
    void refrescar();
    void infoSistema().then(setSistema).catch(() => undefined);
  }, [refrescar]);

  useEffect(() => {
    const promesa = listen<ProgresoDescarga>("descarga://progreso", (e) => {
      if (!e.payload.tarea.startsWith("htr-")) return;
      setDescargas((d) => ({ ...d, [e.payload.tarea]: e.payload }));
    });
    return () => {
      void promesa.then((quitar) => quitar());
    };
  }, []);

  const limpiarDescarga = (tarea: string) =>
    setDescargas((d) => {
      const copia = { ...d };
      delete copia[tarea];
      return copia;
    });

  const instalarMotor = async () => {
    setError(null);
    try {
      await invoke("instalar_llamacpp", {
        url: URL_MOTOR_HTR,
        carpeta: await carpetaHtr(),
        tarea: "htr-motor",
      });
      await refrescar();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      limpiarDescarga("htr-motor");
    }
  };

  const descargarModelo = async (m: ModeloHtrInfo) => {
    setError(null);
    const tarea = `htr-${m.id}`;
    try {
      // Los dos archivos por separado: el modelo y su proyector multimodal.
      // `descargar_modelo` deja cada uno en .parcial hasta completarse, así
      // que un corte no deja un GGUF a medias que parezca válido.
      await invoke("descargar_modelo", {
        url: urlArchivoHtr(m, m.archivoModelo),
        destino: await rutaModeloHtr(m),
        tarea,
      });
      await invoke("descargar_modelo", {
        url: urlArchivoHtr(m, m.archivoMmproj),
        destino: await rutaMmprojHtr(m),
        tarea,
      });
      await refrescar();
    } catch (e) {
      setError(`No se pudo descargar ${m.etiqueta}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      limpiarDescarga(tarea);
    }
  };

  const borrar = async (m: ModeloHtrInfo) => {
    await borrarModeloHtr(m);
    await refrescar();
  };

  const recomendacion = sistema ? recomendar(MODELOS_HTR, sistema) : null;
  const hayApi = apiDisponible(config);

  return (
    <>
      <h3 className="titulo-seccion">Apuntes escaneados</h3>

      {error && (
        <div className="aviso aviso-error">
          <Icono nombre="alerta" />
          <span>{error}</span>
        </div>
      )}

      <p className="sutil">
        El reconocimiento de letra manuscrita no es exacto en ningún motor. Sirve
        para poder buscar dentro de los apuntes y para no tener que tipearlos de
        cero, no para citar textual sin revisar.
      </p>

      <div className="selectores">
        <label>
          <span>Motor</span>
          <select
            value={config.apuntes.motor}
            onChange={(e) =>
              void actualizarConfig({
                apuntes: { motor: e.target.value as typeof config.apuntes.motor },
              })
            }
          >
            {MODELOS_HTR.map((m) => (
              <option key={m.id} value={m.id}>
                {m.etiqueta} (local)
              </option>
            ))}
            <option value="api" disabled={!hayApi}>
              API externa {hayApi ? "" : "— configura una clave en Transcripción por API"}
            </option>
          </select>
        </label>

        <label>
          <span>Idioma de los apuntes</span>
          <select
            value={config.apuntes.idioma}
            onChange={(e) => void actualizarConfig({ apuntes: { idioma: e.target.value } })}
          >
            {IDIOMAS.map((i) => (
              <option key={i.id} value={i.id}>
                {i.nombre}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Resolución del escaneo</span>
          <select
            value={config.apuntes.dpiEscaneo}
            onChange={(e) =>
              void actualizarConfig({ apuntes: { dpiEscaneo: Number(e.target.value) } })
            }
          >
            <option value={150}>150 dpi — más liviano</option>
            <option value={200}>200 dpi — recomendado</option>
            <option value={300}>300 dpi — para letra muy chica</option>
          </select>
        </label>
      </div>

      <label className="selector-fila">
        <span>Cómo se guarda el escaneo</span>
        <select
          value={config.apuntes.modoEscaneo}
          onChange={(e) =>
            void actualizarConfig({
              apuntes: { modoEscaneo: e.target.value as typeof config.apuntes.modoEscaneo },
            })
          }
        >
          <option value="color">En color, sin sombras — recomendado</option>
          <option value="gris">En gris, sin sombras — archivo más liviano</option>
          <option value="original">Sin retoque — la foto recortada tal cual</option>
        </select>
      </label>

      <p className="sutil">
        Los dos primeros borran la sombra de la mano o del teléfono dividiendo la
        imagen por una estimación del papel. El modo en color hace esa cuenta
        sobre la luminancia y la aplica a los tres canales, así que la sombra se
        va pero el resaltador y las anotaciones en rojo se mantienen.
      </p>

      <label className="selector-fila">
        <input
          type="checkbox"
          checked={config.apuntes.confirmacionAutomatica}
          onChange={(e) =>
            void actualizarConfig({ apuntes: { confirmacionAutomatica: e.target.checked } })
          }
        />
        <span>
          Confirmar sola cada hoja cuando se leen los cuatro marcadores
          <small className="sutil">
            {" "}
            — las que dan problema quedan pendientes al final, para resolverlas
            juntas en vez de frenar la tanda.
          </small>
        </span>
      </label>

      <label className="selector-fila">
        <input
          type="checkbox"
          checked={config.apuntes.numeroDePagina}
          onChange={(e) =>
            void actualizarConfig({ apuntes: { numeroDePagina: e.target.checked } })
          }
        />
        <span>
          Imprimir el número de página en la plantilla
          <small className="sutil">
            {" "}
            — es solo para leerlo a ojo: la app saca el número de los marcadores.
          </small>
        </span>
      </label>

      <label className="selector-fila">
        <input
          type="checkbox"
          checked={config.apuntes.conservarOriginal}
          onChange={(e) =>
            void actualizarConfig({ apuntes: { conservarOriginal: e.target.checked } })
          }
        />
        <span>
          Guardar también la foto original
          <small className="sutil">
            {" "}
            — ocupa alrededor del doble, pero permite volver a recortar si el
            encuadre salió mal.
          </small>
        </span>
      </label>

      {config.apuntes.motor === "api" && (
        <div className="aviso aviso-info">
          <Icono nombre="nube" />
          <span>
            Cada hoja se manda a la API del perfil predeterminado. Es rápido y
            suele reconocer mejor, pero la imagen de tu apunte sale de tu
            computadora y se cobra por uso: a los precios de 2026 ronda los USD
            0,001–0,003 por hoja en los modelos de visión chicos. Revisa el
            tarifario de tu proveedor antes de mandar un cuaderno entero.
          </span>
        </div>
      )}

      {config.apuntes.motor !== "api" && (
        <>
          {recomendacion && (
            <div className={`aviso ${recomendacion.ajustada ? "aviso-cambio-destino" : "aviso-info"}`}>
              <Icono nombre={recomendacion.ajustada ? "alerta" : "check"} />
              <span>
                {recomendacion.motivo}
                {recomendacion.opcion.id !== config.apuntes.modelo && (
                  <>
                    {" "}
                    <button
                      className="btn"
                      onClick={() =>
                        void actualizarConfig({
                          apuntes: {
                            modelo: recomendacion.opcion.id as IdModeloHtr,
                            motor: recomendacion.opcion.id as IdModeloHtr,
                          },
                        })
                      }
                    >
                      Usar {recomendacion.opcion.etiqueta}
                    </button>
                  </>
                )}
              </span>
            </div>
          )}

          <div className="item item-estatico">
            <div className="item-texto">
              <strong>Motor de reconocimiento</strong>
              <small>
                llama.cpp (build de CPU, ~30 MB). Es el ejecutable que corre los
                modelos; se descarga una sola vez.
              </small>
            </div>
            <div className="item-acciones">
              {descargas["htr-motor"] ? (
                <BarraDescargaHtr progreso={descargas["htr-motor"]} />
              ) : instalacion.motorInstalado ? (
                <span className="sutil">Instalado</span>
              ) : (
                <button className="btn btn-primario" onClick={() => void instalarMotor()}>
                  Instalar
                </button>
              )}
            </div>
          </div>

          <div className="lista">
            {MODELOS_HTR.map((m) => {
              const instalado = instalacion.instalados.includes(m.id);
              const progreso = descargas[`htr-${m.id}`];
              const elegido = config.apuntes.modelo === m.id;

              return (
                <div className={`item ${elegido ? "activo" : ""}`} key={m.id}>
                  <button
                    className="item-texto"
                    onClick={() =>
                      void actualizarConfig({ apuntes: { modelo: m.id, motor: m.id } })
                    }
                    disabled={!instalado}
                    title={instalado ? "Usar este modelo" : "Descárgalo primero"}
                  >
                    <strong>
                      {m.etiqueta}
                      {elegido ? " · en uso" : ""}
                    </strong>
                    <small>{m.descripcion}</small>
                    <small>
                      {formatearBytes(m.mb * 1024 * 1024)} en disco · ~{m.ramGB} GB de RAM ·
                      ~{m.minutosPorHoja} min por hoja en CPU
                    </small>
                  </button>
                  <div className="item-acciones">
                    {progreso ? (
                      <BarraDescargaHtr progreso={progreso} />
                    ) : instalado ? (
                      <button className="btn-icono peligro" onClick={() => void borrar(m)} title="Borrar del disco">
                        <Icono nombre="basura" />
                      </button>
                    ) : (
                      <button className="btn" onClick={() => void descargarModelo(m)}>
                        Descargar
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {sistema && (
            <p className="sutil">
              Esta máquina: {gb(sistema.ramTotalBytes).toFixed(0)} GB de RAM,{" "}
              {sistema.nucleos} núcleos. Los modelos se guardan en{" "}
              <code>{unir("%APPDATA%", "com.tomas.classrecorder", "htr", "modelos")}</code>.
            </p>
          )}
        </>
      )}
    </>
  );
}

function BarraDescargaHtr({ progreso }: { progreso: ProgresoDescarga }) {
  if (progreso.etapa === "extrayendo") return <span className="sutil">Extrayendo…</span>;
  const fraccion = progreso.total > 0 ? progreso.bytes / progreso.total : 0;
  return (
    <div className="descarga">
      <div className="progreso">
        <div className="progreso-valor" style={{ width: `${Math.round(fraccion * 100)}%` }} />
      </div>
      <small className="sutil">
        {formatearBytes(progreso.bytes)}
        {progreso.total > 0 ? ` / ${formatearBytes(progreso.total)}` : ""}
      </small>
    </div>
  );
}
