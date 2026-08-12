/**
 * Test del material de estudio.
 *
 * Cubre lo que se rompe en silencio: que el material de cada nivel (clase,
 * unidad, grabación) no se mezcle con el de los otros, y que las rutas de
 * carpeta salgan donde corresponde.
 */
import assert from "node:assert/strict";

import { carpetaMateriales, materialesVisiblesDe, tipoDe } from "./materiales.ts";

const material = (id, { claseId = null, unidadId = null, grabacionId = null }) => ({
  id,
  nombre: `${id}.pdf`,
  archivo: `C:/x/${id}.pdf`,
  bytes: 100,
  agregadoEn: "2026-01-01T00:00:00.000Z",
  claseId,
  unidadId,
  grabacionId,
});

const grabacion = {
  id: "g1",
  claseId: "c1",
  unidadId: "u1",
  claseNombre: "Micro",
  unidadNombre: "Unidad 1",
  titulo: "t",
  archivoAudio: "C:/x.mp3",
  carpeta: "C:/",
  fechaISO: "2026-01-01T00:00:00.000Z",
  duracionSeg: 60,
  formato: "mp3",
  bytes: 1,
  estado: "listo",
  errorConversion: null,
  tags: [],
  marcas: [],
  transcripcion: null,
};

// --- cada nivel ve solo lo suyo, sin mezclarse --------------------------
{
  const todos = [
    material("propio", { grabacionId: "g1" }),
    material("otraGrab", { grabacionId: "g2" }),
    material("deUnidad", { unidadId: "u1" }),
    material("otraUnidad", { unidadId: "u9" }),
    material("deClase", { claseId: "c1" }),
    material("otraClase", { claseId: "c9" }),
  ];
  const v = materialesVisiblesDe(todos, grabacion);
  assert.deepEqual(v.propios.map((m) => m.id), ["propio"]);
  assert.deepEqual(v.unidad.map((m) => m.id), ["deUnidad"]);
  assert.deepEqual(v.clase.map((m) => m.id), ["deClase"]);
}

// --- grabación sin clase ni unidad no hereda nada -----------------------
{
  const suelta = { ...grabacion, claseId: null, unidadId: null };
  const v = materialesVisiblesDe(
    [material("deClase", { claseId: "c1" }), material("deUnidad", { unidadId: "u1" })],
    suelta,
  );
  assert.equal(v.unidad.length, 0);
  assert.equal(v.clase.length, 0);
}

// --- rutas de carpeta ---------------------------------------------------
{
  assert.equal(
    carpetaMateriales("C:\\raiz", "Micro", null),
    "C:\\raiz\\Micro\\materiales",
    "material de clase va bajo la clase",
  );
  assert.equal(
    carpetaMateriales("C:\\raiz", "Micro", "Unidad 1"),
    "C:\\raiz\\Micro\\Unidad 1\\materiales",
    "material de unidad va bajo la unidad",
  );
  // Nombres con caracteres que Windows no admite se sanitizan igual que las
  // carpetas de grabaciones, si no la ruta sería inválida.
  assert.equal(
    carpetaMateriales("C:\\raiz", "Derecho: Parte I", null),
    "C:\\raiz\\Derecho- Parte I\\materiales",
  );
}

// --- tipo por extensión -------------------------------------------------
{
  assert.equal(tipoDe("apunte.PDF"), "pdf", "la extensión no distingue mayúsculas");
  assert.equal(tipoDe("pizarron.jpeg"), "imagen");
  assert.equal(tipoDe("clase.pptx"), "presentacion");
  assert.equal(tipoDe("notas.md"), "texto");
  assert.equal(tipoDe("trabajo.docx"), "documento");
}

console.log("materiales: 4 casos OK");
