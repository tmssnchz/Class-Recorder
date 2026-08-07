/**
 * Exportación de transcripciones a PDF y Word.
 *
 * Ambas librerías generan el archivo en memoria dentro de la propia app: no hay
 * servicios externos ni conversores en la nube.
 */
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { jsPDF } from "jspdf";
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";

import { formatearDuracion, formatearFechaLarga, formatearHora } from "./format";
import { armarTexto } from "./transcripcion";
import type { Grabacion, Segmento } from "../types";

export type FormatoExportacion = "pdf" | "docx" | "md";

interface Opciones {
  /** Antepone [mm:ss] a cada segmento en vez de exportar texto corrido. */
  conTiempos?: boolean;
}

function encabezado(g: Grabacion): { titulo: string; lineas: string[] } {
  return {
    titulo: `${g.claseNombre} — ${g.unidadNombre}`,
    lineas: [
      `Fecha: ${formatearFechaLarga(g.fechaISO)} a las ${formatearHora(g.fechaISO)}`,
      `Duración: ${formatearDuracion(g.duracionSeg)}`,
      ...(g.tags.length > 0 ? [`Etiquetas: ${g.tags.join(", ")}`] : []),
    ],
  };
}

/** Párrafos del cuerpo, con o sin marcas de tiempo. */
function cuerpo(segmentos: Segmento[], conTiempos: boolean): string[] {
  if (!conTiempos) return armarTexto(segmentos).split("\n\n");
  return segmentos.map(
    (s) => `[${formatearDuracion(s.desdeMs / 1000)}] ${s.texto}`,
  );
}

function lineasDeMarcas(g: Grabacion): string[] {
  if (g.marcas.length === 0) return [];
  return [...g.marcas]
    .sort((a, b) => a.segundo - b.segundo)
    .map(
      (m) =>
        `${formatearDuracion(m.segundo)}${m.nota ? ` — ${m.nota}` : ""}`,
    );
}

async function generarPdf(
  g: Grabacion,
  segmentos: Segmento[],
  opciones: Opciones,
): Promise<Uint8Array> {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const margen = 20;
  const anchoUtil = doc.internal.pageSize.getWidth() - margen * 2;
  const altoPagina = doc.internal.pageSize.getHeight();
  let y = margen;

  const salto = (alto: number) => {
    if (y + alto > altoPagina - margen) {
      doc.addPage();
      y = margen;
    }
  };

  const { titulo, lineas } = encabezado(g);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  for (const linea of doc.splitTextToSize(titulo, anchoUtil)) {
    salto(8);
    doc.text(linea, margen, y);
    y += 7;
  }

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(110);
  for (const linea of lineas) {
    salto(6);
    doc.text(linea, margen, y);
    y += 5;
  }

  const marcas = lineasDeMarcas(g);
  if (marcas.length > 0) {
    y += 3;
    doc.setFont("helvetica", "bold");
    salto(6);
    doc.text("Momentos marcados", margen, y);
    y += 5;
    doc.setFont("helvetica", "normal");
    for (const linea of marcas) {
      for (const trozo of doc.splitTextToSize(linea, anchoUtil - 4)) {
        salto(5);
        doc.text(trozo, margen + 4, y);
        y += 4.5;
      }
    }
  }

  y += 6;
  doc.setTextColor(20);
  doc.setFontSize(11);
  for (const parrafo of cuerpo(segmentos, opciones.conTiempos ?? false)) {
    for (const linea of doc.splitTextToSize(parrafo, anchoUtil)) {
      salto(6);
      doc.text(linea, margen, y);
      y += 5.2;
    }
    y += 3;
  }

  return new Uint8Array(doc.output("arraybuffer"));
}

/**
 * Markdown pensado para pegar en una IA o en un centro de estudios: encabezado
 * con el contexto de la clase y el cuerpo partido en secciones por marca de
 * tiempo, para poder citar "lo que dijo en el minuto tal".
 *
 * Los segmentos que devuelve whisper duran unos pocos segundos cada uno; se
 * agrupan en bloques de varios minutos para que el .md tenga secciones útiles
 * y no cientos de títulos de una línea.
 */
const MINUTOS_POR_SECCION = 5;

