/**
 * Test de la organización previa de una tanda de fotos.
 *
 * Cubre lo que se rompe en silencio y arruina un apunte entero: que una hoja
 * quede en dos apuntes a la vez, que reasignar una selección reordene páginas
 * que ya estaban bien puestas, y que el orden armado a mano sobreviva al viaje
 * hasta el modo ráfaga.
 */
import assert from "node:assert/strict";

import {
  asignar,
  devolverAlMeson,
  moverEnGrupo,
  numerosRepetidos,
  ordenDelMeson,
  ordenarGrupoPorPagina,
  posicionesEnGrupo,
  sinAsignar,
} from "./organizar.ts";

const grupo = (clave, fotos) => ({
  clave,
  claseId: "c1",
  unidadId: null,
  titulo: clave,
  fotos,
});

{
  // Por número de marcador; las que no trajeron ninguno, al final y en el orden
  // en que se sacaron.
  const fotos = ["a.jpg", "b.jpg", "c.jpg", "d.jpg"];
  const numeros = new Map([
    ["a.jpg", 7],
    ["b.jpg", null],
    ["c.jpg", 3],
    ["d.jpg", null],
  ]);
  assert.deepEqual(ordenDelMeson(fotos, numeros), ["c.jpg", "a.jpg", "b.jpg", "d.jpg"]);
}

{
  // Dos corridas de impresión repiten el número 5. Las dos hojas tienen que
  // quedar adyacentes —es donde el usuario tiene que mirar— y en el orden en
  // que se sacaron las fotos, que es lo único que las distingue.
  const fotos = ["tarde.jpg", "temprano.jpg", "otra.jpg"];
  const numeros = new Map([
    ["tarde.jpg", 5],
    ["temprano.jpg", 5],
    ["otra.jpg", 2],
  ]);
  assert.deepEqual(ordenDelMeson(fotos, numeros), ["otra.jpg", "tarde.jpg", "temprano.jpg"]);
  assert.deepEqual([...numerosRepetidos(fotos, numeros)], [5]);
  // Sin repetidos no se marca nada: el aviso tiene que significar algo.
  assert.equal(numerosRepetidos(["otra.jpg"], numeros).size, 0);
}

{
  // Varias fotos sin marcador no cuentan como número repetido: null no es un
  // número, y marcarlas confundiría el caso que el aviso quiere señalar.
  const numeros = new Map([
    ["a.jpg", null],
    ["b.jpg", null],
  ]);
  assert.equal(numerosRepetidos(["a.jpg", "b.jpg"], numeros).size, 0);
}

{
  // Una hoja no puede quedar en dos apuntes: asignarla la saca del anterior.
  let grupos = [grupo("g1", ["a.jpg", "b.jpg"]), grupo("g2", [])];
  grupos = asignar(grupos, "g2", ["a.jpg"]);
  assert.deepEqual(grupos[0].fotos, ["b.jpg"]);
  assert.deepEqual(grupos[1].fotos, ["a.jpg"]);
}

{
  // Reasignar una selección que incluye hojas ya puestas no las reordena: solo
  // se agregan las nuevas, al final. Si no, arrastrar de nuevo sobre el mismo
  // apunte barajaría páginas que ya estaban ordenadas a mano.
  let grupos = [grupo("g1", ["a.jpg", "b.jpg", "c.jpg"])];
  grupos = asignar(grupos, "g1", ["c.jpg", "a.jpg", "d.jpg"]);
  assert.deepEqual(grupos[0].fotos, ["a.jpg", "b.jpg", "c.jpg", "d.jpg"]);
}

{
  let grupos = [grupo("g1", ["a.jpg", "b.jpg"]), grupo("g2", ["c.jpg"])];
  grupos = devolverAlMeson(grupos, ["a.jpg", "c.jpg"]);
  assert.deepEqual(grupos[0].fotos, ["b.jpg"]);
  assert.deepEqual(grupos[1].fotos, []);
  assert.deepEqual(sinAsignar(["a.jpg", "b.jpg", "c.jpg"], grupos), ["a.jpg", "c.jpg"]);
}

{
  // Reordenar dentro del apunte: es la mitad del trabajo cuando los números del
  // marcador se repiten y no sirven para ordenar.
  let grupos = [grupo("g1", ["a.jpg", "b.jpg", "c.jpg"])];
  assert.deepEqual(moverEnGrupo(grupos, "g1", 2, 0)[0].fotos, ["c.jpg", "a.jpg", "b.jpg"]);
  assert.deepEqual(moverEnGrupo(grupos, "g1", 0, 2)[0].fotos, ["b.jpg", "c.jpg", "a.jpg"]);
  // Fuera de rango no rompe ni pierde fotos.
  assert.deepEqual(moverEnGrupo(grupos, "g1", 0, 9)[0].fotos, ["a.jpg", "b.jpg", "c.jpg"]);
  assert.deepEqual(moverEnGrupo(grupos, "otro", 0, 1)[0].fotos, ["a.jpg", "b.jpg", "c.jpg"]);
}

{
  // El orden armado a mano viaja al modo ráfaga como un número por foto, que es
  // lo que la ráfaga ya sabe ordenar. Numerado desde 1 y por apunte, no global.
  const grupos = [grupo("g1", ["b.jpg", "a.jpg"]), grupo("g2", ["c.jpg"])];
  const p = posicionesEnGrupo(grupos);
  assert.equal(p.get("b.jpg"), 1);
  assert.equal(p.get("a.jpg"), 2);
  assert.equal(p.get("c.jpg"), 1);
}

{
  // Ordenar un apunte por el número del marcador: el atajo para el caso normal,
  // donde la app ya sabe el orden y el usuario no tiene por qué armarlo.
  const numeros = new Map([
    ["c.jpg", 4],
    ["a.jpg", 2],
    ["b.jpg", null],
    ["d.jpg", 9],
  ]);
  let grupos = [grupo("g1", ["b.jpg", "c.jpg", "d.jpg", "a.jpg"]), grupo("g2", ["x.jpg"])];
  grupos = ordenarGrupoPorPagina(grupos, "g1", numeros);
  assert.deepEqual(
    grupos[0].fotos,
    ["a.jpg", "c.jpg", "d.jpg", "b.jpg"],
    "por número, y la que no tiene marcador al final",
  );
  assert.deepEqual(grupos[1].fotos, ["x.jpg"], "los otros apuntes no se tocan");
}

console.log("organizar: 9 casos OK");
