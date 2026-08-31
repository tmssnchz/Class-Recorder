/**
 * Modo ráfaga: se recorre una tanda de fotos de a una — confirmar el recorte,
 * siguiente — sin volver al menú entre hoja y hoja.
 *
 * Es el patrón que uno espera al escanear un cuaderno entero: lo que se hace
 * cuarenta veces seguidas tiene que costar un click, no cinco.
 */
import { useCallback, useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { useStore } from "../../estado/store";
import {
  analizarFoto,
  carpetaApunte,
  carpetaLibre,
  digitalizarFoto,
  ordenarPorQr,
  type AnalisisFoto,
  type Esquina,
} from "../../lib/escaneo";
import { formatearBytes } from "../../lib/format";
import { PAPELES } from "../../lib/plantilla";
import { SIN_CLASE, SIN_UNIDAD, type Apunte, type GeometriaPlantilla, type PaginaApunte } from "../../types";
import { Icono } from "../ui/Icono";
import { AjustarEsquinas } from "./AjustarEsquinas";

interface Props {
  /** Rutas de las fotos a procesar, en el orden en que se tomaron. */
  fotos: string[];
  claseId: string | null;
  unidadId: string | null;
  /** Se llama con el apunte ya armado. Guardarlo es del que llama. */
  onTerminar(apunte: Apunte, paginas: PaginaApunte[]): void;
  onCancelar(): void;
  /** Se llama por cada foto ya digitalizada, para archivarla del Inbox. */
  onFotoUsada?(ruta: string): void;
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
  const [pendientes, setPendientes] = useState<string[]>([]);
  const [repaso, setRepaso] = useState(false);
  const [indice, setIndice] = useState(0);
  const [analisis, setAnalisis] = useState<AnalisisFoto | null>(null);
  const [esquinas, setEsquinas] = useState<Esquina[]>([]);
  const [geometria, setGeometria] = useState<GeometriaPlantilla>(config.apuntes.plantilla);
  const [paginas, setPaginas] = useState<PaginaApunte[]>([]);
  const [numerosQr, setNumerosQr] = useState<Map<string, number | null>>(new Map());
  const [analizando, setAnalizando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [carpeta, setCarpeta] = useState<string | null>(null);

  const clase = datos.clases.find((c) => c.id === claseId) ?? null;
  const unidad = clase?.unidades.find((u) => u.id === unidadId) ?? null;
  const fotoActual = orden[indice];

  // La confirmación automática solo corre en la primera pasada: en el repaso el
  // usuario está justamente mirando las que dieron problema.
  const automatico = config.apuntes.confirmacionAutomatica && !repaso;

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
        // La geometría que viene del QR gana sobre la configurada: si el
        // usuario imprimió A4 y tiene B5 en la config, manda la hoja.
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

  const tituloApunte = useCallback(() => {
    const fecha = new Date().toISOString().slice(0, 10);
    return `Apunte ${fecha} - ${unidad?.nombre ?? clase?.nombre ?? "sin clasificar"}`;
  }, [clase, unidad]);

  const confirmar = useCallback(async () => {
    if (!analisis || !fotoActual) return;
    setGuardando(true);
    setError(null);

    try {
      // La carpeta del apunte se crea recién con la primera hoja confirmada:
      // así cancelar en la primera foto no deja una carpeta vacía en disco.
      const destino =
        carpeta ??
        (await carpetaLibre(
          carpetaApunte(
            config.carpetaRaiz,
            clase?.nombre ?? SIN_CLASE,
            unidad?.nombre ?? null,
            tituloApunte(),
          ),
        ));
      if (!carpeta) setCarpeta(destino);

      const pagina = await digitalizarFoto(
        fotoActual,
        analisis,
        esquinas,
        geometria,
        { carpeta: destino, numero: paginas.length + 1 },
        config,
      );

      setPaginas((ps) => [...ps, pagina]);
      setNumerosQr((m) => new Map(m).set(pagina.id, analisis.pagina));
      onFotoUsada?.(fotoActual);
      setIndice((i) => i + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGuardando(false);
    }
  }, [analisis, carpeta, clase, config, esquinas, fotoActual, geometria, onFotoUsada, paginas.length, tituloApunte, unidad]);

  const saltar = () => setIndice((i) => i + 1);

  /** La hoja no se pudo resolver sola: se deja para el repaso del final. */
  const dejarPendiente = useCallback(() => {
    setPendientes((p) => (fotoActual && !p.includes(fotoActual) ? [...p, fotoActual] : p));
    setIndice((i) => i + 1);
  }, [fotoActual]);

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

  // Terminada la tanda, se arma el apunte y se devuelve.
  useEffect(() => {
    if (indice < orden.length) return;

    // Terminada la pasada, si algo quedó pendiente se recorre de nuevo esa
    // lista, ahora a mano.
    if (pendientes.length > 0) {
      setOrden(pendientes);
      setPendientes([]);
      setRepaso(true);
      setIndice(0);
      return;
    }
    if (paginas.length === 0 || !carpeta) return;

    const ordenadas = ordenarPorQr(paginas, numerosQr);
    onTerminar(
      {
        id: crypto.randomUUID(),
        titulo: tituloApunte(),
        claseId: clase?.id ?? null,
        unidadId: unidad?.id ?? null,
        grabacionId: null,
        claseNombre: clase?.nombre ?? SIN_CLASE,
        unidadNombre: unidad?.nombre ?? SIN_UNIDAD,
        carpeta,
        fechaISO: new Date().toISOString(),
        paginas: ordenadas,
        idioma: config.apuntes.idioma,
        archivoTexto: "",
        tags: ["escaneado"],
        reemplazaA: null,
      },
      ordenadas,
    );
  }, [
    carpeta,
    clase,
    config.apuntes.idioma,
    orden.length,
    pendientes,
    indice,
    numerosQr,
    onTerminar,
    paginas,
    tituloApunte,
    unidad,
  ]);

  if (indice >= orden.length) {
    return (
      <div className="rafaga vacio">
        <p>
          {paginas.length === 0
            ? "No se digitalizó ninguna hoja."
            : "Listo: armando el apunte…"}
        </p>
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
          {paginas.length} {paginas.length === 1 ? "página lista" : "páginas listas"}
        </span>
        <button className="btn" onClick={onCancelar} disabled={guardando}>
          Cancelar
        </button>
      </div>

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
                `Marcadores leídos: hoja ${analisis.pagina} de una plantilla de ${analisis.geometria?.anchoMm} × ${analisis.geometria?.altoMm} mm.`}
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

          <div className="rafaga-controles">
            {/* Sin QR no se puede saber el tamaño de papel mirando la foto:
                lo elige el usuario y queda para las siguientes de la tanda. */}
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
            <button className="btn btn-primario" onClick={confirmar} disabled={guardando}>
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
            {paginas.length > 0 &&
              ` Van ${formatearBytes(paginas.reduce((t, p) => t + p.bytes, 0))} en esta tanda.`}
          </p>
        </>
      )}
    </div>
  );
}
