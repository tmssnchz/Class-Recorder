import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";

import { useStore } from "../../estado/store";
import { formatearBytes, formatearFecha } from "../../lib/format";
import {
  AVISO_TAMANO_BYTES,
  FILTRO_DIALOGO,
  agregarMaterialDesde,
  borrarArchivoMaterial,
  tamano,
  tipoDe,
  type DestinoMaterial,
  type TipoMaterial,
} from "../../lib/materiales";
import { nombreArchivo } from "../../lib/paths";
import type { Material } from "../../types";
import { Icono } from "./Icono";
import { ModalConfirmacion } from "./ModalConfirmacion";

const ETIQUETA_TIPO: Record<TipoMaterial, string> = {
  pdf: "PDF",
  imagen: "Imagen",
  texto: "Markdown",
  presentacion: "Presentación",
  documento: "Documento",
};

interface Props {
  materiales: Material[];
  /** Sin destino la lista es solo de lectura (material heredado de otro nivel). */
  destino?: DestinoMaterial;
  titulo?: string;
  /** Texto cuando no hay nada; si se omite, la lista vacía no se muestra. */
  vacio?: string;
}

export function ListaMateriales({ materiales, destino, titulo, vacio }: Props) {
  const { agregarMaterial, quitarMaterial } = useStore();
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [borrando, setBorrando] = useState<Material | null>(null);
  const [pesado, setPesado] = useState<{ rutas: string[]; bytes: number } | null>(
    null,
  );

  if (materiales.length === 0 && !destino && !vacio) return null;

  const copiar = async (rutas: string[]) => {
    if (!destino) return;
    setOcupado(true);
    setError(null);
    try {
      for (const ruta of rutas) {
        await agregarMaterial(await agregarMaterialDesde(ruta, destino));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOcupado(false);
    }
  };

  const elegir = async () => {
    if (!destino) return;
    const elegidos = await open({
      multiple: true,
      title: "Elegir material de estudio",
      filters: [FILTRO_DIALOGO],
    });
    const rutas = Array.isArray(elegidos) ? elegidos : elegidos ? [elegidos] : [];
    if (rutas.length === 0) return;

    // Los archivos se copian dentro del proyecto: avisamos antes de duplicar
    // algo muy pesado, que además va a inflar el respaldo .zip.
    let total = 0;
    for (const r of rutas) total += await tamano(r);
    if (total > AVISO_TAMANO_BYTES) {
      setPesado({ rutas, bytes: total });
      return;
    }
    await copiar(rutas);
  };

  const eliminar = async (material: Material) => {
    setOcupado(true);
    setError(null);
    try {
      await borrarArchivoMaterial(material);
      await quitarMaterial(material.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBorrando(null);
      setOcupado(false);
    }
  };

  return (
    <div className="bloque">
      {(titulo || destino) && (
        <div className="cabecera-materiales">
          <h3 className="titulo-seccion">
            {titulo ?? "Material de estudio"}
            {materiales.length > 0 && (
              <span className="sutil"> ({materiales.length})</span>
            )}
          </h3>
          {destino && (
            <button
              className="btn btn-mini"
              disabled={ocupado}
              onClick={() => void elegir()}
            >
              <Icono nombre="mas" tamano={15} /> Agregar material
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="aviso aviso-error">
          <Icono nombre="alerta" />
          <span>{error}</span>
          <button className="btn-icono" onClick={() => setError(null)}>
            <Icono nombre="equis" tamano={16} />
          </button>
        </div>
      )}

      {materiales.length === 0 ? (
        <p className="sutil">{vacio ?? "Todavía no hay material acá."}</p>
      ) : (
        <ul className="lista">
          {materiales.map((m) => (
            <li key={m.id} className="item item-estatico">
              <span className={`chip-tipo tipo-${tipoDe(m.nombre)}`}>
                {ETIQUETA_TIPO[tipoDe(m.nombre)]}
              </span>
              <div className="item-texto">
                <strong>{m.nombre}</strong>
                <small className="sutil">
                  {formatearFecha(m.agregadoEn)} · {formatearBytes(m.bytes)}
                </small>
              </div>
              <button
                className="btn-icono"
                title="Abrir con la aplicación predeterminada"
                onClick={() =>
                  void openPath(m.archivo).catch((e) =>
                    setError(`No se pudo abrir: ${e}`),
                  )
                }
              >
                <Icono nombre="abrir" tamano={15} />
              </button>
              <button
                className="btn-icono"
                title="Mostrar en el Explorador"
                onClick={() => void revealItemInDir(m.archivo)}
              >
                <Icono nombre="carpeta" tamano={15} />
              </button>
              {destino && (
                <button
                  className="btn-icono peligro"
                  title="Eliminar"
                  disabled={ocupado}
                  onClick={() => setBorrando(m)}
                >
                  <Icono nombre="basura" tamano={15} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <ModalConfirmacion
        abierto={borrando !== null}
        titulo="Eliminar material"
        peligroso
        textoConfirmar="Eliminar"
        mensaje={
          <p>
            Se va a borrar <strong>{borrando?.nombre}</strong> del disco. El
            archivo original desde el que lo agregaste no se toca.
          </p>
        }
        onConfirmar={() => borrando && void eliminar(borrando)}
        onCancelar={() => setBorrando(null)}
      />

      <ModalConfirmacion
        abierto={pesado !== null}
        titulo="El material es pesado"
        textoConfirmar="Copiar igual"
        mensaje={
          pesado && (
            <>
              <p>
                {pesado.rutas.length === 1
                  ? nombreArchivo(pesado.rutas[0])
                  : `${pesado.rutas.length} archivos`}{" "}
                ocupan <strong>{formatearBytes(pesado.bytes)}</strong>.
              </p>
              <p className="sutil">
                El material se copia dentro de la carpeta de grabaciones para que
                el proyecto sea portable, así que ese espacio se duplica y
                también entra en el respaldo .zip.
              </p>
            </>
          )
        }
        onConfirmar={() => {
          const rutas = pesado?.rutas ?? [];
          setPesado(null);
          void copiar(rutas);
        }}
        onCancelar={() => setPesado(null)}
      />
    </div>
  );
}
