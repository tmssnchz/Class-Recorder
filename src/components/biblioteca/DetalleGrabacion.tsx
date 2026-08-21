import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { useStore } from "../../estado/store";
import { useTranscripciones } from "../../estado/transcripciones";
import { borrarArchivos, moverGrabacion, renombrarGrabacion } from "../../lib/biblioteca";
import { olvidarCache } from "../../lib/busqueda";
import { exportarTranscripcion, type FormatoExportacion } from "../../lib/exportar";
import { VistaTranscripcion } from "./VistaTranscripcion";
import type { Segmento } from "../../types";
import {
  formatearBytes,
  formatearDuracion,
  formatearFechaLarga,
  formatearHora,
} from "../../lib/format";
import { escribirMetaGrabacion, raizDeClase } from "../../lib/grabaciones";
import {
  borrarArchivoMaterial,
  materialesVisiblesDe,
  moverMaterialesDeGrabacion,
} from "../../lib/materiales";
import { ListaMateriales } from "../ui/ListaMateriales";
import { RecortarAudio } from "./RecortarAudio";
import { SIN_CLASE, SIN_UNIDAD, type Grabacion } from "../../types";
import { Icono } from "../ui/Icono";
import { ModalConfirmacion } from "../ui/ModalConfirmacion";
import { ModalDescargaNube } from "../ui/ModalDescargaNube";
import { Reproductor } from "../ui/Reproductor";
import { useDescargaNube } from "../../hooks/useDescargaNube";

interface Props {
  grabacion: Grabacion;
  progresoConversion?: number;
  /** Consulta del buscador global, para resaltarla dentro de la transcripción. */
  resaltar?: string;
  onEliminada(): void;
  /** Se llama cuando "Recortar" crea una copia nueva, para poder seleccionarla. */
  onRecortada?(nuevaId: string): void;
}

