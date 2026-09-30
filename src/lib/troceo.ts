/**
 * Troceo de audio largo para la transcripción por API. Todo puro (sin ffmpeg
 * ni Tauri) para poder probarlo con node: ver `troceo.test.mjs`.
 *
 * Idea: OpenRouter corta cada request a los 60 s, así que la clase se parte en
 * trozos de pocos minutos. Los cortes se eligen en silencios detectados por
 * ffmpeg (`silencedetect`), sin recortar nada del audio: así los tiempos de
 * cada trozo siguen siendo "desde el inicio del trozo" y reajustarlos es una
 * suma. Si no hay silencio cerca, se corta duro y el solape de unos segundos
 * más la deduplicación de texto reparan la unión.
 */
import type { Segmento } from "../types.ts";

export interface Silencio {
  desdeSeg: number;
  hastaSeg: number;
}

export interface Trozo {
  indice: number;
  /** Donde arranca el audio que se manda (incluye el solape con el trozo anterior). */
  desdeSeg: number;
  hastaSeg: number;
  /** Donde arranca "lo suyo" del trozo: antes de esto manda el trozo anterior. */
  propioDesdeSeg: number;
}

export interface ParametrosTroceo {
  objetivoSeg: number;
  minSeg: number;
  maxSeg: number;
  solapeSeg: number;
}

/**
 * 4 min de objetivo (3-5 min): a 24 kbps son ~0,7 MB, muy por debajo de los
 * 25 MB, y cada request queda lejos del timeout de 60 s. Ajustar con los
 * tiempos reales de respuesta que se registran en `transcripcionApi.ts`.
 */
export const PARAMETROS_TROCEO: ParametrosTroceo = {
  objetivoSeg: 240,
  minSeg: 180,
  maxSeg: 300,
  solapeSeg: 2,
};

/** Un trozo cuyo audio es silencio en esta fracción o más no se manda: Whisper alucina en silencios. */
export const FRACCION_SILENCIO_OMITIR = 0.95;

/**
 * Lee la salida de `ffmpeg -af silencedetect`. Un silencio que no cierra
 * (el archivo termina en silencio) termina en `duracionSeg`.
 */
export function parsearSilencios(stderr: string, duracionSeg: number): Silencio[] {
  const silencios: Silencio[] = [];
  let abierto: number | null = null;
  for (const linea of stderr.split("\n")) {
    const inicio = /silence_start:\s*(-?[\d.]+)/.exec(linea);
    if (inicio) {
      abierto = Math.max(0, Number(inicio[1]));
      continue;
    }
    const fin = /silence_end:\s*(-?[\d.]+)/.exec(linea);
    if (fin && abierto !== null) {
      silencios.push({ desdeSeg: abierto, hastaSeg: Number(fin[1]) });
      abierto = null;
    }
  }
  if (abierto !== null && duracionSeg > abierto) {
    silencios.push({ desdeSeg: abierto, hastaSeg: duracionSeg });
  }
  return silencios;
}

/**
 * Parte `duracionSeg` en trozos consecutivos. Cada corte cae en el medio del
 * silencio más cercano al objetivo dentro de [min, max]; sin silencio, en el
 * objetivo. Cada trozo salvo el primero arranca `solapeSeg` antes de su corte.
 */
export function planearTrozos(
  duracionSeg: number,
  silencios: Silencio[],
  parametros: ParametrosTroceo = PARAMETROS_TROCEO,
): Trozo[] {
  const { objetivoSeg, minSeg, maxSeg, solapeSeg } = parametros;
  if (duracionSeg <= 0) return [];

  const medios = silencios.map((s) => (s.desdeSeg + s.hastaSeg) / 2);
  const trozos: Trozo[] = [];
  let cursor = 0;

  while (cursor < duracionSeg) {
    let fin: number;
    if (duracionSeg - cursor <= maxSeg) {
      fin = duracionSeg;
    } else {
      const meta = cursor + objetivoSeg;
      const candidatos = medios.filter((m) => m >= cursor + minSeg && m <= cursor + maxSeg);
      fin = candidatos.length
        ? candidatos.reduce((a, b) => (Math.abs(b - meta) < Math.abs(a - meta) ? b : a))
        : meta;
    }
    trozos.push({
      indice: trozos.length,
      desdeSeg: Math.max(0, cursor - (trozos.length ? solapeSeg : 0)),
      hastaSeg: fin,
      propioDesdeSeg: cursor,
    });
    cursor = fin;
  }
  return trozos;
}

