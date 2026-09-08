/**
 * Generador de la plantilla imprimible con los cuatro marcadores ArUco.
 *
 * La plantilla es opcional: sin ella el escaneo funciona igual, detectando el
 * borde de la hoja por contraste. Con ella el recorte sale exacto y la app
 * sabe sola el tamaño de papel y el número de página.
 *
 * El flujo de impresión sin dúplex automático está partido en dos tandas con
 * un volteo en el medio, y ofrece una hoja de calibración antes del lote real:
 * si la impresora expulsa el papel al revés de lo esperado, mejor descubrirlo
 * con una hoja que con cuarenta.
 */
import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { openPath } from "@tauri-apps/plugin-opener";

import { useStore } from "../../estado/store";
import {
  aMm,
  desdeMm,
  generarHojaDePrueba,
  generarPlantilla,
  generarTanda,
  papelDe,
  planDuplexManual,
  problemaDeGeometria,
  problemaDeNumeracion,
  LADOS,
  PAPELES,
  PAPEL_PERSONALIZADO,
  UNIDADES,
  type Unidad,
} from "../../lib/plantilla";
import { Icono } from "../ui/Icono";

export function PlantillaImprimible() {
  const { config, actualizarConfig } = useStore();
  const g = config.apuntes.plantilla;

  // Solo afecta a lo que se teclea: la geometría se guarda siempre en
  // milímetros. No se persiste porque el papel se configura una vez y no se
  // vuelve a tocar.
  const [unidad, setUnidad] = useState<Unidad>("mm");
  const [hojas, setHojas] = useState(20);
  // Para continuar un lote anterior sin repetir números: dos hojas con el
  // mismo número confunden el orden al escanear (ver ordenarPorMarcador).
  const [desde, setDesde] = useState(1);
  const [duplex, setDuplex] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nota, setNota] = useState<string | null>(null);
  const [generando, setGenerando] = useState(false);

  const cambiar = (cambios: Partial<typeof g>) =>
    void actualizarConfig({ apuntes: { plantilla: { ...g, ...cambios } } });

  const guardar = async (nombre: string, hacer: () => Promise<Uint8Array> | Uint8Array) => {
    setError(null);
    setNota(null);
    setGenerando(true);
    try {
      const destino = await save({
        defaultPath: nombre,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!destino) return;
      await writeFile(destino, await hacer());
      // Se abre con el visor del sistema: desde ahí el usuario imprime con el
      // diálogo de su impresora, que es el que conoce sus bandejas.
      //
      // Que no se pueda abrir no invalida nada: el PDF ya está en disco. Se
      // avisa como nota y no como error, porque antes un fallo acá parecía
      // decir que la plantilla no se había generado.
      try {
        await openPath(destino);
      } catch (e) {
        console.warn("No se pudo abrir el PDF con el visor del sistema", e);
        setNota(`La plantilla se guardó en ${destino}, pero no se pudo abrir sola. Ábrela desde ahí.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerando(false);
    }
  };

  // null cuando el usuario escribió medidas propias. No cae al primer preset:
  // el selector no debe decir "B5 ISO" mientras se imprime otra cosa.
  const info = UNIDADES.find((u) => u.id === unidad) ?? UNIDADES[0];
  const papelActual = papelDe(g);
  const problema = problemaDeGeometria(g);
  // Cada hoja gasta dos números cuando se imprime por las dos caras.
  const problemaNumeros = problemaDeNumeracion(desde, duplex ? hojas * 2 : hojas);
  const noSePuede = problema !== null || problemaNumeros !== null;
  const plan = planDuplexManual(hojas * 2, config.apuntes.reversoEnOrdenInverso, desde);

  return (
    <div className="tarjeta">
      <h3>Plantilla imprimible</h3>
      <p className="sutil">
        Hojas con cuatro marcadores en las esquinas. No son obligatorias: sin
        ellas el escaneo detecta el borde del papel por contraste, que anda bien
        pero falla más seguido con fondos claros o poca luz.
      </p>

      {error && (
        <div className="aviso aviso-error">
          <Icono nombre="alerta" />
          <span>{error}</span>
        </div>
      )}

      {nota && (
        <div className="aviso aviso-info">
          <Icono nombre="check" />
          <span>{nota}</span>
        </div>
      )}

      <div className="selectores">
        <label>
          <span>Tamaño de papel</span>
          <select
            value={papelActual?.id ?? PAPEL_PERSONALIZADO}
            onChange={(e) => {
              const p = PAPELES.find((x) => x.id === e.target.value);
              if (p) cambiar({ anchoMm: p.anchoMm, altoMm: p.altoMm, margenAnilladoMm: p.anilladoMm });
            }}
          >
            {PAPELES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nombre}
              </option>
            ))}
            {/* No se elige: aparece solo cuando las medidas no son de ningún
                preset. Para llegar acá se escriben el ancho y el alto. */}
            <option value={PAPEL_PERSONALIZADO} disabled>
              Personalizado ({g.anchoMm} × {g.altoMm} mm)
            </option>
          </select>
        </label>

        <label>
          <span>Unidad</span>
          <select value={unidad} onChange={(e) => setUnidad(e.target.value as Unidad)}>
            {UNIDADES.map((u) => (
              <option key={u.id} value={u.id}>
                {u.nombre}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Ancho</span>
          <input
            type="number"
            step={info.paso}
            min={desdeMm(80, unidad)}
            max={desdeMm(420, unidad)}
            value={desdeMm(g.anchoMm, unidad)}
            onChange={(e) => cambiar({ anchoMm: aMm(Number(e.target.value) || 0, unidad) })}
          />
        </label>

        <label>
          <span>Alto</span>
          <input
            type="number"
            step={info.paso}
            min={desdeMm(80, unidad)}
            max={desdeMm(594, unidad)}
            value={desdeMm(g.altoMm, unidad)}
            onChange={(e) => cambiar({ altoMm: aMm(Number(e.target.value) || 0, unidad) })}
          />
        </label>

        <label>
          <span>Lado del anillado</span>
          <select
            value={g.ladoAnillado}
            onChange={(e) => cambiar({ ladoAnillado: e.target.value as typeof g.ladoAnillado })}
          >
            {LADOS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.nombre}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Margen del anillado</span>
          <input
            type="number"
            step={info.paso}
            min={0}
            max={desdeMm(40, unidad)}
            value={desdeMm(g.margenAnilladoMm, unidad)}
            onChange={(e) =>
              cambiar({ margenAnilladoMm: aMm(Number(e.target.value) || 0, unidad) })
            }
          />
        </label>

        <label>
          <span>Hojas</span>
          <input
            type="number"
            min={1}
            max={200}
            value={hojas}
            onChange={(e) => setHojas(Math.max(1, Number(e.target.value) || 1))}
          />
        </label>

        <label>
          <span>Empezar en la página</span>
          <input
            type="number"
            min={1}
            value={desde}
            onChange={(e) => setDesde(Math.max(1, Number(e.target.value) || 1))}
          />
        </label>
      </div>

      {desde > 1 && (
        <p className="sutil">
          Va a continuar desde la página {desde}: para un lote que ya imprimió
          hasta la página {desde - 1}, sin repetir números.
        </p>
      )}

      <p className="sutil">
        En ese margen no se imprime nada, así que los cuatro marcadores no
        forman un rectángulo simétrico. Es a propósito: la app usa las cuatro
        posiciones reales para corregir la perspectiva.
      </p>

      <p className="sutil">
        Mide tu hoja con una regla y escribe el ancho y el alto exactos, en la
        unidad que te quede cómoda. Muchos recambios de binder que se venden
        como "B5" no lo son: 173 × 250 mm es de los más comunes y no coincide ni
        con el B5 ISO ni con el JIS. Adentro todo se guarda en milímetros:{" "}
        <strong>
          {g.anchoMm} × {g.altoMm} mm
        </strong>
        . La hoja no lleva su tamaño impreso: al escanear se usa siempre el
        papel que esté configurado acá, así que si lo cambias, las hojas ya
        impresas se van a recortar con las medidas nuevas.
      </p>

      {problema && (
        <div className="aviso aviso-error">
          <Icono nombre="alerta" />
          <span>{problema}</span>
        </div>
      )}

      {problemaNumeros && (
        <div className="aviso aviso-error">
          <Icono nombre="alerta" />
          <span>{problemaNumeros}</span>
        </div>
      )}

      <div className="aviso aviso-info">
        <Icono nombre="alerta" />
        <span>
          Antes de imprimir el lote completo: imprime esta hoja sola primero, y
          mide una hoja real y ya usada del cuaderno con una regla contra{" "}
          <strong>
            {g.anchoMm} × {g.altoMm} mm
          </strong>{" "}
          de la config. Una hoja vieja puede tener el borde desgastado por el
          anillado o no calzar exacto, y eso no tiene arreglo después de
          imprimir cuarenta.
        </span>
      </div>
      {/* Siempre imprime la página 1, así que el tope de numeración no le
          aplica: solo la frena una geometría impracticable. */}
      <button
        className="btn"
        disabled={generando || problema !== null}
        onClick={() =>
          void guardar("prueba-calibracion-1hoja.pdf", () =>
            generarPlantilla(g, 1, config.apuntes.numeroDePagina),
          )
        }
      >
        <Icono nombre="imprimir" />
        Hoja de prueba (calibración, 1 sola)
      </button>

      <label className="selector-fila">
        <input
          type="checkbox"
          checked={config.apuntes.numeroDePagina}
          onChange={(e) => void actualizarConfig({ apuntes: { numeroDePagina: e.target.checked } })}
        />
        <span>
          Imprimir el número de página (solo el texto visible; no afecta a los
          marcadores)
        </span>
      </label>

      <label className="selector-fila">
        <input type="checkbox" checked={duplex} onChange={(e) => setDuplex(e.target.checked)} />
        <span>Imprimir por las dos caras con una impresora sin dúplex automático</span>
      </label>

      {!duplex && (
        <button
          className="btn btn-primario"
          disabled={generando || noSePuede}
          onClick={() =>
            void guardar(`plantilla-${papelActual?.id ?? "personalizado"}-${hojas}hojas.pdf`, () =>
              generarPlantilla(g, hojas, config.apuntes.numeroDePagina, desde),
            )
          }
        >
          <Icono nombre="imprimir" />
          Generar PDF de {hojas} {hojas === 1 ? "hoja" : "hojas"}
        </button>
      )}

      {duplex && (
        <div className="pasos-duplex">
          <p className="sutil">
            {hojas} hojas físicas = {hojas * 2} páginas numeradas. Se imprime en
            dos pasadas.
          </p>

          <div className="aviso aviso-info">
            <Icono nombre="check" />
            <span>
              El reverso lleva el margen del anillado en el borde{" "}
              <strong>
                {g.ladoAnillado === "izquierda"
                  ? "derecho"
                  : g.ladoAnillado === "derecha"
                    ? "izquierdo"
                    : "superior"}
              </strong>
              : los agujeros están en el papel, así que al dar vuelta la hoja
              cambian de lado. Se hace solo, no hay que configurar nada.
            </span>
          </div>

          <ol>
            <li>
              <button
                className="btn"
                disabled={generando || noSePuede}
                onClick={() =>
                  void guardar("prueba-cara-A-y-B.pdf", () => generarHojaDePrueba(g))
                }
              >
                Hoja de prueba (una sola vez)
              </button>
              <span className="sutil">
                {" "}
                Tiene una “A” grande de un lado y una “B” del otro. Sirve para
                saber si esta impresora expulsa el papel boca arriba o boca
                abajo, que cambia de un modelo a otro.
              </span>
            </li>

            <li>
              <button
                className="btn btn-primario"
                disabled={generando || noSePuede}
                onClick={() =>
                  void guardar(`plantilla-frente-${hojas}hojas.pdf`, () =>
                    generarTanda(g, plan.frente, config.apuntes.numeroDePagina),
                  )
                }
              >
                1. Imprimir el frente ({plan.frente.length} páginas)
              </button>
            </li>

            <li>
              Da vuelta la pila entera y vuelve a ponerla en la bandeja, sin
              cambiar el orden.
            </li>

            <li>
              <button
                className="btn btn-primario"
                disabled={generando || noSePuede}
                onClick={() =>
                  void guardar(`plantilla-reverso-${hojas}hojas.pdf`, () =>
                    generarTanda(g, plan.reverso, config.apuntes.numeroDePagina),
                  )
                }
              >
                2. Imprimir el reverso ({plan.reverso.length} páginas)
              </button>
              <span className="sutil">
                {" "}
                Va en orden {config.apuntes.reversoEnOrdenInverso ? "inverso" : "directo"}:{" "}
                {plan.reverso.slice(0, 4).join(", ")}
                {plan.reverso.length > 4 ? "…" : ""}
              </span>
            </li>
          </ol>

          <label className="selector-fila">
            <input
              type="checkbox"
              checked={config.apuntes.reversoEnOrdenInverso}
              onChange={(e) =>
                void actualizarConfig({
                  apuntes: { reversoEnOrdenInverso: e.target.checked },
                })
              }
            />
            <span>
              Mi impresora invierte el orden al dar vuelta la pila
              <small className="sutil"> — si la hoja de prueba salió al revés, cámbialo acá.</small>
            </span>
          </label>
        </div>
      )}
    </div>
  );
}
