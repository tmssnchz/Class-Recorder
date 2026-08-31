/**
 * Qué está haciendo el reconocimiento, en concreto.
 *
 * Antes la cola era un número: "28 hojas reconociendo". Eso no dice cuál se
 * está leyendo, ni de qué apunte, ni cuánto falta, ni cómo pararla — y con dos
 * minutos por hoja en CPU la espera es de una hora. Acá se ve la miniatura de
 * la hoja en curso, la lista de lo que espera, y un botón para cancelar todo.
 */
import { convertFileSrc } from "@tauri-apps/api/core";

import { useApuntes } from "../../estado/apuntes";
import { useStore } from "../../estado/store";
import { buscarModeloHtr, estimarMinutos } from "../../lib/htrModelos";
import { Icono } from "../ui/Icono";

const ETIQUETA: Record<string, string> = {
  esperando: "en espera",
  cargando: "cargando el modelo…",
  leyendo: "leyendo la hoja…",
  listo: "listo",
  error: "falló",
};

export function ColaReconocimiento() {
  const { datos, config } = useStore();
  const { tareas, cancelarTodo, descartarError } = useApuntes();

  const lista = Object.values(tareas);
  if (lista.length === 0) return null;

  const enCurso = lista.find((t) => t.estado === "cargando" || t.estado === "leyendo");
  const conError = lista.filter((t) => t.estado === "error");
  const esperando = lista.filter((t) => t.estado === "esperando");

  /** La página que se está leyendo, para poder mostrarla. */
  const paginaDe = (apunteId: string, paginaId: string) =>
    datos.apuntes
      .find((a) => a.id === apunteId)
      ?.paginas.find((p) => p.id === paginaId);

  const modelo = buscarModeloHtr(config.apuntes.modelo);
  const restantes = esperando.length + (enCurso ? 1 : 0);
  const minutos = config.apuntes.motor === "api" ? 0 : estimarMinutos(modelo, restantes);

  return (
    <div className="tarjeta cola-reconocimiento">
      <div className="panel-cabecera">
        <div>
          <h3>Reconociendo texto</h3>
          <p className="sutil">
            {restantes} {restantes === 1 ? "hoja" : "hojas"} por delante
            {minutos > 0 && ` · alrededor de ${minutos} min con ${modelo.etiqueta}`}
            {config.apuntes.motor === "api" && " · por API externa"}
          </p>
        </div>
        <button className="btn btn-peligro" onClick={cancelarTodo}>
          Cancelar todo
        </button>
      </div>

      {enCurso && (
        <div className="item item-estatico">
          {(() => {
            const pagina = paginaDe(enCurso.apunteId, enCurso.paginaId);
            return pagina ? (
              <img className="portada-apunte" src={convertFileSrc(pagina.archivo)} alt="" />
            ) : null;
          })()}
          <div className="item-texto">
            <strong>
              {enCurso.titulo} · página {enCurso.numero}
            </strong>
            <small className="sutil">{ETIQUETA[enCurso.estado] ?? enCurso.estado}</small>
          </div>
          <div className="progreso progreso-indeterminado">
            <div className="progreso-valor" />
          </div>
        </div>
      )}

      {/* Solo las primeras: una lista de 28 líneas no informa más que un número. */}
      {esperando.length > 0 && (
        <p className="sutil">
          En espera: {esperando.slice(0, 4).map((t) => `${t.titulo} p.${t.numero}`).join(", ")}
          {esperando.length > 4 && ` y ${esperando.length - 4} más`}
        </p>
      )}

      {conError.map((t) => (
        <div className="aviso aviso-error" key={t.id}>
          <Icono nombre="alerta" />
          <span>
            {t.titulo} · página {t.numero}: {t.error}
          </span>
          <button className="btn" onClick={() => descartarError(t.id)}>
            Descartar
          </button>
        </div>
      ))}
    </div>
  );
}