/** Fracción (0-1) del tramo propio del trozo que cae dentro de silencios. */
export function fraccionSilencio(trozo: Trozo, silencios: Silencio[]): number {
  const largo = trozo.hastaSeg - trozo.propioDesdeSeg;
  if (largo <= 0) return 1;
  let cubierto = 0;
  for (const s of silencios) {
    const desde = Math.max(s.desdeSeg, trozo.propioDesdeSeg);
    const hasta = Math.min(s.hastaSeg, trozo.hastaSeg);
    if (hasta > desde) cubierto += hasta - desde;
  }
  return cubierto / largo;
}

export interface SegmentoApiTrozo {
  inicioS: number;
  finS: number;
  texto: string;
}

/**
 * Pasa los segmentos de un trozo (tiempos relativos al inicio del audio que se
 * mandó) al tiempo de la clase, y descarta los que caen enteros en el solape
 * porque ya los transcribió el trozo anterior.
 */
export function aTiempoGlobal(segmentos: SegmentoApiTrozo[], trozo: Trozo): Segmento[] {
  const largoMs = (trozo.hastaSeg - trozo.desdeSeg) * 1000;
  const salida: Segmento[] = [];
  for (const s of segmentos) {
    const texto = s.texto.trim();
    if (!texto) continue;
    const inicio = Math.min(Math.max(0, s.inicioS * 1000), largoMs);
    const fin = Math.min(Math.max(inicio, s.finS * 1000), largoMs);
    const desdeMs = Math.round(inicio + trozo.desdeSeg * 1000);
    const hastaMs = Math.round(fin + trozo.desdeSeg * 1000);
    // El punto medio decide quién es dueño del segmento: el del solape es del trozo anterior.
    if ((desdeMs + hastaMs) / 2 < trozo.propioDesdeSeg * 1000) continue;
    salida.push({ desdeMs, hastaMs, texto });
  }
  return salida;
}

/** Un solo segmento que cubre el trozo, para cuando el proveedor no devuelve tiempos. */
export function segmentoDeTrozo(texto: string, trozo: Trozo): Segmento[] {
  const limpio = texto.trim();
  if (!limpio) return [];
  return [
    {
      desdeMs: Math.round(trozo.propioDesdeSeg * 1000),
      hastaMs: Math.round(trozo.hastaSeg * 1000),
      texto: limpio,
    },
  ];
}

const normalizar = (palabra: string) => palabra.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** Palabras con su forma normalizada; las que quedan vacías (guiones, signos) no cuentan. */
function palabrasDe(texto: string): { original: string; norma: string }[] {
  return texto
    .split(/\s+/)
    .filter(Boolean)
    .map((original) => ({ original, norma: normalizar(original) }));
}

const MAX_PALABRAS_UNION = 30;
const MIN_PALABRAS_UNION = 3;
/** Un repetido real aparece pegado al final del trozo anterior. */
const MARGEN_UNION_MS = 3000;

/**
 * Quita del inicio de `nuevos` las palabras que ya cierran `previos`: el
 * solape hace que Whisper repita en cada unión lo que dijo al final del trozo
 * anterior. Busca la coincidencia más larga entre el final de lo previo y el
 * inicio de lo nuevo (mínimo 3 palabras, para no borrar un "sí, sí" legítimo).
 * No toca los tiempos de lo que se queda.
 */
export function deduplicarUnion(previos: Segmento[], nuevos: Segmento[]): Segmento[] {
  if (previos.length === 0 || nuevos.length === 0) return nuevos;
  const ultimo = previos[previos.length - 1];
  if (nuevos[0].desdeMs > ultimo.hastaMs + MARGEN_UNION_MS) return nuevos;

  const cola: string[] = [];
  for (let i = previos.length - 1; i >= 0 && cola.length < MAX_PALABRAS_UNION; i--) {
    const normas = palabrasDe(previos[i].texto).map((p) => p.norma).filter(Boolean);
    cola.unshift(...normas);
  }
  const cabeza: string[] = [];
  for (let i = 0; i < nuevos.length && cabeza.length < MAX_PALABRAS_UNION; i++) {
    cabeza.push(...palabrasDe(nuevos[i].texto).map((p) => p.norma).filter(Boolean));
  }

  let repetidas = 0;
  for (let k = Math.min(cola.length, cabeza.length, MAX_PALABRAS_UNION); k >= MIN_PALABRAS_UNION; k--) {
    if (cola.slice(-k).every((p, i) => p === cabeza[i])) {
      repetidas = k;
      break;
    }
  }
  if (repetidas === 0) return nuevos;

  const salida: Segmento[] = [];
  let porQuitar = repetidas;
  for (const s of nuevos) {
    if (porQuitar === 0) {
      salida.push(s);
      continue;
    }
    const palabras = palabrasDe(s.texto);
    let corte = 0;
    while (corte < palabras.length && porQuitar > 0) {
      if (palabras[corte].norma) porQuitar--;
      corte++;
    }
    const resto = palabras.slice(corte).map((p) => p.original).join(" ");
    if (resto) salida.push({ ...s, texto: resto });
  }
  return salida;
}

