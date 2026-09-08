/**
 * Editor de un apunte digitalizado: la hoja escaneada a la izquierda y el
 * texto reconocido, editable, a la derecha.
 *
 * El texto se muestra editable desde el primer momento a propósito. El
 * reconocimiento de manuscrita nunca es perfecto, y el patrón que funciona
 * (Notability, GoodNotes) es corregir dos palabras mirando la hoja al lado, no
 * confiar a ciegas ni descartar todo el reconocimiento porque falló una línea.
 */
import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { useApuntes, claveTarea } from "../../estado/apuntes";
import { useStore } from "../../estado/store";
import { moverPaginaAApunte, renumerar } from "../../lib/escaneo";
import { exportarApunte } from "../../lib/exportarApunte";
import { guardarTexto } from "../../lib/htr";
import { formatearBytes } from "../../lib/format";
import { buscarModeloHtr } from "../../lib/htrModelos";
import { borrarArchivosApunte, progresoReconocimiento, vigentes } from "../../lib/apuntes";
import type { Apunte, PaginaApunte } from "../../types";
import { Icono } from "../ui/Icono";

const ETIQUETA_ESTADO: Record<string, string> = {
  esperando: "en cola",
  cargando: "cargando el modelo…",
  leyendo: "leyendo la hoja…",
  listo: "listo",
  error: "error",
};

/**
 * El aviso sobre la calidad del reconocimiento sirve la primera vez, no en cada
 * hoja. Se descarta para siempre, y en localStorage y no en la config porque es
 * una preferencia de esta interfaz, no un dato del proyecto.
 */
const CLAVE_AVISO = "apuntes:aviso-reconocimiento-descartado";

interface Props {
  apunte: Apunte;
  onCerrar(): void;
}

