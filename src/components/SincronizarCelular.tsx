import { useEffect, useState } from "react";

import { useStore } from "../estado/store";
import { formatearBytes, formatearFecha, formatearHora } from "../lib/format";
import {
  archivarImportado,
  escanearInbox,
  importarAudio,
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
}

interface Props {
  onCerrar(): void;
}

export function SincronizarCelular({ onCerrar }: Props) {
  const { datos, config, agregarGrabacion } = useStore();
  const [escaneando, setEscaneando] = useState(true);
  const [filas, setFilas] = useState<Fila[]>([]);
  const [inestables, setInestables] = useState<ArchivoInbox[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [importando, setImportando] = useState(false);

  useEffect(() => {
    let vigente = true;
    void (async () => {
      if (!config.carpetaInbox) return;
      try {
        const encontrados = await escanearInbox(config.carpetaInbox);
        if (!vigente) return;
        setFilas(
          encontrados
            .filter((a) => a.estable)
            .map((archivo) => ({
              archivo,
              claseId: null,
              unidadId: null,
              estado: "pendiente" as const,
            })),
        );
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
  }, [config.carpetaInbox]);

  const actualizar = (ruta: string, cambios: Partial<Fila>) =>
    setFilas((fs) => fs.map((f) => (f.archivo.ruta === ruta ? { ...f, ...cambios } : f)));

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
            // Sin horario configurado todavía, la referencia es la hora de
            // llegada del archivo. El paso de sugerencia la va a afinar.
            fecha: new Date(fila.archivo.llegadaMs),
          },
          config,
        );

        await agregarGrabacion(grabacion);
        // Recién se archiva cuando la grabación ya quedó indexada: si algo
        // falla antes, el archivo sigue en el Inbox para reintentar.
        if (config.carpetaInbox) {
          await archivarImportado(fila.archivo.ruta, config.carpetaInbox);
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

  return (
    <div className="modal-fondo" onClick={importando ? undefined : onCerrar}>
      <div
        className="modal modal-sincronizar"
        role="dialog"
        aria-modal="true"
        aria-label="Sincronizar desde el celular"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Sincronizar desde el celular</h3>

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

        {escaneando ? (
          <p className="sutil">Buscando grabaciones nuevas…</p>
        ) : filas.length === 0 ? (
          <p className="vacio">No hay grabaciones nuevas para importar.</p>
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
                        {formatearBytes(f.archivo.bytes)} · llegó el{" "}
                        {formatearFecha(new Date(f.archivo.llegadaMs).toISOString())}{" "}
                        a las{" "}
                        {formatearHora(new Date(f.archivo.llegadaMs).toISOString())}
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
