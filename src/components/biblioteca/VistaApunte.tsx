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
 */
import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { useStore } from "../../estado/store";
import { progresoReconocimiento } from "../../lib/apuntes";
import { exportarApunte } from "../../lib/exportarApunte";
import { formatearBytes, formatearFechaLarga } from "../../lib/format";
import type { Apunte } from "../../types";
import { Icono } from "../ui/Icono";

interface Props {
  apunte: Apunte;
  /** Lleva el apunte a la pestaña Digitalizar, ya abierto en el editor. */
  onCorregir?(apunteId: string): void;
}

export function VistaApunte({ apunte, onCorregir }: Props) {
  const { actualizarApunte } = useStore();
  const [activa, setActiva] = useState(0);
  const [ampliada, setAmpliada] = useState(false);
  const [nota, setNota] = useState(apunte.nota ?? "");

  const paginas = [...apunte.paginas].sort((a, b) => a.numero - b.numero);
  const pagina = paginas[activa];
  const progreso = progresoReconocimiento(apunte);

  useEffect(() => {
    setActiva(0);
    setNota(apunte.nota ?? "");
  }, [apunte.id, apunte.nota]);

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

      {paginas.length === 0 ? (
        <p className="vacio">Este apunte se quedó sin páginas.</p>
      ) : (
        <div className="apunte-cuerpo">
          <aside className="tira-paginas">
            {paginas.map((p, i) => (
              <button
                key={p.id}
                className={`miniatura ${i === activa ? "elegida" : ""}`}
                onClick={() => setActiva(i)}
                title={`Página ${p.numero}`}
              >
                <img src={convertFileSrc(p.archivo)} alt={`Página ${p.numero}`} loading="lazy" />
                <small>{p.numero}</small>
              </button>
            ))}
          </aside>

          {pagina && (
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
                  onClick={() => setActiva((i) => i - 1)}
                  disabled={activa === 0}
                >
                  ← Anterior
                </button>
                <button
                  className="btn"
                  onClick={() => setActiva((i) => i + 1)}
                  disabled={activa === paginas.length - 1}
                >
                  Siguiente →
                </button>
                <button className="btn" onClick={() => setAmpliada(true)}>
                  <Icono nombre="lupa" />
                  Ampliar
                </button>
              </div>
            </div>
          )}
        </div>
      )}

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
