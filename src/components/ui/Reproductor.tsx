import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { formatearDuracion } from "../../lib/format";
import type { Marca } from "../../types";
import { Icono } from "./Icono";

const VELOCIDADES = [0.75, 1, 1.25, 1.5, 1.75, 2];

interface Props {
  src: string;
  /** Duración conocida desde la metadata: sirve hasta que el audio carga la real. */
  duracionEstimada: number;
  marcas: Marca[];
  /**
   * El elemento <audio> lo controla el padre para poder soltar el archivo antes
   * de moverlo o borrarlo: Windows no permite renombrar un archivo abierto.
   */
  audioRef: RefObject<HTMLAudioElement | null>;
}

export function Reproductor({ src, duracionEstimada, marcas, audioRef }: Props) {
  const [reproduciendo, setReproduciendo] = useState(false);
  const [posicion, setPosicion] = useState(0);
  const [duracion, setDuracion] = useState(duracionEstimada);
  const [velocidad, setVelocidad] = useState(1);
  const [error, setError] = useState(false);
  const barraRef = useRef<HTMLDivElement>(null);

  // Al cambiar de grabación se reinicia todo.
  useEffect(() => {
    setReproduciendo(false);
    setPosicion(0);
    setDuracion(duracionEstimada);
    setError(false);
  }, [src, duracionEstimada]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.playbackRate = velocidad;
  }, [velocidad, src, audioRef]);

  const alternar = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => setError(true));
    else audio.pause();
  }, [audioRef]);

  const saltarA = useCallback(
    (segundo: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      audio.currentTime = Math.max(0, Math.min(segundo, duracion || 0));
      setPosicion(audio.currentTime);
    },
    [audioRef, duracion],
  );

  const clicEnBarra = (e: React.MouseEvent<HTMLDivElement>) => {
    const barra = barraRef.current;
    if (!barra || !duracion) return;
    const rect = barra.getBoundingClientRect();
    const fraccion = (e.clientX - rect.left) / rect.width;
    saltarA(fraccion * duracion);
  };

  const porcentaje = duracion > 0 ? (posicion / duracion) * 100 : 0;

  return (
    <div className="reproductor">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          // Los WebM armados por chunks reportan Infinity: nos quedamos con la estimada.
          if (Number.isFinite(d) && d > 0) setDuracion(d);
        }}
        onTimeUpdate={(e) => setPosicion(e.currentTarget.currentTime)}
        onPlay={() => setReproduciendo(true)}
        onPause={() => setReproduciendo(false)}
        onEnded={() => setReproduciendo(false)}
        onError={() => setError(true)}
      />

      {error && (
        <p className="aviso aviso-error">
          <Icono nombre="alerta" tamano={16} />
          <span>No se pudo cargar el audio. ¿El archivo sigue en su carpeta?</span>
        </p>
      )}

      <div className="reproductor-fila">
        <button
          className="btn-reproducir"
          onClick={alternar}
          title={reproduciendo ? "Pausar" : "Reproducir"}
        >
          {reproduciendo ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="5" width="4" height="14" rx="1" />
              <rect x="14" y="5" width="4" height="14" rx="1" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5.5v13l11-6.5z" />
            </svg>
          )}
        </button>

        <span className="tiempo">{formatearDuracion(posicion)}</span>

        <div className="barra" ref={barraRef} onClick={clicEnBarra}>
          <div className="barra-progreso" style={{ width: `${porcentaje}%` }} />
          {duracion > 0 &&
            marcas.map((m) => (
              <button
                key={m.id}
                className="marcador"
                style={{ left: `${Math.min(100, (m.segundo / duracion) * 100)}%` }}
                title={`${formatearDuracion(m.segundo)}${m.nota ? ` — ${m.nota}` : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  saltarA(m.segundo);
                }}
              />
            ))}
        </div>

        <span className="tiempo">{formatearDuracion(duracion)}</span>

        <select
          className="velocidad"
          value={velocidad}
          onChange={(e) => setVelocidad(Number(e.target.value))}
          title="Velocidad de reproducción"
        >
          {VELOCIDADES.map((v) => (
            <option key={v} value={v}>
              {v}×
            </option>
          ))}
        </select>
      </div>

      <div className="reproductor-saltos">
        <button className="btn btn-mini" onClick={() => saltarA(posicion - 15)}>
          −15 s
        </button>
        <button className="btn btn-mini" onClick={() => saltarA(posicion + 15)}>
          +15 s
        </button>
      </div>
    </div>
  );
}