/**
 * Frases que Whisper inventa sobre ruido o silencio (vienen de los subtítulos
 * con que se entrenó). Se comparan contra el segmento entero, sin puntuación.
 */
const FRASES_ALUCINADAS = [
  /^(muchas )?gracias( por (ver|vernos|su atenci[oó]n)( el v[ií]deo)?)?$/,
  /^gracias a todos$/,
  /^suscr[ií]bete.*/,
  /^subt[ií]tulos? .*/,
  /^cc por .*/,
  /^m[uú]sica$/,
  /^adi[oó]s$/,
];

const REPETICIONES_BUCLE = 4;

/**
 * Colapsa una frase de 1 a 6 palabras repetida 4 o más veces seguidas en una sola
 * («a la presidencia, a la presidencia, …» ×9 → una vez). Con 3 repeticiones no
 * se toca: un profesor que dicta «menos 0,1, menos 0,1, menos 0,1» es legítimo.
 */
export function colapsarBucles(texto: string): string {
  const palabras = palabrasDe(texto);
  const salida: typeof palabras = [];
  let i = 0;
  while (i < palabras.length) {
    let colapsado = false;
    for (let n = 1; n <= 6 && !colapsado; n++) {
      const frase = palabras.slice(i, i + n).map((p) => p.norma);
      if (frase.length < n || frase.every((p) => !p)) continue;
      let veces = 1;
      while (palabras.slice(i + veces * n, i + (veces + 1) * n).map((p) => p.norma).join(" ") === frase.join(" ") && i + (veces + 1) * n <= palabras.length) veces++;
      if (veces >= REPETICIONES_BUCLE) {
        salida.push(...palabras.slice(i, i + n));
        i += veces * n;
        colapsado = true;
      }
    }
    if (!colapsado) salida.push(palabras[i++]);
  }
  return salida.map((p) => p.original).join(" ");
}

/**
 * Descarta lo que casi seguro no dijo nadie: frases de relleno sueltas, un
 * segmento idéntico al anterior, y segmentos en bucle (muchas palabras, muy
 * pocas distintas). Es una mitigación, no un VAD: lo que sí se dijo y Whisper
 * entendió mal no se arregla acá. Un «gracias» real y aislado también cae.
 */
export function filtrarAlucinaciones(segmentos: Segmento[]): { segmentos: Segmento[]; descartados: number } {
  const salida: Segmento[] = [];
  let anterior = "";
  for (const original of segmentos) {
    const s = { ...original, texto: colapsarBucles(original.texto) };
    // El bucle se mide sobre el texto original: colapsado ya no lo parece.
    const palabras = palabrasDe(original.texto).map((p) => p.norma).filter(Boolean);
    const plano = s.texto.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
    const igualAlAnterior = plano !== "" && plano === anterior;
    const enBucle = palabras.length >= 12 && new Set(palabras).size / palabras.length < 0.3;
    const relleno = FRASES_ALUCINADAS.some((r) => r.test(plano));
    if (igualAlAnterior || enBucle || relleno) continue;
    anterior = plano;
    salida.push(s);
  }
  return { segmentos: salida, descartados: segmentos.length - salida.length };
}

/**
 * Corre `fn` sobre cada elemento con como mucho `limite` a la vez. Nunca
 * rechaza: cada resultado dice si salió bien, y el orden es el de `items`.
 */
export async function mapConcurrente<T, R>(
  items: T[],
  limite: number,
  fn: (item: T, indice: number) => Promise<R>,
): Promise<({ ok: true; valor: R } | { ok: false; error: unknown })[]> {
  const salida: ({ ok: true; valor: R } | { ok: false; error: unknown })[] = new Array(items.length);
  let siguiente = 0;
  const trabajador = async () => {
    while (siguiente < items.length) {
      const i = siguiente++;
      try {
        salida[i] = { ok: true, valor: await fn(items[i], i) };
      } catch (error) {
        salida[i] = { ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limite), items.length) }, trabajador));
  return salida;
}
