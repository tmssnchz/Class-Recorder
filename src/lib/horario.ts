/**
 * Horario semanal de clases.
 *
 * Sirve para dos cosas: preseleccionar la clase al empezar a grabar, y sugerir
 * a qué clase corresponde un audio importado del celular.
 *
 * La importación por texto no llama a ninguna IA: la app arma un prompt, el
 * usuario lo pega en la IA que ya usa, y después pega la respuesta acá. Todo lo
 * de este archivo es puro y no toca disco ni red.
 */
import { DIAS_SEMANA, type BloqueHorario, type Clase } from "../types.ts";

/** Quita acentos y pasa a minúsculas, para comparar nombres escritos a mano. */
function normalizar(texto: string): string {
  return texto
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/**
 * Nombre de día a número ISO (lunes = 1). Tolera mayúsculas, acentos faltantes
 * y abreviaturas de tres letras: la IA externa puede devolver cualquiera.
 */
export function diaANumero(nombre: string): number | null {
  const limpio = normalizar(nombre);
  if (!limpio) return null;
  const indice = DIAS_SEMANA.findIndex((d) => {
    const dn = normalizar(d);
    return dn === limpio || dn.startsWith(limpio.slice(0, 3));
  });
  return indice === -1 ? null : indice + 1;
}

export const nombreDia = (dia: number): string => DIAS_SEMANA[dia - 1] ?? "?";

/**
 * "8:30", "08:30", "8.30" o "0830" a "08:30". null si no es una hora válida.
 */
export function normalizarHora(texto: string): string | null {
  const limpio = texto.trim();
  const m = /^(\d{1,2})[:.\s]?(\d{2})$/.exec(limpio);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** Minutos desde medianoche. Asume formato ya normalizado. */
export function aMinutos(hora: string): number {
  const [h, m] = hora.split(":").map(Number);
  return h * 60 + m;
}

// ------------------------------------------------------------- sugerencia

/**
 * Bloque que cubre ese momento exacto. Devuelve null si no hay ninguno, y
 * también si hay más de uno: con bloques superpuestos no se adivina, es
 * preferible dejar el selector vacío a preseleccionar la clase equivocada.
 */
export function bloqueEn(horario: BloqueHorario[], momento: Date): BloqueHorario | null {
  // getDay() da 0 para domingo; el horario usa 1..7 con lunes primero.
  const dia = ((momento.getDay() + 6) % 7) + 1;
  const minutos = momento.getHours() * 60 + momento.getMinutes();

  const coinciden = horario.filter(
    (b) =>
      b.dia === dia &&
      minutos >= aMinutos(b.inicio) &&
      minutos < aMinutos(b.fin),
  );
  return coinciden.length === 1 ? coinciden[0] : null;
}

// ------------------------------------------------- importación por texto

export const PLANTILLA_PROMPT_POR_DEFECTO = `Necesito mi horario semanal de clases de la facultad en formato JSON.

Devuelve SOLO un array JSON, sin explicaciones ni texto alrededor, con esta forma exacta:

[{"dia": "Lunes", "inicio": "08:30", "fin": "10:00", "clase": "Nombre de la materia"}]

Reglas:
- "dia" es el nombre del día en español (Lunes a Domingo).
- "inicio" y "fin" en formato 24 horas HH:mm.
- Un objeto por cada bloque de clase. Si una materia se cursa dos veces por semana, van dos objetos.
- Usa exactamente estos nombres de materia cuando correspondan: {CLASES}
- Si aparece una materia que no está en esa lista, usa el nombre tal como figura en mi calendario.`;

/** Arma el prompt con la lista de clases ya cargadas, para que los nombres coincidan. */
export function armarPrompt(plantilla: string, clases: Clase[]): string {
  const nombres =
    clases.length > 0
      ? clases.map((c) => `"${c.nombre}"`).join(", ")
      : "(todavía no hay clases cargadas, usá los nombres de mi calendario)";
  return plantilla.replace("{CLASES}", nombres);
}

/** Bloque tal como viene del texto pegado, antes de resolverlo contra el índice. */
export interface BloqueCrudo {
  dia: number;
  inicio: string;
  fin: string;
  claseNombre: string;
}

export interface ResultadoParseo {
  bloques: BloqueCrudo[];
  /** Problemas por fila, para mostrarlos sin descartar todo el pegado. */
  errores: string[];
}

/**
 * Parsea lo que el usuario pegó. Tolera que la IA haya envuelto el JSON en un
 * bloque de código o le haya puesto texto antes y después: se busca el array
 * más externo en vez de exigir que el pegado sea JSON puro.
 */
export function parsearHorario(texto: string): ResultadoParseo {
  const errores: string[] = [];
  const bloques: BloqueCrudo[] = [];

  const desde = texto.indexOf("[");
  const hasta = texto.lastIndexOf("]");
  if (desde === -1 || hasta === -1 || hasta < desde) {
    return {
      bloques: [],
      errores: ["No se encontró ningún array JSON en el texto pegado."],
    };
  }

  let crudo: unknown;
  try {
    crudo = JSON.parse(texto.slice(desde, hasta + 1));
  } catch (e) {
    return {
      bloques: [],
      errores: [
        `El texto no es JSON válido: ${e instanceof Error ? e.message : String(e)}`,
      ],
    };
  }

  if (!Array.isArray(crudo)) {
    return { bloques: [], errores: ["El JSON no es una lista de bloques."] };
  }

  crudo.forEach((fila, i) => {
    const n = i + 1;
    if (typeof fila !== "object" || fila === null) {
      errores.push(`Bloque ${n}: no es un objeto.`);
      return;
    }
    const f = fila as Record<string, unknown>;

    const dia = diaANumero(String(f.dia ?? ""));
    if (dia === null) {
      errores.push(`Bloque ${n}: día no reconocido ("${String(f.dia ?? "")}").`);
      return;
    }
    const inicio = normalizarHora(String(f.inicio ?? ""));
    const fin = normalizarHora(String(f.fin ?? ""));
    if (!inicio || !fin) {
      errores.push(`Bloque ${n}: horario inválido ("${f.inicio}" a "${f.fin}").`);
      return;
    }
    if (aMinutos(fin) <= aMinutos(inicio)) {
      errores.push(`Bloque ${n}: la hora de fin no puede ser anterior al inicio.`);
      return;
    }
    const claseNombre = String(f.clase ?? "").trim();
    if (!claseNombre) {
      errores.push(`Bloque ${n}: falta el nombre de la materia.`);
      return;
    }

    bloques.push({ dia, inicio, fin, claseNombre });
  });

  return { bloques, errores };
}

/**
 * Separa los nombres del texto pegado según existan o no en el índice. La
 * comparación ignora mayúsculas y acentos: "microeconomia" encuentra
 * "Microeconomía".
 */
export function clasificarNombres(bloques: BloqueCrudo[], clases: Clase[]) {
  const porNombre = new Map(clases.map((c) => [normalizar(c.nombre), c]));
  const conocidas = new Map<string, Clase>();
  const nuevas: string[] = [];

  for (const b of bloques) {
    const clave = normalizar(b.claseNombre);
    const clase = porNombre.get(clave);
    if (clase) {
      conocidas.set(b.claseNombre, clase);
    } else if (!nuevas.includes(b.claseNombre)) {
      nuevas.push(b.claseNombre);
    }
  }

  return { conocidas, nuevas };
}

/** Ordena por día y después por hora de inicio. */
export const ordenarHorario = (horario: BloqueHorario[]): BloqueHorario[] =>
  [...horario].sort((a, b) => a.dia - b.dia || aMinutos(a.inicio) - aMinutos(b.inicio));
