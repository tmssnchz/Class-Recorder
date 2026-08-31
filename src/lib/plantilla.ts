/**
 * Plantilla imprimible con los cuatro marcadores QR.
 *
 * El PDF se arma con jsPDF, que ya se usa para exportar clases, y los QR los
 * genera Rust (`generar_qr_png`) porque es el mismo código que después los
 * lee: si alguna vez cambia el formato del payload, cambia en un solo lado.
 *
 * Nada de la geometría está fijo acá: el tamaño de papel y el lado del
 * anillado vienen de la config y viajan dentro del QR, así que agregar A5 o
 * cualquier otro formato es agregar una línea a `PAPELES`.
 */
import { jsPDF } from "jspdf";

import { generarMarcadorPng, generarQrPng } from "./escaneo.ts";
import type { GeometriaPlantilla, LadoAnillado } from "../types.ts";

export interface Papel {
  id: string;
  nombre: string;
  anchoMm: number;
  altoMm: number;
  /** Margen de anillado sugerido para este tamaño. El usuario puede cambiarlo. */
  anilladoMm: number;
}

export const PAPELES: Papel[] = [
  { id: "b5", nombre: "B5 ISO (176 × 250 mm)", anchoMm: 176, altoMm: 250, anilladoMm: 18 },
  // Los recambios de binder que se venden en Chile como "B5" o "universitario"
  // suelen medir 173 × 250, que no es ningún B5 normalizado. Va como preset
  // propio porque es el caso real de este proyecto.
  { id: "b5-cl", nombre: "Universitario (173 × 250 mm)", anchoMm: 173, altoMm: 250, anilladoMm: 18 },
  { id: "b5-jis", nombre: "B5 JIS (182 × 257 mm)", anchoMm: 182, altoMm: 257, anilladoMm: 18 },
  { id: "a4", nombre: "A4 (210 × 297 mm)", anchoMm: 210, altoMm: 297, anilladoMm: 20 },
  { id: "carta", nombre: "Carta (216 × 279 mm)", anchoMm: 216, altoMm: 279, anilladoMm: 20 },
  { id: "a5", nombre: "A5 (148 × 210 mm)", anchoMm: 148, altoMm: 210, anilladoMm: 15 },
];

/**
 * Unidad en la que el usuario escribe las medidas.
 *
 * Solo afecta a lo que se teclea: adentro todo se guarda y se transmite en
 * milímetros, incluido el payload del QR. Tener una sola unidad en el modelo
 * evita que un redondeo de ida y vuelta corra la geometría sin que se note.
 */
export type Unidad = "mm" | "cm" | "in";

export const UNIDADES: {
  id: Unidad;
  nombre: string;
  /** Cuántos milímetros vale una unidad. */
  mm: number;
  paso: number;
  decimales: number;
}[] = [
  { id: "mm", nombre: "milímetros", mm: 1, paso: 1, decimales: 1 },
  { id: "cm", nombre: "centímetros", mm: 10, paso: 0.1, decimales: 2 },
  { id: "in", nombre: "pulgadas", mm: 25.4, paso: 0.05, decimales: 3 },
];

function factor(u: Unidad): number {
  return UNIDADES.find((x) => x.id === u)?.mm ?? 1;
}

/**
 * Pasa a milímetros lo que el usuario escribió.
 *
 * Se redondea a un decimal porque es lo que sabe transportar el QR, y porque
 * ninguna impresora doméstica distingue menos que eso. Sin el redondeo, una
 * medida en pulgadas dejaría un `215.90000000000003` dentro del código.
 */
export function aMm(valor: number, u: Unidad): number {
  return Math.round(valor * factor(u) * 10) / 10;
}

/** Inverso de `aMm`, para mostrar en el campo. */
export function desdeMm(mm: number, u: Unidad): number {
  const info = UNIDADES.find((x) => x.id === u) ?? UNIDADES[0];
  const v = mm / info.mm;
  const p = 10 ** info.decimales;
  return Math.round(v * p) / p;
}

/** Id que usa el selector cuando las medidas no coinciden con ningún preset. */
export const PAPEL_PERSONALIZADO = "personalizado";