export function EditorApunte({ apunte, onCerrar }: Props) {
  const { datos, actualizarApunte, quitarApunte } = useStore();
  const { tareas, encolar, reencolar, descartarError } = useApuntes();
  const [activa, setActiva] = useState(0);
  const [borrador, setBorrador] = useState("");
  const [nota, setNota] = useState(apunte.nota ?? "");
  const [ampliada, setAmpliada] = useState(false);
  const [avisoOculto, setAvisoOculto] = useState(
    () => localStorage.getItem(CLAVE_AVISO) === "1",
  );

  const paginas = [...apunte.paginas].sort((a, b) => a.numero - b.numero);
  const pagina: PaginaApunte | undefined = paginas[activa];
  const tarea = pagina ? tareas[claveTarea(apunte.id, pagina.id)] : undefined;
  const progreso = progresoReconocimiento(apunte);

  // Los otros apuntes vigentes, que son los destinos posibles de una hoja.
  const destinos = vigentes(datos.apuntes)
    .filter((a) => a.id !== apunte.id)
    .sort((a, b) => b.fechaISO.localeCompare(a.fechaISO));

  // El borrador se resincroniza cuando cambia la página o cuando el
  // reconocimiento termina y trae texto nuevo para la que se está mirando.
  useEffect(() => {
    setBorrador(pagina?.texto ?? "");
  }, [pagina?.id, pagina?.texto]);

  useEffect(() => {
    setNota(apunte.nota ?? "");
  }, [apunte.id, apunte.nota]);

  // Al borrar o mover la última hoja, la posición activa puede quedar fuera.
  useEffect(() => {
    if (activa >= paginas.length && paginas.length > 0) setActiva(paginas.length - 1);
  }, [activa, paginas.length]);

  const guardarPagina = async (cambios: Partial<PaginaApunte>) => {
    if (!pagina) return;
    const nuevas = apunte.paginas.map((p) => (p.id === pagina.id ? { ...p, ...cambios } : p));
    const actualizado = { ...apunte, paginas: nuevas };
    const archivoTexto = await guardarTexto(actualizado);
    await actualizarApunte(apunte.id, { paginas: nuevas, archivoTexto });
  };

  const mover = async (desde: number, hacia: number) => {
    if (hacia < 0 || hacia >= paginas.length) return;
    const copia = [...paginas];
    const [sacada] = copia.splice(desde, 1);
    copia.splice(hacia, 0, sacada);
    const renumeradas = renumerar(copia);
    const actualizado = { ...apunte, paginas: renumeradas };
    const archivoTexto = await guardarTexto(actualizado);
    await actualizarApunte(apunte.id, { paginas: renumeradas, archivoTexto });
    setActiva(hacia);
  };

  /**
   * Manda la hoja a otro apunte, con sus archivos. Si era la última, el apunte
   * de origen ya no tiene nada: se borra en vez de dejar una entrada vacía —es
   * también la forma de fusionar dos apuntes que salieron partidos.
   */
  const moverAOtroApunte = async (destinoId: string) => {
    if (!pagina) return;
    const destino = datos.apuntes.find((a) => a.id === destinoId);
    if (!destino) return;

    const repartidas = await moverPaginaAApunte(apunte, pagina.id, destino);
    const conDestino = { ...destino, paginas: repartidas.destino };
    await actualizarApunte(destino.id, {
      paginas: repartidas.destino,
      archivoTexto: await guardarTexto(conDestino),
    });

    if (repartidas.origen.length === 0) {
      await borrarArchivosApunte({ ...apunte, paginas: [] });
      await quitarApunte(apunte.id);
      onCerrar();
      return;
    }

    const conOrigen = { ...apunte, paginas: repartidas.origen };
    await actualizarApunte(apunte.id, {
      paginas: repartidas.origen,
      archivoTexto: await guardarTexto(conOrigen),
    });
    setActiva((i) => Math.min(i, repartidas.origen.length - 1));
  };

  const descartarAviso = () => {
    localStorage.setItem(CLAVE_AVISO, "1");
    setAvisoOculto(true);
  };

  return (
    <div className="editor-apunte">
      <div className="panel-cabecera">
        <div>
          <h3>{apunte.titulo}</h3>
          <p className="sutil">
            {apunte.claseNombre} › {apunte.unidadNombre} · {paginas.length}{" "}
            {paginas.length === 1 ? "página" : "páginas"} ·{" "}
            {formatearBytes(paginas.reduce((t, p) => t + p.bytes, 0))}
          </p>
        </div>
        <div className="acciones-fila">
          <button className="btn" onClick={() => void exportarApunte(apunte, "pdf")}>
            Exportar PDF
          </button>
          <button className="btn" onClick={() => void exportarApunte(apunte, "md")}>
            Markdown
          </button>
          {progreso.hechas < progreso.total && (
            <button className="btn" onClick={() => encolar(apunte)}>
              Reconocer todo el apunte ({progreso.total - progreso.hechas} hojas)
            </button>
          )}
          <button className="btn" onClick={onCerrar}>
            Cerrar
          </button>
        </div>
      </div>

      <textarea
        className="area-nota"
        value={nota}
        placeholder="Nota del apunte: de qué clase salió, qué falta, qué revisar…"
        onChange={(e) => setNota(e.target.value)}
        onBlur={() => {
          if (nota === (apunte.nota ?? "")) return;
          void actualizarApunte(apunte.id, { nota });
        }}
      />

      {!avisoOculto && (
        <p className="aviso aviso-info">
          <Icono nombre="alerta" />
          <span>
            El reconocimiento de letra manuscrita nunca sale perfecto. Lee el
            texto al lado de la hoja y corrige lo que haga falta: lo que quede
            acá es lo que va a encontrar la búsqueda de la biblioteca.
          </span>
          <button className="btn btn-mini" onClick={descartarAviso}>
            Entendido
          </button>
        </p>
      )}

      <div className="editor-cuerpo">
        <aside className="tira-paginas">
          {paginas.map((p, i) => (
            <button
              key={p.id}
              className={`miniatura ${i === activa ? "elegida" : ""}`}
              onClick={() => setActiva(i)}
              title={`Página ${p.numero}`}
            >
              <img src={convertFileSrc(p.archivo)} alt={`Página ${p.numero}`} loading="lazy" />
              <small>
                {p.numero}
                {p.soloVisual ? " · visual" : ""}
                {p.textoEditado ? " · corregida" : ""}
              </small>
            </button>
          ))}
        </aside>

        {pagina && (
          <>
            <div className="hoja">
              <img
                src={convertFileSrc(pagina.archivo)}
                alt={`Página ${pagina.numero}`}
                title="Click para verla a tamaño real"
                onClick={() => setAmpliada(true)}
              />
              <div className="acciones-fila">
                <button
                  className="btn"
                  onClick={() => void mover(activa, activa - 1)}
                  disabled={activa === 0}
                >
                  ← Antes
                </button>
                <button
                  className="btn"
                  onClick={() => void mover(activa, activa + 1)}
                  disabled={activa === paginas.length - 1}
                >
                  Después →
                </button>
                <button className="btn" onClick={() => setAmpliada(true)}>
                  <Icono nombre="lupa" />
                  Ampliar
                </button>
              </div>
              {destinos.length > 0 && (
                <label className="mover-hoja sutil">
                  Mover esta hoja a
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value) void moverAOtroApunte(e.target.value);
                    }}
                  >
                    <option value="">otro apunte…</option>
                    {destinos.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.titulo} ({a.paginas.length})
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            <div className="texto-reconocido">
              {pagina.advertencias.map((a) => (
                <div className="aviso aviso-cambio-destino" key={a}>
                  <Icono nombre="alerta" />
                  <span>{a}</span>
                </div>
              ))}

              {tarea && tarea.estado !== "error" && (
                <p className="sutil">Reconociendo: {ETIQUETA_ESTADO[tarea.estado] ?? tarea.estado}</p>
              )}
              {tarea?.estado === "error" && (
                <div className="aviso aviso-error">
                  <Icono nombre="alerta" />
                  <span>{tarea.error}</span>
                  <button className="btn" onClick={() => descartarError(tarea.id)}>
                    Descartar
                  </button>
                </div>
              )}

              <label className="selector-fila">
                <input
                  type="checkbox"
                  checked={pagina.soloVisual}
                  onChange={(e) => void guardarPagina({ soloVisual: e.target.checked })}
                />
                <span>
                  Esta hoja es sobre todo un diagrama o un dibujo
                  <small className="sutil">
                    {" "}
                    — se guarda como imagen y no se fuerza un texto reconocido.
                  </small>
                </span>
              </label>

              <textarea
                className="area-texto"
                value={borrador}
                placeholder={
                  pagina.motorHtr
                    ? "Esta hoja no dio texto reconocible."
                    : "Todavía sin reconocer. Usa el botón de arriba o escribe el texto a mano."
                }
                onChange={(e) => setBorrador(e.target.value)}
                onBlur={() => {
                  if (borrador === pagina.texto) return;
                  void guardarPagina({ texto: borrador, textoEditado: true });
                }}
              />

              <div className="acciones-fila">
                <span className="sutil">
                  {pagina.motorHtr
                    ? `Reconocido con ${
                        pagina.motorHtr === "api"
                          ? "API externa"
                          : buscarModeloHtr(pagina.motorHtr).etiqueta
                      }`
                    : "Sin reconocer"}
                  {pagina.textoEditado && " · corregido a mano"}
                </span>
                <button
                  className="btn btn-primario"
                  onClick={() => reencolar(apunte, pagina)}
                  disabled={!!tarea && tarea.estado !== "error"}
                  title={
                    pagina.textoEditado
                      ? "Pasa el modelo solo por esta hoja y reemplaza tu corrección"
                      : "Pasa el modelo solo por esta hoja"
                  }
                >
                  {pagina.motorHtr
                    ? "Reconocer esta hoja de nuevo"
                    : "Reconocer solo esta hoja"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* A tamaño real y con scroll: es lo que hace falta para leer la letra,
          y ajustarla a la ventana sería volver al tamaño que ya no se lee. */}
      {ampliada && pagina && (
        <div className="hoja-zoom" onClick={() => setAmpliada(false)}>
          <img src={convertFileSrc(pagina.archivo)} alt={`Página ${pagina.numero}`} />
        </div>
      )}
    </div>
  );
}
