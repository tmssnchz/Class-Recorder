import { useEffect, useState } from "react";

import { useStore } from "../estado/store";
import { fechaEmbebida } from "../lib/audio";
import {
  ETIQUETA_ORIGEN,
  estimarFecha,
  sugerirClase,
  type FechaEstimada,
} from "../lib/fechaAudio";
import { formatearBytes, formatearFecha, formatearHora } from "../lib/format";
import { bloqueEn } from "../lib/horario";
import {
  archivarImportado,
  elegirArchivos,
  escanearInbox,
  importarAudio,
  vieneDelInbox,
  type ArchivoInbox,
} from "../lib/importar";
import { SIN_CLASE, SIN_UNIDAD } from "../types";
import { Icono } from "./ui/Icono";

/** Estado de cada archivo dentro del modal. */
interface Fila {
  archivo: ArchivoInbox;
  claseId: string | null;
  unidadId: string | null;
  estado: "pendiente" | "importando" | "listo" | "error";
  mensaje?: string;
  /** Cuándo se estimó que se grabó, y de qué señal salió esa estimación. */
  estimada: FechaEstimada;
  /** true si la clase la propuso el horario y el usuario todavía no la tocó. */
  sugerida: boolean;
}

/**
 * De dónde salen los audios de esta sesión de importación.
 *
 * Son dos entradas distintas y con expectativas distintas: "carpeta" revisa
 * lo que Drive haya bajado, "archivos" abre el diálogo del sistema. Se
 * comparte la ventana porque de ahí en adelante el flujo es idéntico —
 * asignar clase, estimar fecha, convertir e indexar.
 */
export type ModoImportacion = "carpeta" | "archivos";

interface Props {
  modo: ModoImportacion;
  onCerrar(): void;
}