/**
 * Preset que corresponde a una geometría, o `null` si el usuario escribió
 * medidas propias. Devolver `null` importa: si esto cayera al primer preset,
 * el selector mostraría "B5 ISO" mientras se imprime otra cosa.
 */
export function papelDe(g: GeometriaPlantilla): Papel | null {
  return PAPELES.find((p) => p.anchoMm === g.anchoMm && p.altoMm === g.altoMm) ?? null;
}

/**
 * Qué le impide a esta geometría ser imprimible, o `null` si está bien.
 *
 * Con una hoja angosta y un margen de anillado grande, el área de escritura se
 * puede volver negativa y los QR de los dos lados se pisan entre sí. Vale la
 * pena avisar antes de gastar tinta.
 */
export function problemaDeGeometria(g: GeometriaPlantilla): string | null {
  if (g.anchoMm < 80 || g.altoMm < 80) {
    return "La hoja es demasiado chica: el mínimo razonable son 80 × 80 mm.";
  }
  if (g.anchoMm > 420 || g.altoMm > 594) {
    return "La hoja es más grande que un A2. Revisa las medidas.";
  }
  const area = areaEscribibleMm(g);
  if (area.ancho <= 20 || area.alto <= 20) {
    return (
      "Con esas medidas y ese margen de anillado no queda hoja para escribir: " +
      "los marcadores ocupan casi todo. Achica el margen o usa una hoja más grande."
    );
  }
  return null;
}

export const LADOS: { id: LadoAnillado; nombre: string }[] = [
  { id: "izquierda", nombre: "Izquierda" },
  { id: "derecha", nombre: "Derecha" },
  { id: "arriba", nombre: "Arriba" },
];

/**
 * Espacio que la plantilla le reserva a cada marcador. De acá salen los
 * centros, así que tiene que seguir coincidiendo con `LADO_QR_MM` en Rust.
 */
export const LADO_QR_MM = 14;

/**
 * Lado del cuadrado de tinta de cada marcador de esquina. Son 7 celdas ArUco,
 * o sea 1,43 mm por celda: tres veces y media más grueso que un módulo de QR
 * del mismo tamaño, que es lo que aguanta una impresión pobre.
 */
export const LADO_MARCADOR_MM = 10;

/** Lado del QR de geometría que va abajo al centro. */
export const LADO_QR_GEOMETRIA_MM = 12;
/** Separación entre el borde del papel y el borde del QR. */
export const MARGEN_BORDE_MM = 8;

/**
 * Centro de cada QR en milímetros: 0 = arriba izquierda, 1 = arriba derecha,
 * 2 = abajo derecha, 3 = abajo izquierda.
 *
 * Es la misma cuenta que hace `GeometriaPlantilla::centros_qr_mm` en Rust, y
 * tiene que seguir siéndolo: si las dos se separan, la homografía sale
 * desplazada y el escaneo queda torcido sin dar ningún error.
 */
export function centrosQrMm(g: GeometriaPlantilla): [number, number][] {
  const c = MARGEN_BORDE_MM + LADO_QR_MM / 2;
  const izq = c + (g.ladoAnillado === "izquierda" ? g.margenAnilladoMm : 0);
  const der = g.anchoMm - c - (g.ladoAnillado === "derecha" ? g.margenAnilladoMm : 0);
  const arr = c + (g.ladoAnillado === "arriba" ? g.margenAnilladoMm : 0);
  const aba = g.altoMm - c;
  return [
    [izq, arr],
    [der, arr],
    [der, aba],
    [izq, aba],
  ];
}

/**
 * Geometría de la cara de atrás de la misma hoja física.
 *
 * Los agujeros del anillado están en un borde del papel, no de la cara: al dar
 * vuelta la hoja pasan al borde opuesto. Si el reverso se imprimiera con la
 * misma geometría que el frente, el margen quedaría del lado equivocado y dos
 * de los QR caerían justo encima de la perforación.
 *
 * Con el anillado arriba no cambia nada, porque el volteo normal del dúplex
 * manual es sobre el eje vertical (como pasar la hoja de un libro) y ese eje
 * deja el borde superior donde estaba.
 */
