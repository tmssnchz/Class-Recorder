/**
 * Exportación de un apunte digitalizado.
 *
 * La exportación que ya existía es por grabación y solo lleva la
 * transcripción, así que un apunte no entra ahí: se exporta aparte, con sus
 * hojas y el texto reconocido de cada una.
 *
 * El PDF lleva la imagen y el texto porque las dos cosas importan: la hoja es
 * la fuente de verdad (sobre todo donde hay diagramas) y el texto es lo que
 * se puede copiar y pegar en otro lado.
 */
import { save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { jsPDF } from "jspdf";

import { formatearFechaLarga } from "./format";
import { nombreArchivo, sanitizarNombre } from "./paths";
import type { Apunte } from "../types";

export type FormatoApunte = "pdf" | "md";

async function comoDataUri(ruta: string): Promise<string> {
  const bytes = await readFile(ruta);
  let binario = "";
  // De a trozos: `String.fromCharCode(...bytes)` con una hoja de varios MB
  // revienta el límite de argumentos del intérprete.
  for (let i = 0; i < bytes.length; i += 8192) {
    binario += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return `data:image/jpeg;base64,${btoa(binario)}`;
}

async function generarPdf(apunte: Apunte): Promise<Uint8Array> {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const margen = 15;
  const ancho = doc.internal.pageSize.getWidth() - margen * 2;
  const alto = doc.internal.pageSize.getHeight();

  doc.setFontSize(16);
  doc.text(apunte.titulo, margen, margen + 4);
  doc.setFontSize(10);
  doc.setTextColor(110);
  doc.text(
    `${apunte.claseNombre} — ${apunte.unidadNombre} · ${formatearFechaLarga(apunte.fechaISO)}`,
    margen,
    margen + 11,
  );
  doc.setTextColor(0);

  const paginas = [...apunte.paginas].sort((a, b) => a.numero - b.numero);
  for (const pagina of paginas) {
    doc.addPage();
    // Se respeta la proporción real de la hoja: deformarla haría ilegible la
    // letra chica, que es justo lo que uno va a mirar en el PDF.
    const escala = Math.min(ancho / pagina.ancho, (alto - margen * 2) / pagina.alto);
    const w = pagina.ancho * escala;
    const h = pagina.alto * escala;
    doc.addImage(await comoDataUri(pagina.archivo), "JPEG", margen, margen, w, h);

    const texto = pagina.texto.trim();
    if (texto) {
      doc.addPage();
      doc.setFontSize(9);
      doc.setTextColor(110);
      doc.text(`Página ${pagina.numero} — texto reconocido`, margen, margen);
      doc.setTextColor(0);
      doc.setFontSize(11);
      let y = margen + 8;
      for (const linea of doc.splitTextToSize(texto, ancho) as string[]) {
        if (y > alto - margen) {
          doc.addPage();
          y = margen;
        }
        doc.text(linea, margen, y);
        y += 6;
      }
    }
  }

  return new Uint8Array(doc.output("arraybuffer"));
}

/**
 * Markdown con el texto y las imágenes referenciadas por ruta relativa. Sirve
 * para pegar en un centro de estudios o dárselo a un LLM, que es para lo que
 * ya se usa la exportación de transcripciones.
 */
function generarMarkdown(apunte: Apunte): string {
  const partes = [
    `# ${apunte.titulo}`,
    "",
    `${apunte.claseNombre} — ${apunte.unidadNombre}`,
    `${formatearFechaLarga(apunte.fechaISO)}`,
    "",
    "> Texto reconocido automáticamente a partir de fotos de apuntes escritos" +
      " a mano. Puede tener errores.",
    "",
  ];

  for (const pagina of [...apunte.paginas].sort((a, b) => a.numero - b.numero)) {
    partes.push(`## Página ${pagina.numero}`, "");
    partes.push(`![Página ${pagina.numero}](${nombreArchivo(pagina.archivo)})`, "");
    if (pagina.soloVisual && !pagina.texto.trim()) {
      partes.push("_Contenido visual: diagrama o esquema, sin texto para transcribir._", "");
    } else if (pagina.texto.trim()) {
      partes.push(pagina.texto.trim(), "");
    }
  }

  return partes.join("\n");
}

/** Pregunta dónde guardar y escribe el archivo. Devuelve la ruta, o null. */
export async function exportarApunte(
  apunte: Apunte,
  formato: FormatoApunte,
): Promise<string | null> {
  const base = sanitizarNombre(apunte.titulo);
  const destino = await save({
    defaultPath: `${base}.${formato}`,
    filters: [{ name: formato.toUpperCase(), extensions: [formato] }],
  });
  if (!destino) return null;

  if (formato === "md") {
    await writeTextFile(destino, generarMarkdown(apunte));
  } else {
    await writeFile(destino, await generarPdf(apunte));
  }
  return destino;
}
