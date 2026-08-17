import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

import { carpetaDeDatos } from "../lib/almacen";
import {
  URL_DESCARGA_DRIVE,
  detectarDrive,
  prepararInbox,
  type InfoDrive,
} from "../lib/importar";
import { useStore } from "../estado/store";

/** Igual que el del backend: la subcarpeta que la app crea dentro del Drive. */
const NOMBRE_INBOX = "ClassRecorder_Inbox";
import { aceleradorDesdeEvento, describirAtajo } from "../lib/atajos";
import { formatearBytes, formatearDuracion } from "../lib/format";
import {
  MODELOS,
  MODELOS_FASTER,
  URL_MOTOR,
  URL_MOTOR_FASTER,
  borrarModelo,
  borrarModeloFaster,
  carpetaDeModeloFaster,
  carpetaFaster,
  carpetaModelos,
  carpetaModelosFaster,
  carpetaWhisper,
  estimarSegundos,
  revisarInstalacion,
  rutaModelo,
  urlArchivoFaster,
  urlModelo,
  type EstadoInstalacion,
  type ModeloFasterInfo,
  type ModeloInfo,
} from "../lib/modelos";
import type {
  Atajos,
  FormatoAudio,
  IdModelo,
  IdModeloFaster,
} from "../types";
import { Icono } from "./ui/Icono";

interface ProgresoDescarga {
  tarea: string;
  bytes: number;
  total: number;
  etapa: string;
}

interface ProgresoRespaldo {
  tarea: string;
  archivos: number;
  totalArchivos: number;
  bytes: number;
}

interface ResumenRespaldo {
  archivos: number;
  bytes: number;
}

/** Duración de referencia para las estimaciones que se muestran: 2 horas. */
const CLASE_TIPO_SEG = 7200;