export function caraReverso(g: GeometriaPlantilla): GeometriaPlantilla {
  if (g.ladoAnillado === "arriba") return g;
  return {
    ...g,
    ladoAnillado: g.ladoAnillado === "izquierda" ? "derecha" : "izquierda",
  };
}

/**
 * Geometría que le toca a una página según su número: las impares son la cara
 * de adelante de una hoja y las pares el reverso de esa misma hoja.
 */
export function geometriaDePagina(g: GeometriaPlantilla, pagina: number): GeometriaPlantilla {
  return pagina % 2 === 0 ? caraReverso(g) : g;
}

/** Área utilizable para escribir, ya descontado el anillado y los marcadores. */
export function areaEscribibleMm(g: GeometriaPlantilla) {
  const borde = MARGEN_BORDE_MM + LADO_QR_MM + 4;
  return {
    x: borde + (g.ladoAnillado === "izquierda" ? g.margenAnilladoMm : 0),
    y: borde + (g.ladoAnillado === "arriba" ? g.margenAnilladoMm : 0),
    ancho:
      g.anchoMm -
      borde * 2 -
      (g.ladoAnillado === "izquierda" || g.ladoAnillado === "derecha" ? g.margenAnilladoMm : 0),
    alto: g.altoMm - borde * 2 - (g.ladoAnillado === "arriba" ? g.margenAnilladoMm : 0),
  };
}

function nuevoDocumento(g: GeometriaPlantilla): jsPDF {
  return new jsPDF({
    unit: "mm",
    format: [g.anchoMm, g.altoMm],
    orientation: g.altoMm >= g.anchoMm ? "portrait" : "landscape",
  });
}

/**
 * Dibuja los cuatro QR y el número de página de una cara.
 *
 * `g` es la geometría **de esta cara**, no la del papel: quien llama decide si
 * es un frente o un reverso. Los QR se generan con esa geometría, así que cada
 * cara lleva codificado su propio lado de anillado y el escaneo la corrige
 * sola, sin preguntar nada ni saber por qué cara va.
 */
async function dibujarHoja(
  doc: jsPDF,
  g: GeometriaPlantilla,
  pagina: number,
  numerar: boolean,
): Promise<void> {
  // Cuatro marcadores ArUco en las esquinas: geometría y número de página.
  const centros = centrosQrMm(g);
  for (let esquina = 0; esquina < 4; esquina++) {
    // 350 px para 7 celdas son 50 px por celda: sobra para que la impresora no
    // redondee el borde de ninguna.
    const base64 = await generarMarcadorPng(pagina, esquina, 350);
    const [cx, cy] = centros[esquina];
    doc.addImage(
      `data:image/png;base64,${base64}`,
      "PNG",
      cx - LADO_MARCADOR_MM / 2,
      cy - LADO_MARCADOR_MM / 2,
      LADO_MARCADOR_MM,
      LADO_MARCADOR_MM,
    );
  }

  // Y un QR abajo al centro con el tamaño de papel, que un id de marcador no
  // puede transportar. No participa de la homografía: si no se lee, el escaneo
  // usa el papel configurado y avisa.
  const geometriaQr = await generarQrPng(g, 0, pagina, 400);
  doc.addImage(
    `data:image/png;base64,${geometriaQr}`,
    "PNG",
    g.anchoMm / 2 - LADO_QR_GEOMETRIA_MM / 2,
    g.altoMm - MARGEN_BORDE_MM - LADO_QR_GEOMETRIA_MM - 4,
    LADO_QR_GEOMETRIA_MM,
    LADO_QR_GEOMETRIA_MM,
  );

  // Ya no se dibuja el recuadro del área utilizable: sugería un límite que no
  // existe, porque el escaneo recorta la hoja entera y no ese rectángulo.
  if (numerar) {
    doc.setFontSize(8);
    doc.setTextColor(150);
    doc.text(`${pagina}`, g.anchoMm / 2, g.altoMm - 4, { align: "center" });
    doc.setTextColor(0);
  }
}

