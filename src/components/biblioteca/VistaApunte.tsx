/**
 * Un apunte digitalizado, para leerlo.
 *
 * Es el equivalente de `DetalleGrabacion` para el papel: ocupa la columna de
 * detalle de la Biblioteca y sirve para lo mismo que abrir una grabación —
 * mirar la hoja, leer lo que dice, anotar de qué se trata.
 *
 * Deliberadamente no deja corregir el texto, mover páginas ni borrar nada: eso
 * es trabajo de taller y vive en la pestaña Digitalizar. Acá está el botón que
 * lleva justo a eso, para no tener que ir a buscar el apunte de nuevo.
 *
 * El lector copia lo que hacen bien los visualizadores de documentos:
 *
 *  - **Ajustar al ancho, no al alto.** Es lo que decide si se lee o no. La
 *    letra se sigue línea por línea y el desborde vertical se resuelve con
 *    scroll, que es gratis; ajustar al alto es justo lo que deja la hoja del
 *    tamaño de una estampilla.
 *  - **Pasos de zoom con nombre** en vez de un control continuo: nadie calibra
 *    porcentajes, uno quiere "más grande".
 *  - **El zoom se recuerda.** Quien lee al 150% quiere seguir al 150% en la
 *    hoja siguiente y en el apunte siguiente.
 *  - **El scroll pasa dentro del lector**, no en la página: los controles no se
 *    van de la pantalla al acercarse.
 *  - **Modo lectura**: la hoja se queda con todo el ancho y el árbol se aparta.
 *    Ningún lector deja media pantalla ocupada por la lista mientras leés.
 *  - **Papel sobre fondo oscuro**, que es lo que ancla el ojo al borde de la
 *    hoja.
 *
 * Encima de eso se puede marcar la hoja al repasar. Destacar y anotar son el
 * mismo gesto —arrastrar un rectángulo— y se diferencian solo en si además se
 * escribe algo: el destacado se ve, la anotación además salta al pasarle el
 * mouse por encima. Ver `lib/marcasHoja.ts`.
 */
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { useStore } from "../../estado/store";
import { progresoReconocimiento } from "../../lib/apuntes";
import { exportarApunte } from "../../lib/exportarApunte";
import { formatearBytes, formatearFechaLarga } from "../../lib/format";
import {
  agregarMarca,
  cuentaDeMarcas,
  editarNotaDeMarca,
  quitarMarca,
  rectanguloNormalizado,
  type Arrastre,
} from "../../lib/marcasHoja";
import type { Apunte, MarcaHoja, PaginaApunte } from "../../types";
import { Icono } from "../ui/Icono";

/** "ajustar" = al ancho del lector. Los números son fracción del tamaño real. */
type Zoom = "ajustar" | number;

const PASOS = [0.35, 0.5, 0.75, 1, 1.5, 2, 3];
const CLAVE_ZOOM = "apuntes:zoom-lectura";

/** null = leyendo, sin dibujar nada. */
type Modo = null | "destacar" | "anotar";

function zoomGuardado(): Zoom {
  const guardado = localStorage.getItem(CLAVE_ZOOM);
  if (!guardado || guardado === "ajustar") return "ajustar";
  const n = Number(guardado);
  return Number.isFinite(n) && n > 0 ? n : "ajustar";
}

interface Props {
  apunte: Apunte;
  /** true = la lista se apartó y la hoja tiene todo el ancho. */
  lectura: boolean;
  onAlternarLectura(): void;
  /** Lleva el apunte a la pestaña Digitalizar, ya abierto en el editor. */
  onCorregir?(apunteId: string): void;
}

