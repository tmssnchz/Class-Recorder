/**
 * Test de las marcas sobre una hoja de apunte.
 *
 * Correr con:  node --experimental-strip-types src/lib/marcasHoja.test.mjs
 *
 * Cubre lo que se rompe en silencio: que un arrastre hacia arriba o hacia la
 * izquierda dé el mismo rectángulo que uno hacia abajo y a la derecha, que lo
 * que se salió de la hoja se recorte, y que un click suelto no siembre marcas
 * invisibles.
 */
import assert from "node:assert/strict";

import {
  agregarMarca,
  cuentaDeMarcas,
  editarNotaDeMarca,
  quitarMarca,
  rectanguloNormalizado,
} from "./marcasHoja.ts";

const casi = (a, b, mensaje) => assert.ok(Math.abs(a - b) < 1e-9, `${mensaje}: ${a} vs ${b}`);

// Un arrastre normal, sobre una hoja renderizada de 1000 x 2000.
{
  const r = rectanguloNormalizado({ x0: 100, y0: 200, x1: 600, y1: 1200 }, 1000, 2000);
  casi(r.x, 0.1, "x");
  casi(r.y, 0.1, "y");
  casi(r.ancho, 0.5, "ancho");
  casi(r.alto, 0.5, "alto");
}

// El mismo rectángulo dibujado al revés: de la esquina de abajo hacia arriba.
{
  const derecho = rectanguloNormalizado({ x0: 100, y0: 200, x1: 600, y1: 1200 }, 1000, 2000);
  const alreves = rectanguloNormalizado({ x0: 600, y0: 1200, x1: 100, y1: 200 }, 1000, 2000);
  assert.deepEqual(alreves, derecho, "arrastrar al revés da el mismo rectángulo");
}

// Soltar el mouse pasado el borde: se recorta a la hoja, no se guarda de más.
{
  const r = rectanguloNormalizado({ x0: -300, y0: -50, x1: 4000, y1: 9000 }, 1000, 2000);
  assert.deepEqual(r, { x: 0, y: 0, ancho: 1, alto: 1 }, "se recorta a la hoja entera");
}

// Un click suelto, o un arrastre de dos píxeles, no deja nada.
{
  assert.equal(rectanguloNormalizado({ x0: 500, y0: 500, x1: 500, y1: 500 }, 1000, 2000), null);
  assert.equal(rectanguloNormalizado({ x0: 500, y0: 500, x1: 502, y1: 900 }, 1000, 2000), null);
  // Y con una hoja todavía sin medir tampoco revienta.
  assert.equal(rectanguloNormalizado({ x0: 0, y0: 0, x1: 10, y1: 10 }, 0, 0), null);
}

// Agregar, editar y quitar tocan solo la página que corresponde.
{
  const marca = (id) => ({
    id,
    x: 0.1,
    y: 0.1,
    ancho: 0.2,
    alto: 0.2,
    nota: "",
    creadaEn: "2026-09-08T00:00:00.000Z",
  });
  const paginas = [
    { id: "p1", marcas: [marca("m1")] },
    { id: "p2" },
  ];

  const conNueva = agregarMarca(paginas, "p2", marca("m2"));
  assert.equal(cuentaDeMarcas(conNueva[1]), 1, "la página sin marcas acepta la primera");
  assert.equal(cuentaDeMarcas(conNueva[0]), 1, "y la otra página no se toca");

  const anotada = editarNotaDeMarca(conNueva, "p1", "m1", "revisar esto");
  assert.equal(anotada[0].marcas[0].nota, "revisar esto");
  assert.equal(anotada[1].marcas[0].nota, "", "no se pisó la marca de la otra página");

  const sinNada = quitarMarca(anotada, "p1", "m1");
  assert.equal(cuentaDeMarcas(sinNada[0]), 0);
  assert.equal(cuentaDeMarcas(sinNada[1]), 1);

  // Borrar algo que no está no rompe ni cambia el resto.
  assert.deepEqual(quitarMarca(sinNada, "p1", "no-existe"), sinNada);
}

console.log("marcasHoja: 12 casos OK");