function generarMarkdown(g: Grabacion, segmentos: Segmento[]): string {
  const lineas: string[] = [
    `# ${g.claseNombre} — ${g.unidadNombre}`,
    "",
    `- **Fecha:** ${formatearFechaLarga(g.fechaISO)}, ${formatearHora(g.fechaISO)}`,
    `- **Duración:** ${formatearDuracion(g.duracionSeg)}`,
  ];
  if (g.tags.length > 0) {
    lineas.push(`- **Etiquetas:** ${g.tags.join(", ")}`);
  }

  const marcas = lineasDeMarcas(g);
  if (marcas.length > 0) {
    lineas.push("", "## Momentos marcados", "");
    for (const m of marcas) lineas.push(`- ${m}`);
  }

  lineas.push("", "## Transcripción", "");

  const ventanaMs = MINUTOS_POR_SECCION * 60_000;
  let seccionActual = -1;
  let parrafo: string[] = [];

  const cerrarParrafo = () => {
    if (parrafo.length > 0) {
      lineas.push(parrafo.join(" "), "");
      parrafo = [];
    }
  };

  for (const s of segmentos) {
    const seccion = Math.floor(s.desdeMs / ventanaMs);
    if (seccion !== seccionActual) {
      cerrarParrafo();
      seccionActual = seccion;
      // El título usa el inicio real del primer segmento de la sección, no el
      // múltiplo exacto: así el timestamp coincide con el audio.
      lineas.push(`### ${formatearDuracion(s.desdeMs / 1000)}`, "");
    }
    const texto = s.texto.trim();
    if (texto) parrafo.push(texto);
  }
  cerrarParrafo();

  return lineas.join("\n");
}

async function generarDocx(
  g: Grabacion,
  segmentos: Segmento[],
  opciones: Opciones,
): Promise<Uint8Array> {
  const { titulo, lineas } = encabezado(g);
  const marcas = lineasDeMarcas(g);

  const hijos: Paragraph[] = [
    new Paragraph({
      text: titulo,
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.LEFT,
    }),
    ...lineas.map(
      (linea) =>
        new Paragraph({
          children: [new TextRun({ text: linea, color: "666666", size: 20 })],
        }),
    ),
  ];

  if (marcas.length > 0) {
    hijos.push(
      new Paragraph({ text: "Momentos marcados", heading: HeadingLevel.HEADING_2 }),
    );
    for (const linea of marcas) {
      hijos.push(new Paragraph({ text: linea, bullet: { level: 0 } }));
    }
  }

  hijos.push(
    new Paragraph({ text: "Transcripción", heading: HeadingLevel.HEADING_2 }),
  );
  for (const parrafo of cuerpo(segmentos, opciones.conTiempos ?? false)) {
    hijos.push(new Paragraph({ text: parrafo, spacing: { after: 160 } }));
  }

  const documento = new Document({ sections: [{ children: hijos }] });
  const blob = await Packer.toBlob(documento);
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Pregunta dónde guardar y escribe el archivo.
 * Devuelve la ruta elegida, o null si se canceló el diálogo.
 */
export async function exportarTranscripcion(
  grabacion: Grabacion,
  segmentos: Segmento[],
  formato: FormatoExportacion,
  opciones: Opciones = {},
): Promise<string | null> {
  if (segmentos.length === 0) {
    throw new Error("No hay transcripción para exportar.");
  }

  const filtros: Record<FormatoExportacion, { name: string; extensions: string[] }> =
    {
      pdf: { name: "PDF", extensions: ["pdf"] },
      docx: { name: "Documento de Word", extensions: ["docx"] },
      md: { name: "Markdown", extensions: ["md"] },
    };

  const destino = await save({
    title: "Guardar transcripción",
    defaultPath: `${grabacion.carpeta}\\${grabacion.titulo}.${formato}`,
    filters: [filtros[formato]],
  });
  if (!destino) return null;

  if (formato === "md") {
    await writeTextFile(destino, generarMarkdown(grabacion, segmentos));
    return destino;
  }

  const bytes =
    formato === "pdf"
      ? await generarPdf(grabacion, segmentos, opciones)
      : await generarDocx(grabacion, segmentos, opciones);

  await writeFile(destino, bytes);
  return destino;
}
