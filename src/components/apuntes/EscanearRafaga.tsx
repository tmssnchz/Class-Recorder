/**
 * Modo ráfaga: se recorre una tanda de fotos de a una — confirmar el recorte,
 * siguiente — sin volver al menú entre hoja y hoja.
 *
 * Es el patrón que uno espera al escanear un cuaderno entero: lo que se hace
 * cuarenta veces seguidas tiene que costar un click, no cinco.
 *
 * Una misma tanda puede repartirse en más de un apunte ("bloques"): sirve para
 * digitalizar un cuaderno viejo con hojas de varios ramos mezcladas, sin
 * obligar a hacer una tanda de una sola foto por cada ramo. Cada foto elige su
 * destino (clase/unidad) y se junta con el último bloque que tenga ese mismo
 * destino; "Nuevo apunte" fuerza uno nuevo aunque el destino se repita.
 */
import { useCallback, useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { useStore } from "../../estado/store";
import {
  analizarFoto,
  carpetaApunte,
  carpetaLibre,
  digitalizarFoto,
  ordenarPorMarcador,
  renumerar,
  type AnalisisFoto,
  type Esquina,
} from "../../lib/escaneo";
import { formatearBytes } from "../../lib/format";
import { nombreArchivo } from "../../lib/paths";
import { PAPELES } from "../../lib/plantilla";
import {
  SIN_CLASE,
  SIN_UNIDAD,
  type Apunte,
  type GeometriaPlantilla,
  type PaginaApunte,
} from "../../types";
import { Icono } from "../ui/Icono";
import { AjustarEsquinas } from "./AjustarEsquinas";

interface Props {
  /** Rutas de las fotos a procesar, en el orden en que se tomaron. */
  fotos: string[];
  claseId: string | null;
  unidadId: string | null;
  /**
   * Se llama con los apuntes ya armados — uno por cada bloque que haya
   * juntado al menos una página. Guardarlos es del que llama.
   */
  onTerminar(resultados: { apunte: Apunte; paginas: PaginaApunte[] }[]): void;
  onCancelar(): void;
  /** Se llama por cada foto ya digitalizada, para archivarla del Inbox. */
  onFotoUsada?(ruta: string): void;
}

/** Título por defecto de un bloque nuevo, a partir de su destino. */
function tituloDe(claseNombre: string, unidadNombre: string | null): string {
  const fecha = new Date().toISOString().slice(0, 10);
  return `Apunte ${fecha} - ${unidadNombre ?? claseNombre}`;
}

interface BloqueRafaga {
  /** Id interno del bloque dentro de esta sesión, no el id final del apunte. */
  clave: string;
  claseId: string | null;
  unidadId: string | null;
  titulo: string;
  /** null hasta que se confirma su primera página. */
  carpeta: string | null;
  paginas: PaginaApunte[];
  numerosPagina: Map<string, number | null>;
}

interface Pendiente {
  ruta: string;
  /** Motivo puntual por el que no se resolvió sola, para el repaso. */
  motivo: string;
}

export function EscanearRafaga({
  fotos,
  claseId,
  unidadId,
  onTerminar,
  onCancelar,
  onFotoUsada,
}: Props) {
  const { datos, config } = useStore();
  // `orden` es la lista que se está recorriendo. Arranca siendo todas las
  // fotos; al terminar, si quedaron pendientes, pasa a ser esa lista y se
  // recorre de nuevo pero ya sin confirmación automática.
  const [orden, setOrden] = useState<string[]>(fotos);
  const [pendientes, setPendientes] = useState<Pendiente[]>([]);
  // Copia de los motivos de la pasada anterior, para mostrarlos de entrada en
  // el repaso: sin esto, hay que volver a mirar hoja por hoja para saber por
  // qué había quedado ahí.
  const [resumenPendientes, setResumenPendientes] = useState<Pendiente[]>([]);
  const [repaso, setRepaso] = useState(false);
  const [indice, setIndice] = useState(0);
  const [analisis, setAnalisis] = useState<AnalisisFoto | null>(null);
  const [esquinas, setEsquinas] = useState<Esquina[]>([]);
  const [geometria, setGeometria] = useState<GeometriaPlantilla>(config.apuntes.plantilla);
  const [analizando, setAnalizando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Modo integración: fuerza revisar todas las hojas a mano en esta tanda,
  // sin tocar la config general (que sigue confirmando sola en un cuaderno
  // nuevo). Es de sesión, no se guarda.
  const [modoIntegracion, setModoIntegracion] = useState(false);

  // El número que trae el marcador se puede repetir entre lotes de plantilla
  // distintos (dos hojas "página 5" de tandas de impresión separadas): ahí
  // ordenar por ese número mezcla mal. Esta opción vuelve al orden en que se
  // sacaron las fotos, que es siempre correcto para un cuaderno escaneado en
  // el orden real de sus hojas.
  const [ignorarNumeros, setIgnorarNumeros] = useState(false);

  // Apuntes que va juntando esta tanda. Empieza con uno solo, con el destino
  // que traía la cola de fotos — el caso simple (cuaderno nuevo) nunca crea
  // un segundo bloque y termina igual que antes.
  const [bloques, setBloques] = useState<BloqueRafaga[]>(() => [
    { clave: crypto.randomUUID(), claseId, unidadId, titulo: "", carpeta: null, paginas: [], numerosPagina: new Map() },
  ]);
  // Destino elegido para la próxima foto. Por defecto, el de la última
  // elegida — así una racha de hojas del mismo ramo no obliga a re-elegir en
  // cada una.
  const [destino, setDestino] = useState<{ claseId: string | null; unidadId: string | null }>({
    claseId,
    unidadId,
  });
  const [formNuevo, setFormNuevo] = useState<{
    claseId: string | null;
    unidadId: string | null;
    titulo: string;
  } | null>(null);

  const fotoActual = orden[indice];
  const claseDeDestino = datos.clases.find((c) => c.id === destino.claseId) ?? null;

  // La confirmación automática solo corre en la primera pasada, sin modo
  // integración: en el repaso, o pidiendo revisión manual a propósito, el
  // usuario está justamente mirando las que dieron problema.
  const automatico = config.apuntes.confirmacionAutomatica && !repaso && !modoIntegracion;

  // Analiza la foto en cuanto se llega a ella: al confirmar la anterior, la
  // siguiente ya se está mirando sola.
  useEffect(() => {
    if (!fotoActual) return;
    let vigente = true;
    setAnalizando(true);
    setError(null);

    void (async () => {
      try {
        const a = await analizarFoto(fotoActual, config.apuntes.plantilla);
        if (!vigente) return;
        setAnalisis(a);
        setEsquinas(a.esquinas);
        // Con marcadores, el backend devuelve la geometría con la que recortó
        // —la configurada— y se adopta. Cuando no hay (detección por
        // contraste) se conserva el papel que el usuario haya elegido a mano
        // para esta tanda.
        if (a.geometria) setGeometria(a.geometria);
      } catch (e) {
        if (vigente) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (vigente) setAnalizando(false);
      }
    })();

    return () => {
      vigente = false;
    };
  }, [fotoActual, config.apuntes.plantilla]);

  // Una hoja "resuelta sola" es la que trae los cuatro marcadores leídos y
  // ningún aviso. Con un marcador estimado o una foto movida se para: son
  // justo los casos donde el recorte puede salir corrido.
  const resueltaSola =
    analisis !== null && analisis.fuente === "marcadores" && analisis.advertencias.length === 0;

  /** Motivo puntual por el que una hoja no se resolvió sola. */
  const motivoDe = useCallback((a: AnalisisFoto): string => {
    if (a.advertencias.length > 0) return a.advertencias[0];
    if (a.fuente === "contraste") {
      return "Sin marcadores: el borde se detectó por contraste. Revisa las esquinas.";
    }
    if (a.fuente === "ninguna") {
      return "No se encontró el borde de la hoja: hay que marcar las cuatro esquinas a mano.";
    }
    return "Revisar antes de confirmar.";
  }, []);

  const confirmar = useCallback(async () => {
    if (!analisis || !fotoActual) return;
    setGuardando(true);
    setError(null);

    try {
      // Se junta con el último bloque que tenga el mismo destino; si no hay
      // ninguno (o "Nuevo apunte" lo forzó), se crea uno.
      const existente = [...bloques]
        .reverse()
        .find((b) => b.claseId === destino.claseId && b.unidadId === destino.unidadId);
      const c = datos.clases.find((x) => x.id === destino.claseId) ?? null;
      const u = c?.unidades.find((x) => x.id === destino.unidadId) ?? null;
      const bloque: BloqueRafaga =
        existente ?? {
          clave: crypto.randomUUID(),
          claseId: destino.claseId,
          unidadId: destino.unidadId,
          titulo: tituloDe(c?.nombre ?? SIN_CLASE, u?.nombre ?? null),
          carpeta: null,
          paginas: [],
          numerosPagina: new Map(),
        };

      // La carpeta del bloque se crea recién con su primera hoja confirmada:
      // así cancelar antes de eso no deja una carpeta vacía en disco.
      const destinoCarpeta =
        bloque.carpeta ??
        (await carpetaLibre(
          carpetaApunte(config.carpetaRaiz, c?.nombre ?? SIN_CLASE, u?.nombre ?? null, bloque.titulo),
        ));

      const pagina = await digitalizarFoto(
        fotoActual,
        analisis,
        esquinas,
        geometria,
        { carpeta: destinoCarpeta, numero: bloque.paginas.length + 1 },
        config,
      );

      const clave = bloque.clave;
      setBloques((bs) => {
        const actualizado: BloqueRafaga = {
          ...bloque,
          carpeta: destinoCarpeta,
          paginas: [...bloque.paginas, pagina],
          numerosPagina: new Map(bloque.numerosPagina).set(pagina.id, analisis.pagina),
        };
        return bs.some((b) => b.clave === clave)
          ? bs.map((b) => (b.clave === clave ? actualizado : b))
          : [...bs, actualizado];
      });

      onFotoUsada?.(fotoActual);
      setIndice((i) => i + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGuardando(false);
    }
  }, [analisis, bloques, config, datos.clases, destino, esquinas, fotoActual, geometria, onFotoUsada]);

  const saltar = () => setIndice((i) => i + 1);

  /** La hoja no se pudo resolver sola: se deja para el repaso del final. */
  const dejarPendiente = useCallback(() => {
    if (!fotoActual) return;
    const motivo = analisis ? motivoDe(analisis) : "Sin analizar.";
    setPendientes((p) => (p.some((x) => x.ruta === fotoActual) ? p : [...p, { ruta: fotoActual, motivo }]));
    setIndice((i) => i + 1);
  }, [analisis, fotoActual, motivoDe]);

  // Confirmación automática: en cuanto el análisis dice que la hoja salió
  // limpia, se guarda y se pasa a la siguiente sin esperar un click. Lo que no
  // sale limpio no se descarta: va a la lista de pendientes y se revisa al
  // final, así una hoja con problemas no frena las otras treinta.
  useEffect(() => {
    if (!automatico || analizando || guardando || !analisis) return;
    if (resueltaSola) {
      void confirmar();
    } else {
      dejarPendiente();
    }
  }, [
    analisis,
    analizando,
    automatico,
    confirmar,
    dejarPendiente,
    guardando,
    resueltaSola,
  ]);

  // Terminada la tanda, se arma un apunte por cada bloque que juntó al menos
  // una página y se devuelven todos juntos.
  useEffect(() => {
    if (indice < orden.length) return;

    // Terminada la pasada, si algo quedó pendiente se recorre de nuevo esa
    // lista, ahora a mano.
    if (pendientes.length > 0) {
      setResumenPendientes(pendientes);
      setOrden(pendientes.map((p) => p.ruta));
      setPendientes([]);
      setRepaso(true);
      setIndice(0);
      return;
    }

    const listos = bloques.filter(
      (b): b is BloqueRafaga & { carpeta: string } => b.paginas.length > 0 && b.carpeta !== null,
    );
    if (listos.length === 0) return;

    onTerminar(
      listos.map((b) => {
        const c = datos.clases.find((x) => x.id === b.claseId) ?? null;
        const u = c?.unidades.find((x) => x.id === b.unidadId) ?? null;
        const paginas = ignorarNumeros ? renumerar(b.paginas) : ordenarPorMarcador(b.paginas, b.numerosPagina);
        const apunte: Apunte = {
          id: crypto.randomUUID(),
          titulo: b.titulo,
          claseId: c?.id ?? null,
          unidadId: u?.id ?? null,
          grabacionId: null,
          claseNombre: c?.nombre ?? SIN_CLASE,
          unidadNombre: u?.nombre ?? SIN_UNIDAD,
          carpeta: b.carpeta,
          fechaISO: new Date().toISOString(),
          paginas,
          idioma: config.apuntes.idioma,
          archivoTexto: "",
          tags: ["escaneado"],
          reemplazaA: null,
        };
        return { apunte, paginas };
      }),
    );
  }, [bloques, config.apuntes.idioma, datos.clases, ignorarNumeros, orden.length, pendientes, indice, onTerminar]);

  const abrirFormNuevo = () => {
    const c = claseDeDestino;
    const u = c?.unidades.find((x) => x.id === destino.unidadId) ?? null;
    setFormNuevo({
      claseId: destino.claseId,
      unidadId: destino.unidadId,
      titulo: tituloDe(c?.nombre ?? SIN_CLASE, u?.nombre ?? null),
    });
  };

  const confirmarFormNuevo = () => {
    if (!formNuevo) return;
    const nuevo: BloqueRafaga = {
      clave: crypto.randomUUID(),
      claseId: formNuevo.claseId,
      unidadId: formNuevo.unidadId,
      titulo: formNuevo.titulo.trim() || tituloDe(SIN_CLASE, null),
      carpeta: null,
      paginas: [],
      numerosPagina: new Map(),
    };
    // Va al final: el emparejamiento por destino toma siempre el último
    // bloque que coincida, así que las hojas siguientes de este mismo destino
    // van a caer acá y no en el bloque viejo, aunque el ramo se repita.
    setBloques((bs) => [...bs, nuevo]);
    setDestino({ claseId: formNuevo.claseId, unidadId: formNuevo.unidadId });
    setFormNuevo(null);
  };

  const totalPaginas = bloques.reduce((t, b) => t + b.paginas.length, 0);

  if (indice >= orden.length) {
    return (
      <div className="rafaga vacio">
        <p>{totalPaginas === 0 ? "No se digitalizó ninguna hoja." : "Listo: armando el apunte…"}</p>
      </div>
    );
  }

  return (
    <div className="rafaga">
      <div className="rafaga-cabecera">
        <strong>
          Hoja {indice + 1} de {orden.length}
          {repaso && <span className="sutil"> · repaso de pendientes</span>}
        </strong>
        <span className="sutil">
          {totalPaginas} {totalPaginas === 1 ? "página lista" : "páginas listas"}
          {bloques.filter((b) => b.paginas.length > 0).length > 1 &&
            ` en ${bloques.filter((b) => b.paginas.length > 0).length} apuntes`}
        </span>
        <label className="selector-fila" title="Ninguna hoja se confirma sola: se revisan todas a mano.">
          <input
            type="checkbox"
            checked={modoIntegracion}
            onChange={(e) => setModoIntegracion(e.target.checked)}
          />
          <span>Modo integración</span>
        </label>
        <label
          className="selector-fila"
          title="Usa el orden en que se sacaron las fotos en vez del número leído del marcador. Sirve cuando dos tandas de plantilla impresas por separado repiten números."
        >
          <input
            type="checkbox"
            checked={ignorarNumeros}
            onChange={(e) => setIgnorarNumeros(e.target.checked)}
          />
          <span>Ignorar números de página</span>
        </label>
        <button className="btn" onClick={onCancelar} disabled={guardando}>
          Cancelar
        </button>
      </div>

      {repaso && resumenPendientes.length > 0 && (
        <details className="tarjeta resumen-pendientes">
          <summary>{resumenPendientes.length} hojas para repasar — por qué quedaron pendientes</summary>
          <ul>
            {resumenPendientes.map((p) => (
              <li key={p.ruta}>
                <strong>{nombreArchivo(p.ruta)}:</strong> {p.motivo}
              </li>
            ))}
          </ul>
        </details>
      )}

      {error && (
        <div className="aviso aviso-error">
          <Icono nombre="alerta" />
          <span>{error}</span>
        </div>
      )}

      {analizando && (
        <>
          {/* La foto ya se conoce: mostrarla con una línea de barrido encima
              dice qué se está mirando, y no solo que algo está pasando. */}
          <div className="analizando">
            <img src={convertFileSrc(fotoActual)} alt="Analizando la hoja" />
            <span className="barrido" />
          </div>
          <div className="progreso progreso-indeterminado">
            <div className="progreso-valor" />
          </div>
          <p className="sutil">
            Buscando los marcadores y los bordes de la hoja… Una foto de 12 MP
            tarda unos segundos.
          </p>
        </>
      )}

      {!analizando && analisis && (
        <>
          <div className={`aviso ${analisis.fuente === "marcadores" ? "aviso-info" : "aviso-cambio-destino"}`}>
            <Icono nombre={analisis.fuente === "marcadores" ? "check" : "alerta"} />
            <span>
              {analisis.fuente === "marcadores" &&
                `Marcadores leídos: hoja ${analisis.pagina}. Recortada con el papel configurado (${analisis.geometria?.anchoMm} × ${analisis.geometria?.altoMm} mm).`}
              {analisis.fuente === "contraste" &&
                "Sin marcadores: los bordes se detectaron por contraste. Revisa las esquinas antes de confirmar."}
              {analisis.fuente === "ninguna" &&
                "No se encontró el borde de la hoja. Marca las cuatro esquinas a mano."}
            </span>
          </div>

          {analisis.advertencias.map((a) => (
            <div className="aviso aviso-error" key={a}>
              <Icono nombre="alerta" />
              <span>{a}</span>
            </div>
          ))}

          <AjustarEsquinas
            foto={analisis.vistaPrevia}
            anchoFoto={analisis.ancho}
            altoFoto={analisis.alto}
            esquinas={esquinas}
            onCambiar={setEsquinas}
          />

          <div className="destino-foto">
            <label className="selector-fila">
              <span>Clase</span>
              <select
                value={destino.claseId ?? ""}
                onChange={(e) => setDestino({ claseId: e.target.value || null, unidadId: null })}
              >
                <option value="">Sin clasificar</option>
                {datos.clases.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nombre}
                  </option>
                ))}
              </select>
            </label>
            <label className="selector-fila">
              <span>Unidad</span>
              <select
                value={destino.unidadId ?? ""}
                onChange={(e) => setDestino((d) => ({ ...d, unidadId: e.target.value || null }))}
                disabled={!claseDeDestino}
              >
                <option value="">Sin unidad</option>
                {claseDeDestino?.unidades.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.nombre}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn" onClick={abrirFormNuevo} disabled={guardando}>
              Nuevo apunte
            </button>
          </div>

          {formNuevo && (
            <div className="tarjeta destino-nuevo">
              <strong>Nuevo apunte para el resto de la tanda</strong>
              <label>
                <span>Clase</span>
                <select
                  value={formNuevo.claseId ?? ""}
                  onChange={(e) =>
                    setFormNuevo((f) => f && { ...f, claseId: e.target.value || null, unidadId: null })
                  }
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
                  value={formNuevo.unidadId ?? ""}
                  onChange={(e) => setFormNuevo((f) => f && { ...f, unidadId: e.target.value || null })}
                  disabled={!datos.clases.find((c) => c.id === formNuevo.claseId)}
                >
                  <option value="">Sin unidad</option>
                  {datos.clases
                    .find((c) => c.id === formNuevo.claseId)
                    ?.unidades.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.nombre}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                <span>Título</span>
                <input
                  value={formNuevo.titulo}
                  onChange={(e) => setFormNuevo((f) => f && { ...f, titulo: e.target.value })}
                />
              </label>
              <div className="acciones-fila">
                <button className="btn" onClick={() => setFormNuevo(null)}>
                  Cancelar
                </button>
                <button className="btn btn-primario" onClick={confirmarFormNuevo}>
                  Usar este apunte
                </button>
              </div>
            </div>
          )}

          <div className="rafaga-controles">
            {/* Sin marcadores no se sabe si la foto es de una hoja de la
                plantilla: lo elige el usuario y queda para las siguientes de
                la tanda. */}
            {analisis.fuente !== "marcadores" && (
              <label className="selector-fila">
                <span>Tamaño de papel</span>
                <select
                  value={`${geometria.anchoMm}x${geometria.altoMm}`}
                  onChange={(e) => {
                    const papel = PAPELES.find(
                      (p) => `${p.anchoMm}x${p.altoMm}` === e.target.value,
                    );
                    if (papel) {
                      setGeometria((g) => ({
                        ...g,
                        anchoMm: papel.anchoMm,
                        altoMm: papel.altoMm,
                      }));
                    }
                  }}
                >
                  {PAPELES.map((p) => (
                    <option key={p.id} value={`${p.anchoMm}x${p.altoMm}`}>
                      {p.nombre}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <button className="btn" onClick={() => setEsquinas(analisis.esquinas)}>
              Volver a la detección
            </button>
            <button className="btn" onClick={saltar} disabled={guardando}>
              Descartar esta foto
            </button>
            <button
              className="btn btn-primario"
              onClick={confirmar}
              disabled={guardando || formNuevo !== null}
            >
              {guardando ? "Recortando…" : "Confirmar y seguir"}
            </button>
          </div>

          <p className="sutil">
            El escaneo se guarda a {config.apuntes.dpiEscaneo} dpi
            {config.apuntes.modoEscaneo === "gris"
              ? ", en gris y sin sombras"
              : config.apuntes.modoEscaneo === "color"
                ? ", en color y sin sombras"
                : ", sin retoque"}
            .
            {totalPaginas > 0 &&
              ` Van ${formatearBytes(bloques.reduce((t, b) => t + b.paginas.reduce((s, p) => s + p.bytes, 0), 0))} en esta tanda.`}
          </p>
        </>
      )}
    </div>
  );
}
