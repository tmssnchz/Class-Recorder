import { useMemo, useState } from "react";

import { nuevoId, useStore } from "../estado/store";
import {
  armarPrompt,
  clasificarNombres,
  nombreDia,
  normalizarHora,
  ordenarHorario,
  parsearHorario,
  type BloqueCrudo,
} from "../lib/horario";
import { DIAS_SEMANA, type BloqueHorario } from "../types";
import { Icono } from "./ui/Icono";
import { ModalConfirmacion } from "./ui/ModalConfirmacion";

export function HorarioPanel() {
  const { datos, guardarHorario, agregarClase } = useStore();
  const [importando, setImportando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [borrando, setBorrando] = useState<BloqueHorario | null>(null);

  const horario = useMemo(() => ordenarHorario(datos.horario), [datos.horario]);
  const nombreDeClase = (id: string) =>
    datos.clases.find((c) => c.id === id)?.nombre ?? "(clase borrada)";
  const colorDeClase = (id: string) =>
    datos.clases.find((c) => c.id === id)?.color ?? "#8b93a1";

  const agregarBloque = () => {
    if (datos.clases.length === 0) {
      setError("Primero crea al menos una clase en la pestaña Clases.");
      return;
    }
    setError(null);
    void guardarHorario([
      ...datos.horario,
      {
        id: nuevoId(),
        dia: 1,
        inicio: "08:00",
        fin: "10:00",
        claseId: datos.clases[0].id,
      },
    ]);
  };

  const editar = (id: string, cambios: Partial<BloqueHorario>) =>
    void guardarHorario(
      datos.horario.map((b) => (b.id === id ? { ...b, ...cambios } : b)),
    );

  return (
    <section className="panel">
      <header className="panel-cabecera">
        <div>
          <h2>Mi horario</h2>
          <p className="sutil">
            Sirve para preseleccionar la clase al empezar a grabar, y para
            sugerir a qué materia corresponde un audio importado del celular.
          </p>
        </div>
        <div className="acciones-cabecera">
          <button className="btn" onClick={() => setImportando(true)}>
            Importar horario con IA
          </button>
          <button className="btn btn-primario" onClick={agregarBloque}>
            <Icono nombre="mas" tamano={16} /> Agregar bloque
          </button>
        </div>
      </header>

      {error && (
        <div className="aviso aviso-error">
          <Icono nombre="alerta" />
          <span>{error}</span>
          <button className="btn-icono" onClick={() => setError(null)}>
            <Icono nombre="equis" tamano={16} />
          </button>
        </div>
      )}

      {horario.length === 0 ? (
        <p className="vacio">
          Todavía no cargaste tu horario. Puedes agregar los bloques a mano, o
          pegarlo desde una IA que tenga acceso a tu calendario.
        </p>
      ) : (
        <table className="tabla-horario">
          <thead>
            <tr>
              <th>Día</th>
              <th>Desde</th>
              <th>Hasta</th>
              <th>Clase</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {horario.map((b) => (
              <tr key={b.id}>
                <td>
                  <select
                    value={b.dia}
                    onChange={(e) => editar(b.id, { dia: Number(e.target.value) })}
                  >
                    {DIAS_SEMANA.map((d, i) => (
                      <option key={d} value={i + 1}>
                        {d}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    type="time"
                    value={b.inicio}
                    onChange={(e) =>
                      editar(b.id, {
                        inicio: normalizarHora(e.target.value) ?? b.inicio,
                      })
                    }
                  />
                </td>
                <td>
                  <input
                    type="time"
                    value={b.fin}
                    onChange={(e) =>
                      editar(b.id, { fin: normalizarHora(e.target.value) ?? b.fin })
                    }
                  />
                </td>
                <td>
                  <span className="punto" style={{ background: colorDeClase(b.claseId) }} />
                  <select
                    value={b.claseId}
                    onChange={(e) => editar(b.id, { claseId: e.target.value })}
                  >
                    {datos.clases.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.nombre}
                      </option>
                    ))}
                    {!datos.clases.some((c) => c.id === b.claseId) && (
                      <option value={b.claseId}>{nombreDeClase(b.claseId)}</option>
                    )}
                  </select>
                </td>
                <td>
                  <button
                    className="btn-icono peligro"
                    title="Quitar bloque"
                    onClick={() => setBorrando(b)}
                  >
                    <Icono nombre="basura" tamano={15} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {importando && (
        <ImportarConIA
          onCerrar={() => setImportando(false)}
          onConfirmar={async (bloques, crearNuevas) => {
            // Las clases nuevas se crean primero para poder referenciarlas.
            const porNombre = new Map(
              datos.clases.map((c) => [c.nombre.toLowerCase(), c.id]),
            );
            for (const nombre of crearNuevas) {
              const creada = await agregarClase(nombre);
              porNombre.set(nombre.toLowerCase(), creada.id);
            }

            const nuevos: BloqueHorario[] = [];
            for (const b of bloques) {
              const claseId = porNombre.get(b.claseNombre.toLowerCase());
              if (!claseId) continue; // materia que se eligió no crear
              nuevos.push({
                id: nuevoId(),
                dia: b.dia,
                inicio: b.inicio,
                fin: b.fin,
                claseId,
              });
            }
            await guardarHorario(nuevos);
            setImportando(false);
          }}
        />
      )}

      <ModalConfirmacion
        abierto={borrando !== null}
        titulo="Quitar bloque"
        peligroso
        textoConfirmar="Quitar"
        mensaje={
          borrando && (
            <p>
              {nombreDia(borrando.dia)} de {borrando.inicio} a {borrando.fin} —{" "}
              <strong>{nombreDeClase(borrando.claseId)}</strong>
            </p>
          )
        }
        onConfirmar={() => {
          if (borrando) {
            void guardarHorario(datos.horario.filter((b) => b.id !== borrando.id));
          }
          setBorrando(null);
        }}
        onCancelar={() => setBorrando(null)}
      />
    </section>
  );
}

/** Modal de tres pasos: copiar el prompt, pegar la respuesta, revisar y confirmar. */
function ImportarConIA({
  onCerrar,
  onConfirmar,
}: {
  onCerrar(): void;
  onConfirmar(bloques: BloqueCrudo[], crearNuevas: string[]): Promise<void>;
}) {
  const { datos, config, actualizarConfig } = useStore();
  const [pegado, setPegado] = useState("");
  const [copiado, setCopiado] = useState(false);
  const [editandoPlantilla, setEditandoPlantilla] = useState(false);
  const [vistaPrevia, setVistaPrevia] = useState<BloqueCrudo[] | null>(null);
  const [errores, setErrores] = useState<string[]>([]);
  const [nuevas, setNuevas] = useState<string[]>([]);
  const [aCrear, setACrear] = useState<Set<string>>(new Set());
  const [guardando, setGuardando] = useState(false);

  const prompt = armarPrompt(config.plantillaPromptHorario, datos.clases);

  const procesar = () => {
    const { bloques, errores: errs } = parsearHorario(pegado);
    setErrores(errs);
    if (bloques.length === 0) {
      setVistaPrevia(null);
      return;
    }
    const { nuevas: n } = clasificarNombres(bloques, datos.clases);
    setNuevas(n);
    setACrear(new Set(n));
    setVistaPrevia(bloques);
  };

  return (
    <div className="modal-fondo" onClick={guardando ? undefined : onCerrar}>
      <div
        className="modal modal-horario"
        role="dialog"
        aria-modal="true"
        aria-label="Importar horario con IA"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Importar horario con IA</h3>
        <p className="sutil">
          ClassRecorder no se conecta a ninguna IA. Copia este texto, pégalo en
          la IA que ya uses (con acceso a tu calendario), y trae la respuesta.
        </p>

        <div className="paso-ia">
          <div className="cabecera-materiales">
            <strong>1. Copiá este prompt</strong>
            <div className="acciones-cabecera">
              <button
                className="btn btn-mini"
                onClick={() => setEditandoPlantilla((v) => !v)}
              >
                {editandoPlantilla ? "Listo" : "Editar plantilla"}
              </button>
              <button
                className="btn btn-mini"
                onClick={() => {
                  void navigator.clipboard.writeText(prompt);
                  setCopiado(true);
                  setTimeout(() => setCopiado(false), 2000);
                }}
              >
                {copiado ? "Copiado" : "Copiar"}
              </button>
            </div>
          </div>
          {editandoPlantilla ? (
            <textarea
              className="area-ia"
              value={config.plantillaPromptHorario}
              onChange={(e) =>
                void actualizarConfig({ plantillaPromptHorario: e.target.value })
              }
            />
          ) : (
            <pre className="prompt-ia">{prompt}</pre>
          )}
        </div>

        <div className="paso-ia">
          <strong>2. Pega aquí la respuesta</strong>
          <textarea
            className="area-ia"
            value={pegado}
            placeholder='[{"dia": "Lunes", "inicio": "08:30", "fin": "10:00", "clase": "..."}]'
            onChange={(e) => setPegado(e.target.value)}
          />
          <button
            className="btn"
            disabled={!pegado.trim()}
            onClick={procesar}
          >
            Procesar
          </button>
        </div>

        {errores.length > 0 && (
          <div className="aviso aviso-error">
            <Icono nombre="alerta" />
            <span>
              {errores.map((e, i) => (
                <span key={i} className="linea-error">
                  {e}
                </span>
              ))}
              {vistaPrevia
                ? " El resto se puede importar igual."
                : " Corrige el texto pegado e inténtalo de nuevo, o cierra y carga el horario a mano."}
            </span>
          </div>
        )}

        {vistaPrevia && (
          <div className="paso-ia">
            <strong>3. Revisá antes de guardar</strong>
            <p className="sutil">
              Esto reemplaza el horario actual por completo.
            </p>
            <table className="tabla-horario">
              <thead>
                <tr>
                  <th>Día</th>
                  <th>Desde</th>
                  <th>Hasta</th>
                  <th>Clase</th>
                </tr>
              </thead>
              <tbody>
                {vistaPrevia.map((b, i) => (
                  <tr key={i}>
                    <td>{nombreDia(b.dia)}</td>
                    <td>{b.inicio}</td>
                    <td>{b.fin}</td>
                    <td>
                      {b.claseNombre}
                      {nuevas.includes(b.claseNombre) && (
                        <span className="chip chip-mini">nueva</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {nuevas.length > 0 && (
              <div className="aviso aviso-info">
                <Icono nombre="alerta" />
                <span>
                  Estas materias no existen todavía. Desmarca las que no quieras
                  crear: sus bloques se van a descartar.
                  <span className="lista-nuevas">
                    {nuevas.map((n) => (
                      <label key={n} className="casilla">
                        <input
                          type="checkbox"
                          checked={aCrear.has(n)}
                          onChange={(e) =>
                            setACrear((prev) => {
                              const s = new Set(prev);
                              if (e.target.checked) s.add(n);
                              else s.delete(n);
                              return s;
                            })
                          }
                        />
                        <span>{n}</span>
                      </label>
                    ))}
                  </span>
                </span>
              </div>
            )}
          </div>
        )}

        <div className="modal-acciones">
          <button className="btn" disabled={guardando} onClick={onCerrar}>
            Cancelar
          </button>
          <button
            className="btn btn-primario"
            disabled={!vistaPrevia || guardando}
            onClick={() => {
              if (!vistaPrevia) return;
              setGuardando(true);
              void onConfirmar(
                vistaPrevia.filter(
                  (b) => !nuevas.includes(b.claseNombre) || aCrear.has(b.claseNombre),
                ),
                [...aCrear],
              ).finally(() => setGuardando(false));
            }}
          >
            {guardando ? "Guardando…" : "Guardar horario"}
          </button>
        </div>
      </div>
    </div>
  );
}
