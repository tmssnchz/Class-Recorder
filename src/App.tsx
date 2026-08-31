import { useState } from "react";

import { ApuntesPanel } from "./components/ApuntesPanel";
import { BibliotecaPanel } from "./components/BibliotecaPanel";
import { ClasesPanel } from "./components/ClasesPanel";
import { ConfiguracionPanel } from "./components/ConfiguracionPanel";
import { GrabarPanel } from "./components/GrabarPanel";
import { HorarioPanel } from "./components/HorarioPanel";
import { Icono } from "./components/ui/Icono";
import { ProveedorApuntes, useApuntes } from "./estado/apuntes";
import { ProveedorGrabador, useGrabador } from "./estado/grabador";
import { ProveedorStore, useStore } from "./estado/store";
import { ProveedorTranscripciones, useTranscripciones } from "./estado/transcripciones";
import { useAtajos } from "./hooks/useAtajos";
import { formatearDuracion } from "./lib/format";
import "./styles.css";

type Vista = "grabar" | "biblioteca" | "apuntes" | "clases" | "horario" | "config";

const NAV: {
  id: Vista;
  etiqueta: string;
  icono: "micro" | "biblioteca" | "apunte" | "clases" | "horario" | "config";
}[] = [
  { id: "grabar", etiqueta: "Grabar", icono: "micro" },
  { id: "biblioteca", etiqueta: "Biblioteca", icono: "biblioteca" },
  { id: "apuntes", etiqueta: "Apuntes", icono: "apunte" },
  { id: "clases", etiqueta: "Clases", icono: "clases" },
  { id: "horario", etiqueta: "Mi horario", icono: "horario" },
  { id: "config", etiqueta: "Configuración", icono: "config" },
];

export default function App() {
  return (
    <ProveedorStore>
      <ProveedorGrabador>
        <ProveedorTranscripciones>
          <ProveedorApuntes>
            <Contenido />
          </ProveedorApuntes>
        </ProveedorTranscripciones>
      </ProveedorGrabador>
    </ProveedorStore>
  );
}

function Contenido() {
  const [vista, setVista] = useState<Vista>("grabar");
  // Un resultado de búsqueda que cae en un apunte abre la pestaña Apuntes
  // directamente en ese apunte, en vez de dejar al usuario buscarlo de nuevo.
  const [apunteDestino, setApunteDestino] = useState<string | null>(null);
  const { cargando, error, datos } = useStore();
  const grabador = useGrabador();
  const { tareas } = useTranscripciones();
  const { pendientes: apuntesEnCola } = useApuntes();
  const { erroresAtajos } = useAtajos();

  if (cargando) {
    return (
      <div className="cargando">
        <p>Cargando datos…</p>
      </div>
    );
  }

  const enCurso = grabador.fase === "grabando" || grabador.fase === "pausado";

  return (
    <div className="app">
      <nav className="barra-lateral">
        <div className="marca">
          <Icono nombre="micro" tamano={20} />
          <span>ClassRecorder</span>
        </div>
        {NAV.map((n) => (
          <button
            key={n.id}
            className={`nav-item ${vista === n.id ? "activo" : ""}`}
            onClick={() => setVista(n.id)}
          >
            <Icono nombre={n.icono} />
            <span>{n.etiqueta}</span>
          </button>
        ))}

        {/* Testigo siempre visible: desde cualquier pestaña se ve que está grabando. */}
        {enCurso && (
          <button
            className="testigo-rec"
            onClick={() => setVista("grabar")}
            title="Ir a la grabación en curso"
          >
            <span
              className={grabador.fase === "grabando" ? "punto-rec" : "punto-pausa"}
            />
            {formatearDuracion(grabador.segundos)}
            <small>{grabador.fase === "pausado" ? "en pausa" : "grabando"}</small>
          </button>
        )}

        {Object.keys(tareas).length > 0 && (
          <button
            className="testigo-tarea"
            onClick={() => setVista("biblioteca")}
            title="Ver las transcripciones en curso"
          >
            {Object.keys(tareas).length}{" "}
            {Object.keys(tareas).length === 1
              ? "transcripción"
              : "transcripciones"}
            <small>en proceso</small>
          </button>
        )}

        {apuntesEnCola > 0 && (
          <button
            className="testigo-tarea"
            onClick={() => setVista("apuntes")}
            title="Ver los apuntes en reconocimiento"
          >
            {apuntesEnCola} {apuntesEnCola === 1 ? "hoja" : "hojas"}
            <small>reconociendo</small>
          </button>
        )}

        <div className="barra-pie sutil">
          {datos.clases.length} {datos.clases.length === 1 ? "clase" : "clases"}{" "}
          · {datos.grabaciones.length}{" "}
          {datos.grabaciones.length === 1 ? "grabación" : "grabaciones"}
        </div>
      </nav>

      <main className="contenido">
        {error && (
          <div className="aviso aviso-error">
            <Icono nombre="alerta" />
            <span>{error}</span>
          </div>
        )}
        {erroresAtajos.length > 0 && (
          <div className="aviso aviso-info">
            <Icono nombre="alerta" />
            <span>
              {erroresAtajos.join(" ")} Se pueden cambiar en Configuración.
            </span>
          </div>
        )}
        {vista === "grabar" && <GrabarPanel />}
        {vista === "clases" && <ClasesPanel />}
        {vista === "biblioteca" && (
          <BibliotecaPanel
            onAbrirApunte={(id) => {
              setApunteDestino(id);
              setVista("apuntes");
            }}
          />
        )}
        {vista === "apuntes" && (
          <ApuntesPanel
            apunteInicial={apunteDestino}
            onApunteAbierto={() => setApunteDestino(null)}
          />
        )}
        {vista === "horario" && <HorarioPanel />}
        {vista === "config" && <ConfiguracionPanel />}
      </main>
    </div>
  );
}