/**
 * PDF de `hojas` páginas numeradas correlativamente, listo para imprimir a una
 * sola cara.
 *
 * Todas son frentes: si se imprime a una cara, cada página cae en una hoja
 * distinta y ninguna es el reverso de otra.
 */
export async function generarPlantilla(
  g: GeometriaPlantilla,
  hojas: number,
  numerar = true,
  desde = 1,
): Promise<Uint8Array> {
  const doc = nuevoDocumento(g);
  for (let i = 0; i < hojas; i++) {
    if (i > 0) doc.addPage([g.anchoMm, g.altoMm]);
    await dibujarHoja(doc, g, desde + i, numerar);
  }
  return new Uint8Array(doc.output("arraybuffer"));
}

/**
 * Orden de impresión del reverso cuando la impresora no hace dúplex sola.
 *
 * Al dar vuelta la pila, la última hoja impresa queda arriba: el reverso hay
 * que mandarlo al revés o cada cara B cae en la hoja equivocada. Qué extremo
 * queda arriba depende de si la impresora expulsa boca arriba o boca abajo,
 * y eso cambia de un modelo a otro — por eso es un ajuste calibrable y no una
 * constante.
 */
export function ordenReverso(paginas: number[], enOrdenInverso: boolean): number[] {
  return enOrdenInverso ? [...paginas].reverse() : [...paginas];
}

/**
 * Reparte las hojas en las dos tandas del dúplex manual.
 *
 * Las páginas impares son la cara A y las pares la cara B de la misma hoja
 * física, así que se imprimen en dos pasadas con un volteo en el medio.
 */
export function planDuplexManual(
  totalPaginas: number,
  enOrdenInverso: boolean,
): { frente: number[]; reverso: number[] } {
  const todas = Array.from({ length: totalPaginas }, (_, i) => i + 1);
  const frente = todas.filter((n) => n % 2 === 1);
  const reverso = todas.filter((n) => n % 2 === 0);
  return { frente, reverso: ordenReverso(reverso, enOrdenInverso) };
}

/**
 * PDF de la tanda indicada: solo las páginas de esa lista, en ese orden.
 *
 * Acá sí importa la paridad: las páginas pares son el reverso de una hoja que
 * ya tiene su frente impreso, así que llevan el margen de anillado del borde
 * opuesto (ver `caraReverso`).
 */
export async function generarTanda(
  g: GeometriaPlantilla,
  paginas: number[],
  numerar = true,
): Promise<Uint8Array> {
  const doc = nuevoDocumento(g);
  for (let i = 0; i < paginas.length; i++) {
    if (i > 0) doc.addPage([g.anchoMm, g.altoMm]);
    await dibujarHoja(doc, geometriaDePagina(g, paginas[i]), paginas[i], numerar);
  }
  return new Uint8Array(doc.output("arraybuffer"));
}

/**
 * Hoja de calibración: una "A" enorme de un lado y una "B" del otro.
 *
 * Sirve para averiguar de una sola vez, con una hoja, si esta impresora
 * expulsa el papel boca arriba o boca abajo. Sin esto el usuario descubre la
 * orientación equivocada recién después de imprimir cuarenta hojas.
 */
export function generarHojaDePrueba(g: GeometriaPlantilla): Uint8Array {
  const doc = nuevoDocumento(g);

  const cara = (letra: string, instruccion: string) => {
    doc.setFontSize(200);
    doc.text(letra, g.anchoMm / 2, g.altoMm / 2, { align: "center", baseline: "middle" });
    doc.setFontSize(11);
    doc.text(instruccion, g.anchoMm / 2, g.altoMm - 25, {
      align: "center",
      maxWidth: g.anchoMm - 30,
    });
  };

  cara(
    "A",
    "Imprime esta página (la 1). Después da vuelta la hoja, ponla de nuevo en la bandeja e imprime la página 2.",
  );
  doc.addPage([g.anchoMm, g.altoMm]);
  cara(
    "B",
    "Si la B quedó del otro lado y derecha, la orientación es la correcta. Si quedó de cabeza o en la misma cara que la A, cambia el ajuste de volteo en Configuración › Apuntes.",
  );

  return new Uint8Array(doc.output("arraybuffer"));
}
