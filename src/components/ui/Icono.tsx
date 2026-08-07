/** Íconos SVG inline: no hay dependencias externas ni requests de red. */

type Nombre =
  | "micro"
  | "biblioteca"
  | "clases"
  | "config"
  | "mas"
  | "lapiz"
  | "basura"
  | "check"
  | "equis"
  | "carpeta"
  | "alerta"
  | "tijera";

const TRAZOS: Record<Nombre, string> = {
  micro:
    "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v3",
  biblioteca: "M4 5h6v14H4zM14 5h6v14h-6M14 9h6M14 15h6",
  clases: "M3 6h18M3 12h18M3 18h11",
  config:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.5 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1.6a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 3.3 7.5a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V1.6a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.1a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.1 2.7Z",
  mas: "M12 5v14M5 12h14",
  lapiz: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z",
  basura: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6",
  check: "M20 6 9 17l-5-5",
  equis: "M18 6 6 18M6 6l12 12",
  carpeta: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
  alerta: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  tijera:
    "M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM20 4 7.5 12M20 20 7.5 12M8.6 10.4l2.9 1.6",
};

export function Icono({
  nombre,
  tamano = 18,
}: {
  nombre: Nombre;
  tamano?: number;
}) {
  // El ícono de configuración usa un viewBox propio porque su path es más ancho.
  const viewBox = nombre === "config" ? "-2 -2 28 28" : "0 0 24 24";
  return (
    <svg
      width={tamano}
      height={tamano}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={TRAZOS[nombre]} />
    </svg>
  );
}