export function ConfiguracionPanel() {
  const { config, actualizarConfig } = useStore();

  const [micros, setMicros] = useState<MediaDeviceInfo[]>([]);
  const [instalacion, setInstalacion] = useState<EstadoInstalacion>({
    motorInstalado: false,
    instalados: [],
    motorFasterInstalado: false,
    instaladosFaster: [],
  });
  const [descargas, setDescargas] = useState<Record<string, ProgresoDescarga>>({});
  const [errorDescarga, setErrorDescarga] = useState<string | null>(null);
  const [capturando, setCapturando] = useState<keyof Atajos | null>(null);
  const [hilosSugeridos, setHilosSugeridos] = useState(4);
  const [carpetaModelosRuta, setCarpetaModelosRuta] = useState("");
  const [carpetaModelosFasterRuta, setCarpetaModelosFasterRuta] = useState("");

  // Importación desde el celular
  const [drive, setDrive] = useState<InfoDrive | null>(null);
  const [errorInbox, setErrorInbox] = useState<string | null>(null);

  // Respaldo
  const [incluirAudio, setIncluirAudio] = useState(true);
  const [resumenRespaldo, setResumenRespaldo] = useState<ResumenRespaldo | null>(
    null,
  );
  const [respaldoEnCurso, setRespaldoEnCurso] = useState<ProgresoRespaldo | null>(
    null,
  );
  const [respaldoHecho, setRespaldoHecho] = useState<string | null>(null);
  const [errorRespaldo, setErrorRespaldo] = useState<string | null>(null);

  const usandoFaster = config.motorTranscripcion === "faster-whisper";

  const refrescarInstalacion = useCallback(async () => {
    setInstalacion(await revisarInstalacion());
    setCarpetaModelosRuta(await carpetaModelos());
    setCarpetaModelosFasterRuta(await carpetaModelosFaster());
  }, []);

  useEffect(() => {
    void refrescarInstalacion();
    void invoke<number>("hilos_recomendados").then(setHilosSugeridos);
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((d) => setMicros(d.filter((x) => x.kind === "audioinput")))
      .catch(() => undefined);
  }, [refrescarInstalacion]);

  useEffect(() => {
    const promesa = listen<ProgresoDescarga>("descarga://progreso", (e) => {
      setDescargas((d) => ({ ...d, [e.payload.tarea]: e.payload }));
    });
    return () => {
      void promesa.then((quitar) => quitar());
    };
  }, []);

  // Los nombres de los micrófonos solo aparecen después de conceder el permiso.
  const pedirNombresDeMicros = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      const d = await navigator.mediaDevices.enumerateDevices();
      setMicros(d.filter((x) => x.kind === "audioinput"));
    } catch (e) {
      console.warn("No se pudo acceder al micrófono", e);
    }
  };

  const elegirCarpeta = async () => {
    const elegida = await open({
      directory: true,
      title: "Carpeta donde guardar las grabaciones",
      defaultPath: config.carpetaRaiz,
    });
    if (typeof elegida === "string") {
      await actualizarConfig({ carpetaRaiz: elegida });
    }
  };

  const instalarMotor = async () => {
    setErrorDescarga(null);
    try {
      await invoke("instalar_whisper", {
        url: URL_MOTOR,
        carpeta: await carpetaWhisper(),
        tarea: "motor",
      });
      await refrescarInstalacion();
    } catch (e) {
      setErrorDescarga(e instanceof Error ? e.message : String(e));
    } finally {
      setDescargas((d) => {
        const copia = { ...d };
        delete copia.motor;
        return copia;
      });
    }
  };

  const descargarModelo = async (modelo: ModeloInfo) => {
    setErrorDescarga(null);
    try {
      await invoke("descargar_modelo", {
        url: urlModelo(modelo),
        destino: await rutaModelo(modelo),
        tarea: modelo.id,
      });
      await refrescarInstalacion();
    } catch (e) {
      setErrorDescarga(
        `No se pudo descargar ${modelo.etiqueta}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    } finally {
      setDescargas((d) => {
        const copia = { ...d };
        delete copia[modelo.id];
        return copia;
      });
    }
  };

  const quitarModelo = async (modelo: ModeloInfo) => {
    await borrarModelo(modelo);
    await refrescarInstalacion();
  };

  // ------------------------------------------------------ faster-whisper

  const instalarFaster = async () => {
    setErrorDescarga(null);
    try {
      await invoke("instalar_faster_whisper", {
        url: URL_MOTOR_FASTER,
        carpeta: await carpetaFaster(),
        tarea: "motor-faster",
      });
      await refrescarInstalacion();
    } catch (e) {
      setErrorDescarga(e instanceof Error ? e.message : String(e));
    } finally {
      setDescargas((d) => {
        const copia = { ...d };
        delete copia["motor-faster"];
        return copia;
      });
    }
  };

  const descargarModeloFaster = async (modelo: ModeloFasterInfo) => {
    setErrorDescarga(null);
    try {
      await invoke("descargar_modelo_faster", {
        urls: modelo.archivos.map((a) => urlArchivoFaster(modelo, a)),
        nombres: modelo.archivos,
        carpetaDestino: await carpetaDeModeloFaster(modelo),
        tarea: modelo.id,
      });
      await refrescarInstalacion();
    } catch (e) {
      setErrorDescarga(
        `No se pudo descargar ${modelo.etiqueta}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    } finally {
      setDescargas((d) => {
        const copia = { ...d };
        delete copia[modelo.id];
        return copia;
      });
    }
  };

  const quitarModeloFaster = async (modelo: ModeloFasterInfo) => {
    await borrarModeloFaster(modelo);
    await refrescarInstalacion();
  };

  // ------------------------------------------------- importar del celular

  useEffect(() => {
    void detectarDrive().then(setDrive).catch(() => setDrive(null));
  }, []);

  const elegirInbox = async () => {
    setErrorInbox(null);
    const elegida = await open({
      directory: true,
      title: "Elegir la carpeta raíz de tu Google Drive",
      defaultPath: config.carpetaInbox ?? drive?.candidatas[0],
    });
    if (typeof elegida !== "string") return;
    try {
      // Si eligió el Inbox en vez de la raíz, no se anida otro adentro.
      const raiz = elegida.endsWith(NOMBRE_INBOX)
        ? elegida.slice(0, -(NOMBRE_INBOX.length + 1))
        : elegida;
      await actualizarConfig({ carpetaInbox: await prepararInbox(raiz) });
    } catch (e) {
      setErrorInbox(e instanceof Error ? e.message : String(e));
    }
  };

  // -------------------------------------------------------------- respaldo

  // El tamaño se recalcula al cambiar la casilla de audio, para que el número
  // de arriba del botón sea siempre el del respaldo que se va a hacer.
  useEffect(() => {
    let vigente = true;
    void (async () => {
      try {
        const resumen = await invoke<ResumenRespaldo>("medir_respaldo", {
          carpetaRaiz: config.carpetaRaiz,
          carpetaDatos: await carpetaDeDatos(),
          incluirAudio,
        });
        if (vigente) setResumenRespaldo(resumen);
      } catch (e) {
        console.warn("No se pudo medir el respaldo", e);
        if (vigente) setResumenRespaldo(null);
      }
    })();
    return () => {
      vigente = false;
    };
  }, [config.carpetaRaiz, incluirAudio]);

  useEffect(() => {
    const promesa = listen<ProgresoRespaldo>("respaldo://progreso", (e) => {
      setRespaldoEnCurso(e.payload);
    });
    return () => {
      void promesa.then((quitar) => quitar());
    };
  }, []);

  const exportarTodo = async () => {
    setErrorRespaldo(null);
    setRespaldoHecho(null);

    const hoy = new Date();
    const p = (n: number) => n.toString().padStart(2, "0");
    const sugerido = `ClassRecorder_${hoy.getFullYear()}-${p(
      hoy.getMonth() + 1,
    )}-${p(hoy.getDate())}${incluirAudio ? "" : "_solo-datos"}.zip`;

    const destino = await save({
      title: "Guardar respaldo",
      defaultPath: sugerido,
      filters: [{ name: "Archivo ZIP", extensions: ["zip"] }],
    });
    if (!destino) return;

    setRespaldoEnCurso({
      tarea: "respaldo",
      archivos: 0,
      totalArchivos: resumenRespaldo?.archivos ?? 0,
      bytes: 0,
    });
    try {
      const ruta = await invoke<string>("exportar_respaldo", {
        carpetaRaiz: config.carpetaRaiz,
        carpetaDatos: await carpetaDeDatos(),
        destino,
        incluirAudio,
        tarea: "respaldo",
      });
      setRespaldoHecho(ruta);
    } catch (e) {
      setErrorRespaldo(e instanceof Error ? e.message : String(e));
    } finally {
      setRespaldoEnCurso(null);
    }
  };

  // Captura de atajos: el próximo tecleo define la combinación.
  useEffect(() => {
    if (!capturando) return;
    const alTeclear = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturando(null);
        return;
      }
      const acelerador = aceleradorDesdeEvento(e);
      if (!acelerador) return;
      void actualizarConfig({ atajos: { [capturando]: acelerador } });
      setCapturando(null);
    };
    window.addEventListener("keydown", alTeclear, true);
    return () => window.removeEventListener("keydown", alTeclear, true);
  }, [capturando, actualizarConfig]);

  const descargando = (tarea: string) => descargas[tarea];

  return (
    <section className="panel">
      <header className="panel-cabecera">
        <div>
          <h2>Configuración</h2>
          <p className="sutil">
            Todo se guarda en <code>config.json</code>, dentro de los datos de la
            aplicación.
          </p>
        </div>
      </header>

      {errorDescarga && (
        <div className="aviso aviso-error">
          <Icono nombre="alerta" />
          <span>{errorDescarga}</span>
          <button className="btn-icono" onClick={() => setErrorDescarga(null)}>
            <Icono nombre="equis" tamano={16} />
          </button>
        </div>
      )}

      {/* ------------------------------------------------------------ audio */}
      <div className="tarjeta">
        <h3 className="titulo-seccion">Grabación</h3>

        <div className="ajuste">
          <div className="ajuste-texto">
            <strong>Formato de audio</strong>
            <small className="sutil">
              MP3 ocupa unas diez veces menos que WAV con la misma inteligibilidad
              para voz.
            </small>
          </div>
          <div className="conmutador">
            {(["mp3", "wav"] as FormatoAudio[]).map((f) => (
              <button
                key={f}
                className={config.formatoAudio === f ? "activo" : ""}
                onClick={() => void actualizarConfig({ formatoAudio: f })}
              >
                {f.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <div className="ajuste">
          <div className="ajuste-texto">
            <strong>Carpeta de grabaciones</strong>
            <small className="sutil">
              <code>{config.carpetaRaiz}</code>
            </small>
          </div>
          <button className="btn" onClick={() => void elegirCarpeta()}>
            <Icono nombre="carpeta" tamano={16} /> Cambiar
          </button>
        </div>

        <div className="ajuste">
          <div className="ajuste-texto">
            <strong>Micrófono</strong>
            <small className="sutil">
              {micros.some((m) => m.label)
                ? "Se usa el seleccionado al iniciar una grabación."
                : "Windows oculta los nombres hasta conceder el permiso."}
            </small>
          </div>
          {micros.some((m) => m.label) ? (
            <select
              value={config.microfonoId ?? ""}
              onChange={(e) =>
                void actualizarConfig({ microfonoId: e.target.value || null })
              }
            >
              <option value="">Predeterminado del sistema</option>
              {micros.map((m) => (
                <option key={m.deviceId} value={m.deviceId}>
                  {m.label || m.deviceId.slice(0, 12)}
                </option>
              ))}
            </select>
          ) : (
            <button className="btn" onClick={() => void pedirNombresDeMicros()}>
              Ver micrófonos
            </button>
          )}
        </div>

        <div className="ajuste">
          <div className="ajuste-texto">
            <strong>Avisar si no se oye nada durante</strong>
            <small className="sutil">
              Detecta un micrófono desconectado o silenciado a mitad de clase.
              Nunca detiene la grabación, solo muestra un aviso. 0 lo desactiva.
            </small>
          </div>
          <div className="con-sufijo">
            <input
              type="number"
              min={0}
              max={60}
              step={1}
              value={config.minutosSilencioAviso}
              onChange={(e) =>
                void actualizarConfig({
                  minutosSilencioAviso: Math.max(0, Number(e.target.value)),
                })
              }
            />
            <span>min</span>
          </div>
        </div>

        <div className="ajuste">
          <div className="ajuste-texto">
            <strong>Avisar si queda menos de</strong>
            <small className="sutil">
              Se comprueba justo antes de empezar a grabar.
            </small>
          </div>
          <div className="con-sufijo">
            <input
              type="number"
              min={0}
              max={100}
              step={0.5}
              value={config.umbralDiscoGB}
              onChange={(e) =>
                void actualizarConfig({
                  umbralDiscoGB: Math.max(0, Number(e.target.value)),
                })
              }
            />
            <span>GB</span>
          </div>
        </div>
      </div>

      {/* --------------------------------------------------------- atajos */}
      <div className="tarjeta">
        <h3 className="titulo-seccion">Atajos de teclado</h3>

        <div className="ajuste">
          <div className="ajuste-texto">
            <strong>Usar atajos de teclado</strong>
            <small className="sutil">
              Apágalos si tu teclado no tiene teclas suficientes sin choques con
              funciones del sistema (volumen, brillo, etc.).
            </small>
          </div>
          <div className="conmutador">
            <button
              className={config.atajosActivos ? "activo" : ""}
              onClick={() => void actualizarConfig({ atajosActivos: true })}
            >
              Activos
            </button>
            <button
              className={!config.atajosActivos ? "activo" : ""}
              onClick={() => void actualizarConfig({ atajosActivos: false })}
            >
              Apagados
            </button>
          </div>
        </div>

        {config.atajosActivos && (
          <>
            <div className="ajuste">
              <div className="ajuste-texto">
                <strong>Funcionan con la app minimizada</strong>
                <small className="sutil">
                  Si están activos a nivel sistema, ninguna otra aplicación puede
                  usar esas teclas mientras ClassRecorder esté abierto.
                </small>
              </div>
              <div className="conmutador">
                <button
                  className={config.atajosGlobales ? "activo" : ""}
                  onClick={() => void actualizarConfig({ atajosGlobales: true })}
                >
                  Sistema
                </button>
                <button
                  className={!config.atajosGlobales ? "activo" : ""}
                  onClick={() => void actualizarConfig({ atajosGlobales: false })}
                >
                  Solo la ventana
                </button>
              </div>
            </div>

            {(
              [
                ["grabar", "Iniciar grabación"],
                ["pausar", "Pausar o reanudar"],
                ["detener", "Detener y guardar"],
                ["marcar", "Marcar momento"],
              ] as [keyof Atajos, string][]
            ).map(([clave, etiqueta]) => (
              <div className="ajuste" key={clave}>
                <div className="ajuste-texto">
                  <strong>{etiqueta}</strong>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className={`btn tecla ${capturando === clave ? "capturando" : ""}`}
                    onClick={() => setCapturando(capturando === clave ? null : clave)}
                  >
                    {capturando === clave
                      ? "Pulsa una combinación…"
                      : describirAtajo(config.atajos[clave])}
                  </button>
                  {config.atajos[clave] && (
                    <button
                      className="btn btn-mini"
                      title="Dejar sin asignar"
                      onClick={() =>
                        void actualizarConfig({ atajos: { [clave]: "" } })
                      }
                    >
                      Quitar
                    </button>
                  )}
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* --------------------------------------------------- transcripción */}
      <div className="tarjeta">
        <h3 className="titulo-seccion">Transcripción</h3>

        <div className="ajuste">
          <div className="ajuste-texto">
            <strong>Motor</strong>
            <small className="sutil">
              Cada motor usa sus propios modelos y se descargan por separado.
              faster-whisper suele ser más rápido y puntuar mejor en español;
              whisper.cpp ocupa mucho menos en disco.
            </small>
          </div>
          <div className="conmutador">
            <button
              className={config.motorTranscripcion === "whisper.cpp" ? "activo" : ""}
              onClick={() =>
                void actualizarConfig({ motorTranscripcion: "whisper.cpp" })
              }
            >
              whisper.cpp
            </button>
            <button
              className={
                config.motorTranscripcion === "faster-whisper" ? "activo" : ""
              }
              onClick={() =>
                void actualizarConfig({ motorTranscripcion: "faster-whisper" })
              }
            >
              faster-whisper
            </button>
          </div>
        </div>

        <div className="ajuste">
          <div className="ajuste-texto">
            <strong>Idioma</strong>
          </div>
          <select
            value={config.idiomaTranscripcion}
            onChange={(e) =>
              void actualizarConfig({ idiomaTranscripcion: e.target.value })
            }
          >
            <option value="es">Español</option>
            <option value="en">Inglés</option>
            <option value="pt">Portugués</option>
            <option value="fr">Francés</option>
            <option value="it">Italiano</option>
            <option value="auto">Detectar automáticamente</option>
          </select>
        </div>

        <div className="ajuste">
          <div className="ajuste-texto">
            <strong>Transcripciones a la vez</strong>
            <small className="sutil">
              Recomendado en este equipo: <strong>1</strong>. whisper ya reparte el
              trabajo entre todos los núcleos, así que lanzar dos suele hacer que
              las dos tarden más.
            </small>
          </div>
          <div className="con-sufijo">
            <input
              type="number"
              min={1}
              max={4}
              value={config.transcripcionesSimultaneas}
              onChange={(e) =>
                void actualizarConfig({
                  transcripcionesSimultaneas: Math.min(
                    4,
                    Math.max(1, Number(e.target.value)),
                  ),
                })
              }
            />
          </div>
        </div>

        <div className="ajuste">
          <div className="ajuste-texto">
            <strong>Núcleos para whisper</strong>
            <small className="sutil">
              Automático usa {hilosSugeridos}, dejando uno libre para que la app
              siga respondiendo.
            </small>
          </div>
          <div className="con-sufijo">
            <input
              type="number"
              min={0}
              max={16}
              value={config.hilosWhisper ?? 0}
              placeholder="auto"
              onChange={(e) => {
                const n = Number(e.target.value);
                void actualizarConfig({ hilosWhisper: n > 0 ? n : null });
              }}
            />
            <span>{config.hilosWhisper ? "núcleos" : "auto"}</span>
          </div>
        </div>
      </div>

      {/* --------------------------------------------------------- modelos */}
      <div className="tarjeta">
        <h3 className="titulo-seccion">
          Motor y modelos ·{" "}
          <span className="sutil">{config.motorTranscripcion}</span>
        </h3>
        <p className="sutil" style={{ marginBottom: 14 }}>
          Se muestran los del motor seleccionado arriba. Se descargan una sola
          vez y después la transcripción funciona sin internet. Se guardan en{" "}
          <code>{usandoFaster ? carpetaModelosFasterRuta : carpetaModelosRuta}</code>
        </p>

        {usandoFaster ? (
          <>
            <div className="ajuste">
              <div className="ajuste-texto">
                <strong>Motor faster-whisper</strong>
                <small className="sutil">
                  {instalacion.motorFasterInstalado
                    ? "Instalado y listo."
                    : "84 MB. Build de CPU, sin CUDA: esta máquina tiene gráfica Intel integrada."}
                </small>
              </div>
              {instalacion.motorFasterInstalado ? (
                <span className="chip">instalado</span>
              ) : descargando("motor-faster") ? (
                <BarraDescarga progreso={descargas["motor-faster"]} />
              ) : (
                <button
                  className="btn btn-primario"
                  onClick={() => void instalarFaster()}
                >
                  Instalar
                </button>
              )}
            </div>

            <table className="tabla-modelos">
              <thead>
                <tr>
                  <th>Modelo</th>
                  <th>Tamaño</th>
                  <th>Clase de 2 h</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {MODELOS_FASTER.map((m) => {
                  const instalado = instalacion.instaladosFaster.includes(m.id);
                  const enCurso = descargando(m.id);
                  const activo = config.modeloFaster === m.id;
                  return (
                    <tr key={m.id} className={activo ? "fila-activa" : ""}>
                      <td>
                        <strong>{m.etiqueta}</strong>
                        {activo && <span className="chip chip-mini">en uso</span>}
                        {m.exigeRam && (
                          <span className="chip chip-mini chip-aviso">
                            exige RAM
                          </span>
                        )}
                        <small className="sutil">{m.descripcion}</small>
                      </td>
                      <td className="numerico">
                        {m.mb >= 1024
                          ? `${(m.mb / 1024).toFixed(1)} GB`
                          : `${m.mb} MB`}
                      </td>
                      <td className="numerico">
                        ~{formatearDuracion(m.factorTiempo * CLASE_TIPO_SEG)}
                      </td>
                      <td className="acciones-celda">
                        {enCurso ? (
                          <BarraDescarga progreso={enCurso} />
                        ) : instalado ? (
                          <>
                            {!activo && (
                              <button
                                className="btn btn-mini"
                                onClick={() =>
                                  void actualizarConfig({
                                    modeloFaster: m.id as IdModeloFaster,
                                  })
                                }
                              >
                                Usar
                              </button>
                            )}
                            <button
                              className="btn-icono peligro"
                              title="Borrar del disco"
                              onClick={() => void quitarModeloFaster(m)}
                            >
                              <Icono nombre="basura" tamano={15} />
                            </button>
                          </>
                        ) : (
                          <button
                            className="btn btn-mini"
                            onClick={() => void descargarModeloFaster(m)}
                          >
                            Descargar
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        ) : (
          <>
            <div className="ajuste">
              <div className="ajuste-texto">
                <strong>Motor whisper.cpp</strong>
                <small className="sutil">
                  {instalacion.motorInstalado
                    ? "Instalado y listo."
                    : "8 MB. Necesario antes de transcribir cualquier cosa."}
                </small>
              </div>
              {instalacion.motorInstalado ? (
                <span className="chip">instalado</span>
              ) : descargando("motor") ? (
                <BarraDescarga progreso={descargas.motor} />
              ) : (
                <button
                  className="btn btn-primario"
                  onClick={() => void instalarMotor()}
                >
                  Instalar
                </button>
              )}
            </div>

            <table className="tabla-modelos">
              <thead>
                <tr>
                  <th>Modelo</th>
                  <th>Tamaño</th>
                  <th>Clase de 2 h</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {MODELOS.map((m) => {
                  const instalado = instalacion.instalados.includes(m.id);
                  const enCurso = descargando(m.id);
                  const activo = config.modelo === m.id;
                  return (
                    <tr key={m.id} className={activo ? "fila-activa" : ""}>
                      <td>
                        <strong>{m.etiqueta}</strong>
                        {activo && <span className="chip chip-mini">en uso</span>}
                        <small className="sutil">{m.descripcion}</small>
                      </td>
                      <td className="numerico">{m.mb} MB</td>
                      <td className="numerico">
                        ~{formatearDuracion(estimarSegundos(m, CLASE_TIPO_SEG))}
                      </td>
                      <td className="acciones-celda">
                        {enCurso ? (
                          <BarraDescarga progreso={enCurso} />
                        ) : instalado ? (
                          <>
                            {!activo && (
                              <button
                                className="btn btn-mini"
                                onClick={() =>
                                  void actualizarConfig({ modelo: m.id as IdModelo })
                                }
                              >
                                Usar
                              </button>
                            )}
                            <button
                              className="btn-icono peligro"
                              title="Borrar del disco"
                              onClick={() => void quitarModelo(m)}
                            >
                              <Icono nombre="basura" tamano={15} />
                            </button>
                          </>
                        ) : (
                          <button
                            className="btn btn-mini"
                            onClick={() => void descargarModelo(m)}
                          >
                            Descargar
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </div>

      {/* -------------------------------------------------------- respaldo */}
      <div className="tarjeta">
        <h3 className="titulo-seccion">Importar desde el celular</h3>
        <p className="sutil" style={{ marginBottom: 14 }}>
          Para traer grabaciones hechas con el teléfono. Todo pasa por la
          carpeta local que Google Drive ya sincroniza: la app no se conecta a
          Drive ni pide permisos de tu cuenta.
        </p>

        {errorInbox && (
          <div className="aviso aviso-error">
            <Icono nombre="alerta" />
            <span>{errorInbox}</span>
            <button className="btn-icono" onClick={() => setErrorInbox(null)}>
              <Icono nombre="equis" tamano={16} />
            </button>
          </div>
        )}

        {drive && !drive.instalado && !config.carpetaInbox && (
          <div className="aviso aviso-info">
            <Icono nombre="alerta" />
            <span>
              No encontré Google Drive para escritorio en esta máquina. Hace
              falta instalarlo y dejar que sincronice al menos una vez, para que
              exista la carpeta en el disco. Si ya lo tienes instalado en otra
              ubicación, elige la carpeta a mano igual.
            </span>
            <button
              className="btn btn-mini"
              onClick={() => void openUrl(URL_DESCARGA_DRIVE)}
            >
              Descargar
            </button>
          </div>
        )}

        <div className="ajuste">
          <div className="ajuste-texto">
            <strong>Carpeta de entrada</strong>
            <small className="sutil">
              {config.carpetaInbox ? (
                <code>{config.carpetaInbox}</code>
              ) : drive && drive.candidatas.length > 0 ? (
                `Se detectó tu Drive en ${drive.candidatas[0]}. Al elegirla se crea la subcarpeta ClassRecorder_Inbox adentro.`
              ) : (
                "Elige la carpeta raíz de tu Drive sincronizado. La subcarpeta ClassRecorder_Inbox se crea sola."
              )}
            </small>
          </div>
          <button
            className={config.carpetaInbox ? "btn" : "btn btn-primario"}
            onClick={() => void elegirInbox()}
          >
            <Icono nombre="carpeta" tamano={16} />{" "}
            {config.carpetaInbox ? "Cambiar" : "Elegir carpeta"}
          </button>
        </div>

        {config.carpetaInbox && (
          <div className="aviso aviso-ok">
            <Icono nombre="check" />
            <span>
              Desde el celular, sube tus audios a la carpeta{" "}
              <strong>ClassRecorder_Inbox</strong> de tu Drive. Después usa
              «Sincronizar desde el celular» acá o en la pantalla de Grabar para
              traerlos. Lo ya importado se archiva en la subcarpeta{" "}
              <code>importados</code>.
            </span>
            <button
              className="btn btn-mini"
              onClick={() => void revealItemInDir(config.carpetaInbox!)}
            >
              Abrir carpeta
            </button>
          </div>
        )}
      </div>

      <div className="tarjeta">
        <h3 className="titulo-seccion">Respaldo</h3>
        <p className="sutil" style={{ marginBottom: 14 }}>
          Genera un único .zip con las grabaciones, las transcripciones y los
          datos de la biblioteca. Para restaurar alcanza con descomprimirlo:
          las carpetas quedan tal cual, y <code>datos/</code> trae el índice y
          la configuración.
        </p>

        {errorRespaldo && (
          <div className="aviso aviso-error">
            <Icono nombre="alerta" />
            <span>{errorRespaldo}</span>
            <button className="btn-icono" onClick={() => setErrorRespaldo(null)}>
              <Icono nombre="equis" tamano={16} />
            </button>
          </div>
        )}

        {respaldoHecho && (
          <div className="aviso aviso-ok">
            <Icono nombre="check" />
            <span>
              Respaldo guardado en <code>{respaldoHecho}</code>
            </span>
            <button
              className="btn btn-mini"
              onClick={() => void revealItemInDir(respaldoHecho)}
            >
              Abrir carpeta
            </button>
          </div>
        )}

        <div className="ajuste">
          <div className="ajuste-texto">
            <strong>Incluir el audio</strong>
            <small className="sutil">
              Sin audio el respaldo queda chico y rápido, pero solo sirve para
              recuperar el texto y la organización, no las clases en sí.
            </small>
          </div>
          <div className="conmutador">
            <button
              className={incluirAudio ? "activo" : ""}
              onClick={() => setIncluirAudio(true)}
              disabled={respaldoEnCurso !== null}
            >
              Todo
            </button>
            <button
              className={!incluirAudio ? "activo" : ""}
              onClick={() => setIncluirAudio(false)}
              disabled={respaldoEnCurso !== null}
            >
              Solo datos
            </button>
          </div>
        </div>

        <div className="ajuste">
          <div className="ajuste-texto">
            <strong>
              {resumenRespaldo
                ? `${resumenRespaldo.archivos} ${
                    resumenRespaldo.archivos === 1 ? "archivo" : "archivos"
                  } · ${formatearBytes(resumenRespaldo.bytes)}`
                : "Calculando…"}
            </strong>
            <small className="sutil">
              {respaldoEnCurso
                ? `Comprimiendo ${respaldoEnCurso.archivos} de ${respaldoEnCurso.totalArchivos}…`
                : incluirAudio
                  ? "Tamaño aproximado del zip. El audio ya está comprimido, así que casi no baja."
                  : "Solo transcripciones, metadata y configuración."}
            </small>
          </div>
          {respaldoEnCurso ? (
            <div className="descarga">
              <div className="progreso">
                <div
                  className="progreso-valor"
                  style={{
                    width: `${
                      respaldoEnCurso.totalArchivos > 0
                        ? Math.round(
                            (respaldoEnCurso.archivos /
                              respaldoEnCurso.totalArchivos) *
                              100,
                          )
                        : 0
                    }%`,
                  }}
                />
              </div>
              <small className="sutil">
                {formatearBytes(respaldoEnCurso.bytes)}
              </small>
            </div>
          ) : (
            <button
              className="btn btn-primario"
              disabled={!resumenRespaldo || resumenRespaldo.archivos === 0}
              onClick={() => void exportarTodo()}
            >
              <Icono nombre="carpeta" tamano={16} /> Exportar todo
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function BarraDescarga({ progreso }: { progreso: ProgresoDescarga }) {
  if (progreso.etapa === "extrayendo") {
    return <span className="sutil">Extrayendo…</span>;
  }
  const fraccion = progreso.total > 0 ? progreso.bytes / progreso.total : 0;
  return (
    <div className="descarga">
      <div className="progreso">
        <div
          className="progreso-valor"
          style={{ width: `${Math.round(fraccion * 100)}%` }}
        />
      </div>
      <small className="sutil">
        {formatearBytes(progreso.bytes)}
        {progreso.total > 0 ? ` / ${formatearBytes(progreso.total)}` : ""}
      </small>
    </div>
  );
}