export function DetalleGrabacion({
  grabacion,
  progresoConversion,
  resaltar,
  onEliminada,
  onRecortada,
}: Props) {
  const {
    datos,
    config,
    agregarGrabacion,
    actualizarGrabacion,
    quitarGrabacion,
    quitarMaterial,
    reemplazarMateriales,
  } = useStore();
  const { tareas } = useTranscripciones();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const {
    estado: estadoDescarga,
    asegurar: asegurarAudio,
    confirmar: confirmarDescarga,
    cancelar: cancelarDescarga,
    cerrar: cerrarDescarga,
  } = useDescargaNube();

  const [editandoTitulo, setEditandoTitulo] = useState(false);
  const [titulo, setTitulo] = useState(grabacion.titulo);
  const [notaClase, setNotaClase] = useState(grabacion.notaClase);
  const [tagNuevo, setTagNuevo] = useState("");
  const [confirmandoBorrado, setConfirmandoBorrado] = useState(false);
  const [recortando, setRecortando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  // Cambiar esto remonta el <audio>: hace falta después de mover o renombrar.
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    setTitulo(grabacion.titulo);
    setEditandoTitulo(false);
    setError(null);
    setNotaClase(grabacion.notaClase);
  }, [grabacion.id, grabacion.titulo, grabacion.notaClase]);

  const clase = datos.clases.find((c) => c.id === grabacion.claseId) ?? null;
  const convirtiendo = grabacion.estado === "convirtiendo";

  /**
   * Mover, renombrar o borrar mientras whisper está trabajando dejaría el .txt
   * final escrito en la carpeta vieja: la transcripción arrancó con una copia
   * de las rutas de este momento. Se bloquea hasta que termine.
   */
  const materiales = materialesVisiblesDe(datos.materiales, grabacion);

  const tareaActiva = tareas[grabacion.id];
  const transcribiendo = Boolean(tareaActiva && tareaActiva.estado !== "error");
  const bloqueadoPorArchivos = ocupado || transcribiendo;

  const src = useMemo(
    () => `${convertFileSrc(grabacion.archivoAudio)}?v=${revision}`,
    [grabacion.archivoAudio, revision],
  );

  /** Windows no deja renombrar ni borrar un archivo que el webview tiene abierto. */
  const liberarAudio = () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  };

  const guardar = async (cambios: Partial<Grabacion>) => {
    await actualizarGrabacion(grabacion.id, cambios);
    await escribirMetaGrabacion({ ...grabacion, ...cambios });
  };

  const conArchivos = async (accion: () => Promise<void>) => {
    setOcupado(true);
    setError(null);
    liberarAudio();
    try {
      // Pequeña espera: el webview suelta el archivo de forma asíncrona.
      await new Promise((r) => setTimeout(r, 120));
      await accion();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRevision((r) => r + 1);
      setOcupado(false);
    }
  };

  const reasignar = (claseId: string | null, unidadId: string | null) => {
    const claseDestino = datos.clases.find((c) => c.id === claseId) ?? null;
    const unidadDestino =
      claseDestino?.unidades.find((u) => u.id === unidadId) ?? null;
    const claseNombre = claseDestino?.nombre ?? SIN_CLASE;
    const unidadNombre = unidadDestino?.nombre ?? SIN_UNIDAD;
    // Si la clase destino ya tiene grabaciones en otra raíz, se respeta esa:
    // así no queda una misma clase repartida entre dos carpetas del disco.
    const raiz = raizDeClase(datos.grabaciones, claseDestino?.id ?? null, config.carpetaRaiz);
    void conArchivos(async () => {
      const cambios = await moverGrabacion(grabacion, raiz, {
        claseId: claseDestino?.id ?? null,
        unidadId: unidadDestino?.id ?? null,
        claseNombre,
        unidadNombre,
      });
      await actualizarGrabacion(grabacion.id, cambios);
      // El material propio sigue al audio, igual que el .txt y el .json.
      await reemplazarMateriales(
        await moverMaterialesDeGrabacion(materiales.propios, raiz, claseNombre, unidadNombre),
      );
    });
  };

  const aplicarRenombre = () => {
    setEditandoTitulo(false);
    if (titulo.trim() === grabacion.titulo) return;
    void conArchivos(async () => {
      const cambios = await renombrarGrabacion(grabacion, titulo.trim());
      await actualizarGrabacion(grabacion.id, cambios);
    });
  };

  const agregarTag = (valor: string) => {
    const tag = valor.trim().toLowerCase();
    if (!tag || grabacion.tags.includes(tag)) return;
    void guardar({ tags: [...grabacion.tags, tag] });
    setTagNuevo("");
  };

  const eliminar = (borrandoArchivos: boolean) => {
    void conArchivos(async () => {
      if (borrandoArchivos) {
        await borrarArchivos(grabacion);
        // El material propio sigue la misma decisión que el audio.
        for (const m of materiales.propios) await borrarArchivoMaterial(m);
      }
      for (const m of materiales.propios) await quitarMaterial(m.id);
      await quitarGrabacion(grabacion.id);
      setConfirmandoBorrado(false);
      onEliminada();
    });
  };

  const alTerminarRecorte = (resultado: Grabacion, reemplazo: boolean) => {
    setRecortando(false);
    if (reemplazo) {
      // Mismo id: se actualiza en el lugar, igual que mover o renombrar.
      void conArchivos(async () => {
        await actualizarGrabacion(grabacion.id, resultado);
      });
    } else {
      // Grabación nueva: el original queda como estaba, se agrega la copia
      // y se le pasa la posta a quien nos contiene para que la seleccione.
      void agregarGrabacion(resultado).then(() => onRecortada?.(resultado.id));
    }
  };

  const saltarA = (segundo: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = segundo;
    void audio.play().catch(() => undefined);
  };

  const exportar = (segmentos: Segmento[], formato: FormatoExportacion) => {
    void exportarTranscripcion(grabacion, segmentos, formato).catch((e) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  };

  // Al mover o renombrar cambia la ruta del .txt: el buscador global no debe
  // seguir sirviendo el contenido cacheado con la ruta vieja.
  useEffect(() => {
    if (grabacion.transcripcion) olvidarCache(grabacion.transcripcion.archivo);
  }, [grabacion.transcripcion]);

  return (
    <div className="detalle">
      <div className="detalle-titulo">
        {editandoTitulo ? (
          <form
            className="form-linea"
            onSubmit={(e) => {
              e.preventDefault();
              aplicarRenombre();
            }}
          >
            <input
              autoFocus
              value={titulo}
              maxLength={90}
              onChange={(e) => setTitulo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setTitulo(grabacion.titulo);
                  setEditandoTitulo(false);
                }
              }}
            />
            <button className="btn-icono" type="submit" title="Guardar">
              <Icono nombre="check" tamano={16} />
            </button>
          </form>
        ) : (
          <>
            <h2>{grabacion.titulo}</h2>
            <button
              className="btn-icono"
              title={
                transcribiendo
                  ? "No se puede renombrar mientras se transcribe"
                  : "Renombrar"
              }
              disabled={bloqueadoPorArchivos}
              onClick={() => setEditandoTitulo(true)}
            >
              <Icono nombre="lapiz" tamano={16} />
            </button>
          </>
        )}
      </div>

      <p className="sutil detalle-meta">
        {formatearFechaLarga(grabacion.fechaISO)} · {formatearHora(grabacion.fechaISO)}{" "}
        · {formatearDuracion(grabacion.duracionSeg)} ·{" "}
        {formatearBytes(grabacion.bytes)} · {grabacion.formato.toUpperCase()}
      </p>

      {error && (
        <div className="aviso aviso-error">
          <Icono nombre="alerta" />
          <span>{error}</span>
          <button className="btn-icono" onClick={() => setError(null)}>
            <Icono nombre="equis" tamano={16} />
          </button>
        </div>
      )}

      {convirtiendo && (
        <div className="aviso aviso-info">
          <Icono nombre="alerta" />
          <span>
            Convirtiendo a {config.formatoAudio.toUpperCase()}
            {progresoConversion !== undefined
              ? ` — ${Math.round(progresoConversion * 100)}%`
              : "…"}
            . Mientras tanto se puede escuchar el archivo original.
          </span>
        </div>
      )}

      {grabacion.estado === "error-conversion" && (
        <div className="aviso aviso-error">
          <Icono nombre="alerta" />
          <span>
            No se pudo convertir el audio, quedó en formato WebM (se escucha
            igual). {grabacion.errorConversion}
          </span>
        </div>
      )}

      {!ocupado && (
        <Reproductor
          key={src}
          src={src}
          duracionEstimada={grabacion.duracionSeg}
          marcas={grabacion.marcas}
          audioRef={audioRef}
          antesDeReproducir={() => asegurarAudio(grabacion.archivoAudio)}
        />
      )}
      <ModalDescargaNube
        estado={estadoDescarga}
        onConfirmar={confirmarDescarga}
        onCancelar={cancelarDescarga}
        onCerrar={cerrarDescarga}
      />

      {transcribiendo && (
        <div className="aviso aviso-info">
          <Icono nombre="alerta" />
          <span>
            Mientras se transcribe no se puede mover, renombrar ni eliminar esta
            grabación: los archivos están en uso. Se desbloquea al terminar.
          </span>
        </div>
      )}

      <div className="selectores">
        <label>
          <span>Clase</span>
          <select
            value={grabacion.claseId ?? ""}
            disabled={bloqueadoPorArchivos}
            onChange={(e) => reasignar(e.target.value || null, null)}
          >
            <option value="">{SIN_CLASE}</option>
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
            value={grabacion.unidadId ?? ""}
            disabled={bloqueadoPorArchivos || !clase}
            onChange={(e) =>
              reasignar(grabacion.claseId, e.target.value || null)
            }
          >
            <option value="">{SIN_UNIDAD}</option>
            {clase?.unidades.map((u) => (
              <option key={u.id} value={u.id}>
                {u.nombre}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="bloque">
        <h3 className="titulo-seccion">Etiquetas</h3>
        <div className="tags">
          {grabacion.tags.map((t) => (
            <span key={t} className="tag">
              {t}
              <button
                className="tag-quitar"
                title="Quitar etiqueta"
                onClick={() =>
                  void guardar({ tags: grabacion.tags.filter((x) => x !== t) })
                }
              >
                ×
              </button>
            </span>
          ))}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              agregarTag(tagNuevo);
            }}
          >
            <input
              className="tag-input"
              value={tagNuevo}
              placeholder="+ etiqueta"
              maxLength={30}
              onChange={(e) => setTagNuevo(e.target.value)}
            />
          </form>
        </div>
      </div>

      <div className="bloque">
        <h3 className="titulo-seccion">Nota de la clase</h3>
        <textarea
          rows={4}
          placeholder="¿Qué se conversó en esta clase?"
          value={notaClase}
          onChange={(e) => setNotaClase(e.target.value)}
          onBlur={() => {
            if (notaClase !== grabacion.notaClase) void guardar({ notaClase });
          }}
        />
      </div>

      <div className="bloque">
        <h3 className="titulo-seccion">
          Momentos marcados <span className="sutil">({grabacion.marcas.length})</span>
        </h3>
        {grabacion.marcas.length === 0 ? (
          <p className="sutil">No se marcó ningún momento en esta grabación.</p>
        ) : (
          <ul className="lista-marcas">
            {[...grabacion.marcas]
              .sort((a, b) => a.segundo - b.segundo)
              .map((m) => (
                <li key={m.id}>
                  <button
                    className="sello sello-boton"
                    title="Ir a este momento"
                    onClick={() => saltarA(m.segundo)}
                  >
                    {formatearDuracion(m.segundo)}
                  </button>
                  <input
                    value={m.nota}
                    placeholder="Nota (opcional)"
                    maxLength={200}
                    onChange={(e) =>
                      void guardar({
                        marcas: grabacion.marcas.map((x) =>
                          x.id === m.id ? { ...x, nota: e.target.value } : x,
                        ),
                      })
                    }
                  />
                  <button
                    className="btn-icono peligro"
                    title="Quitar marca"
                    onClick={() =>
                      void guardar({
                        marcas: grabacion.marcas.filter((x) => x.id !== m.id),
                      })
                    }
                  >
                    <Icono nombre="basura" tamano={15} />
                  </button>
                </li>
              ))}
          </ul>
        )}
      </div>

      <ListaMateriales
        titulo="Material de esta grabación"
        materiales={materiales.propios}
        vacio="Sin material propio. Puedes agregar la foto del pizarrón o el apunte de esta clase puntual."
        destino={{
          carpetaRaiz: raizDeClase(datos.grabaciones, grabacion.claseId, config.carpetaRaiz),
          claseNombre: grabacion.claseNombre,
          unidadNombre: grabacion.unidadNombre,
          claseId: null,
          unidadId: null,
          grabacionId: grabacion.id,
        }}
      />

      {/* Heredado: se ve acá pero se administra desde la pestaña Clases. */}
      <ListaMateriales
        titulo={`De la unidad ${grabacion.unidadNombre}`}
        materiales={materiales.unidad}
      />
      <ListaMateriales
        titulo={`De ${grabacion.claseNombre}`}
        materiales={materiales.clase}
      />

      <VistaTranscripcion
        grabacion={grabacion}
        resaltar={resaltar}
        onSaltar={saltarA}
        onExportar={exportar}
      />

      <div className="acciones-detalle">
        <button
          className="btn"
          disabled={ocupado}
          onClick={() => void revealItemInDir(grabacion.archivoAudio)}
        >
          <Icono nombre="carpeta" tamano={16} /> Abrir carpeta
        </button>
        <button
          className="btn"
          disabled={bloqueadoPorArchivos || convirtiendo}
          title={
            transcribiendo
              ? "No se puede recortar mientras se transcribe"
              : convirtiendo
                ? "Espera a que termine de convertirse el audio"
                : undefined
          }
          onClick={() => setRecortando(true)}
        >
          <Icono nombre="tijera" tamano={16} /> Recortar audio
        </button>
        <button
          className="btn btn-peligro"
          disabled={bloqueadoPorArchivos}
          title={
            transcribiendo ? "No se puede eliminar mientras se transcribe" : undefined
          }
          onClick={() => setConfirmandoBorrado(true)}
        >
          <Icono nombre="basura" tamano={16} /> Eliminar
        </button>
      </div>

      {recortando && (
        <RecortarAudio
          grabacion={grabacion}
          onCancelar={() => setRecortando(false)}
          onListo={alTerminarRecorte}
        />
      )}

      <ModalConfirmacion
        abierto={confirmandoBorrado}
        titulo="Eliminar grabación"
        peligroso
        textoConfirmar="Borrar también los archivos"
        mensaje={
          <>
            <p>
              <strong>{grabacion.titulo}</strong> ·{" "}
              {formatearDuracion(grabacion.duracionSeg)} ·{" "}
              {formatearBytes(grabacion.bytes)}
            </p>
            <p className="sutil">
              «Quitar de la biblioteca» la saca de la app pero deja el audio, la
              transcripción y la metadata en <code>{grabacion.carpeta}</code>.
            </p>
            <button
              className="btn"
              style={{ marginTop: 8 }}
              onClick={() => eliminar(false)}
            >
              Quitar de la biblioteca
            </button>
          </>
        }
        onConfirmar={() => eliminar(true)}
        onCancelar={() => setConfirmandoBorrado(false)}
      />
    </div>
  );
}
