/**
 * Test del armado del árbol de la Biblioteca.
 *
 * Correr con:  node --experimental-strip-types src/lib/arbol.test.mjs
 * (o `npm run test:arbol`)
 *
 * Cubre lo que se rompe en silencio: que una clase o unidad sin grabaciones
 * siga apareciendo, y que con un filtro activo esas ramas vacías se poden.
 */
import assert from "node:assert/strict";

import { construirArbol } from "./arbol.ts";

const clase = (id, nombre, unidades) => ({
  id,
  nombre,
  color: "#000",
  creadaEn: "2026-01-01T00:00:00.000Z",
  unidades: unidades.map(([uid, un]) => ({
    id: uid,
    nombre: un,
    creadaEn: "2026-01-01T00:00:00.000Z",
  })),
});

const grabacion = (id, claseId, unidadId) => ({
  id,
  claseId,
  unidadId,
  claseNombre: "X",
  unidadNombre: "Y",
  titulo: id,
  archivoAudio: "C:/x.mp3",
  carpeta: "C:/",
  fechaISO: "2026-01-01T00:00:00.000Z",
  duracionSeg: 60,
  formato: "mp3",
  bytes: 1000,
  estado: "listo",
  errorConversion: null,
  tags: [],
  marcas: [],
  transcripcion: null,
});

// --- clase sin ninguna grabación se muestra igual ---------------------------
{
  const arbol = construirArbol([clase("c1", "Micro", [["u1", "Unidad 1"]])], [], false);
  assert.equal(arbol.length, 1, "la clase vacía tiene que aparecer");
  assert.equal(arbol[0].nombre, "Micro");
  assert.equal(arbol[0].unidades.length, 1, "la unidad vacía también");
  assert.equal(arbol[0].unidades[0].items.length, 0);
}

// --- clase sin unidades tampoco desaparece ---------------------------------
{
  const arbol = construirArbol([clase("c1", "Sin unidades", [])], [], false);
  assert.equal(arbol.length, 1);
  assert.equal(arbol[0].unidades.length, 0);
}

// --- con filtro activo, las ramas vacías se podan ---------------------------
{
  const clases = [
    clase("c1", "Con grabación", [["u1", "U1"]]),
    clase("c2", "Vacía", [["u2", "U2"]]),
  ];
  const arbol = construirArbol(clases, [grabacion("g1", "c1", "u1")], true);
  assert.equal(arbol.length, 1, "la clase vacía se poda cuando hay filtro");
  assert.equal(arbol[0].nombre, "Con grabación");
}

// --- sin filtro, ambas se ven aunque una esté vacía -------------------------
{
  const clases = [
    clase("c1", "Con grabación", [["u1", "U1"]]),
    clase("c2", "Vacía", [["u2", "U2"]]),
  ];
  const arbol = construirArbol(clases, [grabacion("g1", "c1", "u1")], false);
  assert.equal(arbol.length, 2, "sin filtro se ven las dos");
}

// --- grabación huérfana (clase borrada del índice) no se pierde -------------
{
  const arbol = construirArbol([], [grabacion("g1", "borrada", "u9")], false);
  assert.equal(arbol.length, 1, "la grabación huérfana arma su propio grupo");
  assert.equal(arbol[0].unidades[0].items.length, 1);
}

// --- grabación sin clase cae en "Sin clasificar" ----------------------------
{
  const arbol = construirArbol([], [grabacion("g1", null, null)], false);
  assert.equal(arbol.length, 1);
  assert.equal(arbol[0].claveClase, "Sin clasificar");
}

console.log("arbol: 6 casos OK");