export function VistaApunte({ apunte, lectura, onAlternarLectura, onCorregir }: Props) {
  const { actualizarApunte } = useStore();
  const [activa, setActiva] = useState(0);
  const [ampliada, setAmpliada] = useState(false);
  const [nota, setNota] = useState(apunte.nota ?? "");
  const [zoom, setZoom] = useState<Zoom>(zoomGuardado);
  const [modo, setModo] = useState<Modo>(null);
  const [trazo, setTrazo] = useState<Arrastre | null>(null);
  /** Marca recién dibujada en modo anotar, esperando que se escriba la nota. */
  const [redactando, setRedactando] = useState<MarcaHoja | null>(null);
  const [borrador, setBorrador] = useState("");
  const hojaRef = useRef<HTMLImageElement>(null);
  const lienzoRef = useRef<HTMLDivElement>(null);

  const paginas = [...apunte.paginas].sort((a, b) => a.numero - b.numero);
  const pagina = paginas[activa];
  const progreso = progresoReconocimiento(apunte);

  useEffect(() => {
    setActiva(0);
    setNota(apunte.nota ?? "");
  }, [apunte.id, apunte.nota]);

  // Cambiar de hoja con un rectángulo a medio dibujar dejaría el trazo colgado
  // encima de la hoja siguiente.
  useEffect(() => {
    setTrazo(null);
    setRedactando(null);
  }, [activa, apunte.id]);

  const aplicarZoom = (z: Zoom) => {
    setZoom(z);
    localStorage.setItem(CLAVE_ZOOM, String(z));
  };

  /**
   * En "ajustar" el factor no se sabe de antemano: depende del ancho que le
   * quedó al lector. Se mide sobre la imagen ya renderizada, así el primer
   * paso de zoom sale del tamaño que el usuario está viendo y no de un número
   * inventado.
   */
  const escalonar = (direccion: 1 | -1) => {
    const actual =
      typeof zoom === "number"
        ? zoom
        : hojaRef.current && pagina?.ancho
          ? hojaRef.current.clientWidth / pagina.ancho
          : 1;
    const siguiente =
      direccion === 1
        ? PASOS.find((p) => p > actual + 0.01)
        : [...PASOS].reverse().find((p) => p < actual - 0.01);
    if (siguiente) aplicarZoom(siguiente);
  };

  const etiquetaZoom = zoom === "ajustar" ? "Ajustar" : `${Math.round(zoom * 100)}%`;

  const marcas: MarcaHoja[] = pagina?.marcas ?? [];

  const guardarPaginas = (paginasNuevas: PaginaApunte[]) =>
    actualizarApunte(apunte.id, { paginas: paginasNuevas });

  /** Coordenadas del puntero relativas a la hoja renderizada, en píxeles. */
  const puntoEnHoja = (e: { clientX: number; clientY: number }) => {
    const caja = lienzoRef.current?.getBoundingClientRect();
    if (!caja) return null;
    return { x: e.clientX - caja.left, y: e.clientY - caja.top };
  };

  const empezarTrazo = (e: PointerEvent) => {
    if (!modo || e.button !== 0) return;
    const p = puntoEnHoja(e);
    if (!p) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setTrazo({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };

  const seguirTrazo = (e: PointerEvent) => {
    if (!trazo) return;
    const p = puntoEnHoja(e);
    if (!p) return;
    setTrazo({ ...trazo, x1: p.x, y1: p.y });
  };

  const soltarTrazo = () => {
    if (!trazo || !pagina) return;
    const caja = lienzoRef.current?.getBoundingClientRect();
    setTrazo(null);
    const rect = rectanguloNormalizado(trazo, caja?.width ?? 0, caja?.height ?? 0);
    // Un click suelto no deja nada: `rectanguloNormalizado` descarta lo diminuto.
    if (!rect) return;

    const marca: MarcaHoja = { id: crypto.randomUUID(), ...rect, nota: "", creadaEn: new Date().toISOString() };
    void guardarPaginas(agregarMarca(apunte.paginas, pagina.id, marca));
    if (modo === "anotar") {
      setRedactando(marca);
      setBorrador("");
    }
  };

  const guardarNota = () => {
    if (!redactando || !pagina) return;
    const texto = borrador.trim();
    // Anotar y arrepentirse deja el destacado, no un rectángulo con nota vacía
    // que después nadie sabe si era una cosa o la otra: son lo mismo.
    void guardarPaginas(editarNotaDeMarca(apunte.paginas, pagina.id, redactando.id, texto));
    setRedactando(null);
  };

  const borrarMarca = (marcaId: string) => {
    if (!pagina) return;
    if (redactando?.id === marcaId) setRedactando(null);
    void guardarPaginas(quitarMarca(apunte.paginas, pagina.id, marcaId));
  };

  const alternarModo = (cual: Exclude<Modo, null>) => {
    setModo((m) => (m === cual ? null : cual));
    setRedactando(null);
  };

  return (
    <div className="vista-apunte">
      <div className="detalle-titulo">
        <h3>
          <Icono nombre="apunte" tamano={16} /> {apunte.titulo}
        </h3>
      </div>
      <p className="sutil">
        {apunte.claseNombre} › {apunte.unidadNombre} · {formatearFechaLarga(apunte.fechaISO)} ·{" "}
        {paginas.length} {paginas.length === 1 ? "página" : "páginas"} ·{" "}
        {formatearBytes(paginas.reduce((t, p) => t + p.bytes, 0))}
      </p>

      <div className="acciones-fila">
        <button className="btn" onClick={() => void exportarApunte(apunte, "pdf")}>
          Exportar PDF
        </button>
        <button
          className="btn-icono"
          title="Abrir la carpeta del apunte"
          onClick={() => void revealItemInDir(apunte.carpeta)}
        >
          <Icono nombre="carpeta" />
        </button>
        {onCorregir && (
          <button className="btn btn-primario" onClick={() => onCorregir(apunte.id)}>
            <Icono nombre="lapiz" />
            Corregir en Digitalizar
          </button>
        )}
      </div>

      {paginas.length === 0 ? (
        <p className="vacio">Este apunte se quedó sin páginas.</p>
      ) : (
        <div className={`apunte-cuerpo ${lectura ? "apunte-cuerpo-ancho" : ""}`}>
          <aside className="tira-paginas">
            {paginas.map((p, i) => (
              <button
                key={p.id}
                className={`miniatura ${i === activa ? "elegida" : ""}`}
                onClick={() => setActiva(i)}
                title={`Página ${p.numero}`}
              >
                <img src={convertFileSrc(p.archivo)} alt={`Página ${p.numero}`} loading="lazy" />
                {/* Sin esto no habría forma de saber en qué hoja quedó algo
                    marcado sin recorrerlas todas de nuevo. */}
                <small>
                  {p.numero}
                  {cuentaDeMarcas(p) > 0 && (
                    <span className="cuenta" title="Marcas en esta hoja">
                      {cuentaDeMarcas(p)}
                    </span>
                  )}
                </small>
              </button>
            ))}
          </aside>

          {pagina && (
            <div className="lector">
              <div className="lector-barra">
                <div className="lector-paginacion">
                  <button
                    className="btn-icono"
                    title="Página anterior"
                    onClick={() => setActiva((i) => i - 1)}
                    disabled={activa === 0}
                  >
                    ←
                  </button>
                  <span className="sutil">
                    {pagina.numero} / {paginas.length}
                  </span>
                  <button
                    className="btn-icono"
                    title="Página siguiente"
                    onClick={() => setActiva((i) => i + 1)}
                    disabled={activa === paginas.length - 1}
                  >
                    →
                  </button>
                </div>

                <div className="lector-zoom">
                  <button
                    className="btn-icono"
                    title="Alejar"
                    onClick={() => escalonar(-1)}
                    disabled={typeof zoom === "number" && zoom <= PASOS[0]}
                  >
                    −
                  </button>
                  <button
                    className="btn btn-mini"
                    title="Volver a ajustar la hoja al ancho del lector"
                    onClick={() => aplicarZoom("ajustar")}
                  >
                    {etiquetaZoom}
                  </button>
                  <button
                    className="btn-icono"
                    title="Acercar"
                    onClick={() => escalonar(1)}
                    disabled={typeof zoom === "number" && zoom >= PASOS[PASOS.length - 1]}
                  >
                    +
                  </button>
                  <button
                    className="btn-icono"
                    title={lectura ? "Volver a mostrar la lista" : "Leer con todo el ancho"}
                    onClick={onAlternarLectura}
                  >
                    <Icono nombre={lectura ? "equis" : "abrir"} />
                  </button>
                  <button
                    className="btn-icono"
                    title="Ver la hoja a pantalla completa"
                    onClick={() => setAmpliada(true)}
                  >
                    <Icono nombre="lupa" />
                  </button>
                </div>

                <div className="lector-marcado">
                  <button
                    className={`btn btn-mini ${modo === "destacar" ? "activo" : ""}`}
                    title="Arrastrar sobre la hoja para destacar un pedazo"
                    onClick={() => alternarModo("destacar")}
                  >
                    Destacar
                  </button>
                  <button
                    className={`btn btn-mini ${modo === "anotar" ? "activo" : ""}`}
                    title="Arrastrar sobre la hoja y escribir una nota que salte al pasar por encima"
                    onClick={() => alternarModo("anotar")}
                  >
                    Anotar
                  </button>
                  {marcas.length > 0 && (
                    <span className="cuenta" title="Marcas en esta hoja">
                      {marcas.length}
                    </span>
                  )}
                </div>
              </div>

              <div className="lector-hoja">
                {/* El lienzo se ajusta a la imagen, no al contenedor: las marcas
                    se posicionan en porcentaje sobre él y así siguen a la hoja
                    con cualquier zoom, sin recalcular ni una coordenada. */}
                <div
                  ref={lienzoRef}
                  className={`lector-lienzo ${modo ? "marcando" : ""}`}
                  style={
                    zoom === "ajustar"
                      ? { width: "100%" }
                      : { width: `${Math.round(pagina.ancho * zoom)}px` }
                  }
                  onPointerDown={empezarTrazo}
                  onPointerMove={seguirTrazo}
                  onPointerUp={soltarTrazo}
                  onPointerCancel={() => setTrazo(null)}
                >
                  <img
                    ref={hojaRef}
                    src={convertFileSrc(pagina.archivo)}
                    alt={`Página ${pagina.numero}`}
                    title={modo ? undefined : "Click para verla a pantalla completa"}
                    draggable={false}
                    onClick={() => {
                      if (!modo) setAmpliada(true);
                    }}
                  />

                  {marcas.map((m) => (
                    <div
                      key={m.id}
                      className={`marca-hoja ${m.nota ? "marca-hoja-con-nota" : ""}`}
                      style={{
                        left: `${m.x * 100}%`,
                        top: `${m.y * 100}%`,
                        width: `${m.ancho * 100}%`,
                        height: `${m.alto * 100}%`,
                      }}
                    >
                      {/* Al pasar por encima: la nota si la tiene, y siempre la
                          forma de borrarla. Sin esto una marca mal puesta no
                          habría manera de sacarla. */}
                      <span className="marca-hoja-globo">
                        {m.nota && <span className="marca-hoja-texto">{m.nota}</span>}
                        <button
                          className="marca-hoja-borrar"
                          title="Quitar esta marca"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            borrarMarca(m.id);
                          }}
                        >
                          <Icono nombre="equis" tamano={12} />
                        </button>
                      </span>
                    </div>
                  ))}

                  {trazo && (
                    <div
                      className="marca-hoja marca-hoja-trazo"
                      style={{
                        left: Math.min(trazo.x0, trazo.x1),
                        top: Math.min(trazo.y0, trazo.y1),
                        width: Math.abs(trazo.x1 - trazo.x0),
                        height: Math.abs(trazo.y1 - trazo.y0),
                      }}
                    />
                  )}
                </div>
              </div>

              {redactando && (
                <div className="marca-hoja-editor">
                  <textarea
                    autoFocus
                    className="area-nota"
                    value={borrador}
                    placeholder="Qué anotar de este pedazo de la hoja…"
                    onChange={(e) => setBorrador(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setRedactando(null);
                      // Enter guarda; Shift+Enter deja escribir varias líneas.
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        guardarNota();
                      }
                    }}
                  />
                  <div className="acciones-fila">
                    <span className="sutil">
                      Sin texto queda como destacado. Enter guarda, Esc cierra.
                    </span>
                    <button className="btn" onClick={() => borrarMarca(redactando.id)}>
                      Descartar
                    </button>
                    <button className="btn btn-primario" onClick={guardarNota}>
                      Guardar la nota
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <h4 className="titulo-seccion">Nota</h4>
      <textarea
        className="area-nota"
        value={nota}
        placeholder="De qué clase salió, qué falta, qué revisar…"
        onChange={(e) => setNota(e.target.value)}
        onBlur={() => {
          if (nota === (apunte.nota ?? "")) return;
          void actualizarApunte(apunte.id, { nota });
        }}
      />

      {pagina && (
        <>
          <h4 className="titulo-seccion">
            Texto de la página {pagina.numero}
            {pagina.textoEditado && <span className="sutil"> · corregido a mano</span>}
          </h4>
          {pagina.texto ? (
            <p className="texto-apunte">{pagina.texto}</p>
          ) : (
            <p className="vacio">
              {progreso.hechas < progreso.total
                ? "Esta hoja todavía no pasó por el reconocimiento."
                : "Esta hoja no dio texto reconocible."}
            </p>
          )}
        </>
      )}

      {ampliada && pagina && (
        <div className="hoja-zoom" onClick={() => setAmpliada(false)}>
          <img src={convertFileSrc(pagina.archivo)} alt={`Página ${pagina.numero}`} />
        </div>
      )}
    </div>
  );
}