export function SincronizarCelular({ modo, onCerrar }: Props) {
  const { datos, config, agregarGrabacion, actualizarConfig } = useStore();
  const [escaneando, setEscaneando] = useState(true);
  const [filas, setFilas] = useState<Fila[]>([]);
  const [inestables, setInestables] = useState<ArchivoInbox[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [importando, setImportando] = useState(false);

  useEffect(() => {
    let vigente = true;
    void (async () => {
      // El escaneo del Inbox solo corre cuando el usuario pidió justamente eso.
      // En modo "archivos" no se toca Drive: abrir el diálogo del sistema no
      // debería quedarse esperando a que una carpeta sincronizada responda.
      if (modo !== "carpeta" || !config.carpetaInbox) {
        setEscaneando(false);
        return;
      }
      try {
        const encontrados = await escanearInbox(config.carpetaInbox);
        if (!vigente) return;

        const estables = encontrados.filter((a) => a.estable);
        const armadas: Fila[] = [];
        for (const archivo of estables) {
          // La metadata es la señal más confiable: se lee antes que nada.
          const metadata = await fechaEmbebida(archivo.ruta);
          const estimada = estimarFecha(
            archivo.nombre,
            archivo.llegadaMs,
            metadata,
            config.usarHoraDeSubida === true,
          );
          const claseId = sugerirClase(estimada, datos.horario, bloqueEn);
          armadas.push({
            archivo,
            claseId,
            unidadId: null,
            estado: "pendiente",
            estimada,
            sugerida: claseId !== null,
          });
        }
        if (!vigente) return;
        setFilas(armadas);
        setInestables(encontrados.filter((a) => !a.estable));
      } catch (e) {
        if (vigente) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (vigente) setEscaneando(false);
      }
    })();
    return () => {
      vigente = false;
    };
    // Se re-escanea si cambia el permiso de usar la hora de subida: eso puede
    // convertir un "sin fecha confiable" en una sugerencia válida.
  }, [modo, config.carpetaInbox, config.usarHoraDeSubida, datos.horario]);

  const actualizar = (ruta: string, cambios: Partial<Fila>) =>
    setFilas((fs) => fs.map((f) => (f.archivo.ruta === ruta ? { ...f, ...cambios } : f)));

  /** Archivos elegidos a mano desde el disco, con el mismo tratamiento. */
  const agregarDelDisco = async () => {
    setError(null);
    try {
      const elegidos = await elegirArchivos("audio");
      const nuevas: Fila[] = [];
      for (const archivo of elegidos) {
        if (filas.some((f) => f.archivo.ruta === archivo.ruta)) continue;
        const metadata = await fechaEmbebida(archivo.ruta);
        const estimada = estimarFecha(
          archivo.nombre,
          archivo.llegadaMs,
          metadata,
          config.usarHoraDeSubida === true,
        );
        const claseId = sugerirClase(estimada, datos.horario, bloqueEn);
        nuevas.push({
          archivo,
          claseId,
          unidadId: null,
          estado: "pendiente",
          estimada,
          sugerida: claseId !== null,
        });
      }
      setFilas((fs) => [...fs, ...nuevas]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // En modo "archivos" el diálogo del sistema se abre de una: el usuario ya
  // dijo qué quería al apretar el botón, no tiene sentido pedirle un click más.
  useEffect(() => {
    if (modo === "archivos") void agregarDelDisco();
    // Solo al montar: reabrir el diálogo en cada render sería insoportable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const importarTodas = async () => {
    setImportando(true);
    setError(null);

    for (const fila of filas) {
      if (fila.estado === "listo") continue;
      actualizar(fila.archivo.ruta, { estado: "importando", mensaje: undefined });

      try {
        const clase = datos.clases.find((c) => c.id === fila.claseId) ?? null;
        const unidad = clase?.unidades.find((u) => u.id === fila.unidadId) ?? null;

        const grabacion = await importarAudio(
          fila.archivo.ruta,
          {
            claseId: clase?.id ?? null,
            unidadId: unidad?.id ?? null,
            claseNombre: clase?.nombre ?? SIN_CLASE,
            unidadNombre: unidad?.nombre ?? SIN_UNIDAD,
            fecha: fila.estimada.fecha,
          },
          config,
          datos.grabaciones,
        );

        await agregarGrabacion(grabacion);
        // Recién se archiva cuando la grabación ya quedó indexada: si algo
        // falla antes, el archivo sigue en el Inbox para reintentar. Lo que el
        // usuario eligió a mano del disco no se toca: mover el archivo de
        // alguien a una subcarpeta que no creó sería una sorpresa fea.
        if (vieneDelInbox(fila.archivo.ruta, config.carpetaInbox)) {
          await archivarImportado(fila.archivo.ruta, config.carpetaInbox!);
        }
        actualizar(fila.archivo.ruta, { estado: "listo" });
      } catch (e) {
        actualizar(fila.archivo.ruta, {
          estado: "error",
          mensaje: e instanceof Error ? e.message : String(e),
        });
      }
    }

    setImportando(false);
  };

  const pendientes = filas.filter((f) => f.estado !== "listo").length;
  const listas = filas.filter((f) => f.estado === "listo").length;
  const sinFechaConfiable = filas.filter(
    (f) => f.estimada.origen === "ninguna",
  ).length;

  return (
    <div className="modal-fondo" onClick={importando ? undefined : onCerrar}>
      <div
        className="modal modal-sincronizar"
        role="dialog"
        aria-modal="true"
        aria-label={
          modo === "carpeta" ? "Sincronizar desde el celular" : "Importar archivos de audio"
        }
        onClick={(e) => e.stopPropagation()}
      >
        <h3>
          {modo === "carpeta" ? "Sincronizar desde el celular" : "Importar archivos de audio"}
        </h3>

        <p className="sutil">
          {modo === "carpeta"
            ? "Lo que el celular haya subido a la carpeta sincronizada."
            : "Audios que ya tienes en el computador."}
          <button className="btn btn-mini" onClick={() => void agregarDelDisco()}>
            <Icono nombre="carpeta" tamano={14} />{" "}
            {modo === "carpeta" ? "Añadir archivos del computador" : "Elegir más archivos"}
          </button>
        </p>

        {modo === "carpeta" && !config.carpetaInbox && (
          <div className="aviso aviso-info">
            <Icono nombre="nube" />
            <span>
              Todavía no hay carpeta sincronizada. Se configura una sola vez en{" "}
              <strong>Configuración › Importar desde el celular</strong>: la app
              crea una carpeta <code>ClassRecorder_Inbox</code> dentro de tu
              OneDrive o Drive, y desde el celular subes ahí los audios y las
              fotos de apuntes. Mientras tanto puedes elegir archivos del
              computador.
            </span>
          </div>
        )}

        {error && (
          <div className="aviso aviso-error">
            <Icono nombre="alerta" />
            <span>{error}</span>
          </div>
        )}

        {inestables.length > 0 && (
          <div className="aviso aviso-info">
            <Icono nombre="alerta" />
            <span>
              {inestables.length === 1
                ? "Un archivo todavía se está sincronizando"
                : `${inestables.length} archivos todavía se están sincronizando`}{" "}
              y se saltearon: {inestables.map((a) => a.nombre).join(", ")}. Espera
              a que Drive termine y sincroniza de nuevo.
            </span>
          </div>
        )}

        {/*
          Solo se pregunta si de verdad hace falta: si la metadata o el nombre
          resolvieron la fecha de todos los archivos, este aviso no aparece.
        */}
        {sinFechaConfiable > 0 && config.usarHoraDeSubida !== true && (
          <div className="aviso aviso-info">
            <Icono nombre="alerta" />
            <span>
              No pude determinar la hora de grabación de{" "}
              {sinFechaConfiable === 1
                ? "un archivo"
                : `${sinFechaConfiable} archivos`}
              : no traen fecha adentro ni en el nombre. ¿Uso la hora en que se
              subieron como referencia para sugerir la clase?
              <span className="acciones-aviso">
                <button
                  className="btn btn-mini"
                  onClick={() => void actualizarConfig({ usarHoraDeSubida: true })}
                >
                  Usar la hora de subida
                </button>
                <button
                  className="btn btn-mini"
                  onClick={() => void actualizarConfig({ usarHoraDeSubida: false })}
                >
                  Asignar a mano
                </button>
              </span>
            </span>
          </div>
        )}

        {escaneando ? (
          <p className="sutil">Buscando grabaciones nuevas…</p>
        ) : filas.length === 0 ? (
          <p className="vacio">
            {modo === "carpeta"
              ? "No hay grabaciones nuevas en la carpeta sincronizada."
              : "No se eligió ningún archivo."}
          </p>
        ) : (
          <>
            <p className="sutil">
              Elige a qué clase va cada una. Se pueden dejar sin clasificar y
              acomodarlas después desde la Biblioteca.
            </p>

            <ul className="lista lista-importacion">
              {filas.map((f) => {
                const clase =
                  datos.clases.find((c) => c.id === f.claseId) ?? null;
                return (
                  <li key={f.archivo.ruta} className="item item-estatico">
                    <div className="item-texto">
                      <strong>{f.archivo.nombre}</strong>
                      <small className="sutil">
                        {formatearBytes(f.archivo.bytes)} ·{" "}
                        {f.estimada.origen === "ninguna" ? (
                          "sin fecha confiable"
                        ) : (
                          <>
                            {formatearFecha(f.estimada.fecha.toISOString())}
                            {f.estimada.horaConfiable && (
                              <> a las {formatearHora(f.estimada.fecha.toISOString())}</>
                            )}{" "}
                            <span className="origen-fecha">
                              (
                              {f.estimada.horaConfiable
                                ? ETIQUETA_ORIGEN[f.estimada.origen]
                                : "fecha en el nombre, sin hora"}
                              )
                            </span>
                          </>
                        )}
                        {f.sugerida && f.claseId && (
                          <span className="chip chip-mini">sugerida por horario</span>
                        )}
                      </small>
                      {f.mensaje && (
                        <small className="error-inline">{f.mensaje}</small>
                      )}
                    </div>

                    {f.estado === "listo" ? (
                      <span className="chip chip-ok">importada</span>
                    ) : f.estado === "importando" ? (
                      <span className="chip">importando…</span>
                    ) : (
                      <div className="selectores-fila">
                        <select
                          value={f.claseId ?? ""}
                          disabled={importando}
                          onChange={(e) =>
                            actualizar(f.archivo.ruta, {
                              claseId: e.target.value || null,
                              unidadId: null,
                              // Tocarla deja de ser una sugerencia del horario.
                              sugerida: false,
                            })
                          }
                        >
                          <option value="">{SIN_CLASE}</option>
                          {datos.clases.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.nombre}
                            </option>
                          ))}
                        </select>
                        <select
                          value={f.unidadId ?? ""}
                          disabled={importando || !clase}
                          onChange={(e) =>
                            actualizar(f.archivo.ruta, {
                              unidadId: e.target.value || null,
                            })
                          }
                        >
                          <option value="">{SIN_UNIDAD}</option>
                          {clase?.unidades.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.nombre}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}

        <div className="modal-acciones">
          <button className="btn" disabled={importando} onClick={onCerrar}>
            {listas > 0 && pendientes === 0 ? "Cerrar" : "Cancelar"}
          </button>
          {pendientes > 0 && (
            <button
              className="btn btn-primario"
              disabled={importando || escaneando}
              onClick={() => void importarTodas()}
            >
              {importando
                ? "Importando…"
                : `Importar ${pendientes} ${
                    pendientes === 1 ? "grabación" : "grabaciones"
                  }`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
