/**
 * Cola de importación de fotos: vigila la misma carpeta de Drive que ya usa la
 * importación de audio, muestra miniaturas de lo nuevo y deja asignar clase y
 * unidad antes de procesar.
 *
 * Comparte carpeta con los audios a propósito — pedir dos carpetas
 * sincronizadas distintas sería peor — y se separan por extensión en Rust
 * (`escanear_inbox_fotos`), así que una foto nunca aparece en la cola de
 * audios ni al revés.
 */
import { useCallback, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { useStore } from "../../estado/store";
import { estimarFecha, sugerirClase } from "../../lib/fechaAudio";
import { formatearBytes, formatearFecha } from "../../lib/format";
import { bloqueEn } from "../../lib/horario";
import {
  archivarImportado,
  elegirArchivos,
  escanearInboxFotos,
  vieneDelInbox,
  type ArchivoInbox,
} from "../../lib/importar";
import { Icono } from "../ui/Icono";

interface Props {
  /** Se llama con las fotos elegidas, ya listas para el modo ráfaga. */
  onEscanear(fotos: string[], claseId: string | null, unidadId: string | null): void;
  /**
   * Igual, pero pasando primero por el mesón de organización.
   *
   * Es el camino para una tanda de hojas mezcladas, donde hay que ver todas las
   * fotos juntas antes de decidir qué apunte arma cada una.
   */
  onOrganizar(fotos: string[], claseId: string | null, unidadId: string | null): void;
}

export function ColaFotos({ onEscanear, onOrganizar }: Props) {
  const { datos, config } = useStore();
  const [fotos, setFotos] = useState<ArchivoInbox[]>([]);
  const [inestables, setInestables] = useState<ArchivoInbox[]>([]);
  const [elegidas, setElegidas] = useState<Set<string>>(new Set());
  const [claseId, setClaseId] = useState<string | null>(null);
  const [unidadId, setUnidadId] = useState<string | null>(null);
  const [escaneando, setEscaneando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clase = datos.clases.find((c) => c.id === claseId) ?? null;

  /**
   * Propone la clase mirando el horario y la fecha de la foto, igual que hace
   * la importación de audio. Una foto de apuntes casi siempre se saca en la
   * clase o justo después, así que el horario acierta bastante.
   */
  const sugerirDesdeHorario = useCallback(
    (candidatas: ArchivoInbox[]) => {
      const primera = [...candidatas].sort((a, b) => a.llegadaMs - b.llegadaMs)[0];
      if (!primera) return;
      // Sin metadata: para una foto la fecha del archivo es la mejor señal que
      // hay sin leer el EXIF.
      const estimada = estimarFecha(primera.nombre, primera.llegadaMs, null, true);
      const sugerida = sugerirClase(estimada, datos.horario, bloqueEn);
      if (sugerida) {
        setClaseId(sugerida);
        setUnidadId(null);
      }
    },
    [datos.horario],
  );

  const revisar = useCallback(async () => {
    if (!config.carpetaInbox) return;
    setEscaneando(true);
    setError(null);
    try {
      const encontradas = await escanearInboxFotos(config.carpetaInbox);
      setFotos(encontradas.filter((f) => f.estable));
      // Drive todavía las está bajando: mostrarlas como elegibles llevaría a
      // procesar un archivo a medias.
      setInestables(encontradas.filter((f) => !f.estable));
      const estables = encontradas.filter((f) => f.estable);
      setElegidas(new Set(estables.map((f) => f.ruta)));
      sugerirDesdeHorario(estables);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setEscaneando(false);
    }
  }, [config.carpetaInbox, sugerirDesdeHorario]);

  /** Fotos elegidas a mano desde el disco, sin pasar por Drive. */
  const agregarDelDisco = async () => {
    setError(null);
    try {
      const elegidas = await elegirArchivos("foto");
      if (elegidas.length === 0) return;
      setFotos((fs) => {
        const conocidas = new Set(fs.map((f) => f.ruta));
        return [...fs, ...elegidas.filter((f) => !conocidas.has(f.ruta))];
      });
      setElegidas((s) => new Set([...s, ...elegidas.map((f) => f.ruta)]));
      if (!claseId) sugerirDesdeHorario(elegidas);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const alternar = (ruta: string) =>
    setElegidas((s) => {
      const copia = new Set(s);
      if (copia.has(ruta)) copia.delete(ruta);
      else copia.add(ruta);
      return copia;
    });

  // Orden de llegada: es el orden en que se sacaron las fotos, que suele ser
  // el orden de las hojas.
  const ordenadas = [...fotos].sort((a, b) => a.llegadaMs - b.llegadaMs);

  return (
    <div className="cola-fotos">
      <div className="panel-cabecera">
        <h3>Fotos por digitalizar</h3>
        <div className="acciones-fila">
          <button className="btn" onClick={() => void agregarDelDisco()}>
            <Icono nombre="carpeta" />
            Elegir del computador
          </button>
          <button
            className="btn"
            onClick={() => void revisar()}
            disabled={escaneando || !config.carpetaInbox}
            title={
              config.carpetaInbox
                ? "Busca fotos nuevas en la carpeta que sincroniza el celular"
                : "Configura primero la carpeta sincronizada en Grabar › Sincronizar desde el celular"
            }
          >
            <Icono nombre="nube" />
            {escaneando ? "Revisando…" : "Revisar la carpeta"}
          </button>
        </div>
      </div>

      {error && (
        <div className="aviso aviso-error">
          <Icono nombre="alerta" />
          <span>{error}</span>
        </div>
      )}

      {inestables.length > 0 && (
        <div className="aviso aviso-info">
          <Icono nombre="nube" />
          <span>
            {inestables.length}{" "}
            {inestables.length === 1 ? "foto se está bajando" : "fotos se están bajando"} de
            Drive. Vuelve a revisar en un momento.
          </span>
        </div>
      )}

      {ordenadas.length === 0 && !escaneando && (
        <p className="vacio">
          {config.carpetaInbox ? (
            <>
              Elige fotos del computador, o revisa la carpeta{" "}
              <code>ClassRecorder_Inbox</code> a ver si el celular subió algo.
            </>
          ) : (
            <>
              Elige fotos del computador para digitalizarlas. Si quieres que
              lleguen solas desde el celular, configura la carpeta sincronizada
              en <strong>Grabar › Sincronizar desde el celular</strong>.
            </>
          )}
        </p>
      )}

      {ordenadas.length > 0 && (
        <>
          <div className="miniaturas">
            {ordenadas.map((f) => (
              <button
                key={f.ruta}
                className={`miniatura ${elegidas.has(f.ruta) ? "elegida" : ""}`}
                onClick={() => alternar(f.ruta)}
                title={`${f.nombre} · ${formatearBytes(f.bytes)}`}
              >
                <img src={convertFileSrc(f.ruta)} alt={f.nombre} loading="lazy" />
                <small>{formatearFecha(new Date(f.llegadaMs).toISOString())}</small>
                {elegidas.has(f.ruta) && (
                  <span className="marca-elegida">
                    <Icono nombre="check" tamano={14} />
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="selectores">
            <label>
              <span>
                Clase
                {claseId && (
                  <small className="sutil"> · sugerida por tu horario</small>
                )}
              </span>
              <select
                value={claseId ?? ""}
                onChange={(e) => {
                  setClaseId(e.target.value || null);
                  setUnidadId(null);
                }}
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
                value={unidadId ?? ""}
                onChange={(e) => setUnidadId(e.target.value || null)}
                disabled={!clase}
              >
                <option value="">Sin unidad</option>
                {clase?.unidades.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.nombre}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="acciones-fila">
            <button
              className="btn"
              disabled={elegidas.size === 0}
              title="Muestra todas las fotos juntas para repartirlas en apuntes y ordenarlas antes de recortar. Es lo que sirve cuando las hojas están mezcladas."
              onClick={() =>
                onOrganizar(
                  ordenadas.filter((f) => elegidas.has(f.ruta)).map((f) => f.ruta),
                  claseId,
                  unidadId,
                )
              }
            >
              <Icono nombre="carpeta" />
              Organizar primero
            </button>
            <button
              className="btn btn-primario"
              disabled={elegidas.size === 0}
              onClick={() =>
                onEscanear(
                  ordenadas.filter((f) => elegidas.has(f.ruta)).map((f) => f.ruta),
                  claseId,
                  unidadId,
                )
              }
            >
              <Icono nombre="apunte" />
              Escanear {elegidas.size} {elegidas.size === 1 ? "hoja" : "hojas"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Mueve una foto ya procesada al subdirectorio de importados.
 *
 * Solo las que llegaron por la carpeta sincronizada: una foto que el usuario
 * eligió del disco se deja donde estaba.
 */
export async function archivarFoto(
  ruta: string,
  carpetaInbox: string | null,
): Promise<void> {
  if (!vieneDelInbox(ruta, carpetaInbox)) return;
  try {
    await archivarImportado(ruta, carpetaInbox!);
  } catch (e) {
    // Que no se pueda archivar no invalida el escaneo: la hoja ya está
    // digitalizada. Solo va a volver a aparecer en la próxima revisión.
    console.warn("No se pudo archivar la foto importada", e);
  }
}
