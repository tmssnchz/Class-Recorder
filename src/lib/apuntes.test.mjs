/**
 * Test de los apuntes digitalizados.
 *
 * Cubre lo que se rompe en silencio:
 *  - que la geometría de la plantilla en TypeScript siga dando lo mismo que la
 *    de Rust (si se separan, el escaneo sale torcido sin dar ningún error)
 *  - que el orden de impresión del reverso sea el que corresponde
 *  - que un re-escaneo no haga desaparecer la versión anterior
 */
import assert from "node:assert/strict";

import { esSoloVisual, ordenarPorMarcador, renumerar, textoDe } from "./escaneo.ts";
import {
  areaEscribibleMm,
  caraReverso,
  centrosMarcadorMm,
  geometriaDePagina,
  ordenReverso,
  aMm,
  PAGINA_MAXIMA,
  problemaDeNumeracion,
  desdeMm,
  papelDe,
  planDuplexManual,
  problemaDeGeometria,
  LADO_MARCADOR_MM,
  MARGEN_BORDE_MM,
} from "./plantilla.ts";
import {
  apuntesVisiblesDe,
  progresoReconocimiento,
  versionesAnteriores,
  vigentes,
} from "./apuntes.ts";

const B5 = {
  anchoMm: 176,
  altoMm: 250,
  margenAnilladoMm: 18,
  ladoAnillado: "izquierda",
};

// ------------------------------------------------- geometría de la plantilla

{
  const c = centrosMarcadorMm(B5);
  // Los mismos números que espera el test de Rust
  // (`el_anillado_corre_solo_las_esquinas_de_su_lado`): 8 de borde + 14/2 de
  // medio marcador = 15, más 18 de anillado del lado izquierdo.
  assert.equal(c[0][0], 33, "esquina superior izquierda corrida por el anillado");
  assert.equal(c[3][0], 33, "la inferior izquierda igual que la superior");
  assert.equal(c[1][0], 161, "la derecha sin anillado");
  assert.equal(c[0][1], 15, "arriba sin anillado");
  assert.equal(c[2][1], 235, "abajo");

  // El punto de todo esto: NO es un rectángulo centrado.
  assert.notEqual(c[0][0], B5.anchoMm - c[1][0], "los marcadores no deben quedar simétricos");

  // Y los cuatro caen dentro de la hoja.
  for (const [x, y] of c) {
    assert.ok(x > 0 && x < B5.anchoMm && y > 0 && y < B5.altoMm, `(${x}, ${y}) fuera de la hoja`);
  }
}

{
  // Con el anillado arriba se corre la fila de arriba, no la columna izquierda.
  const arriba = { ...B5, ladoAnillado: "arriba" };
  const c = centrosMarcadorMm(arriba);
  assert.equal(c[0][0], 15, "sin anillado a la izquierda");
  assert.equal(c[0][1], 33, "la fila de arriba corrida por el anillado");
  assert.equal(c[2][1], 235, "la de abajo sin tocar");
}

{
  const area = areaEscribibleMm(B5);
  assert.ok(area.x >= 33, "el área de escritura no debe pisar el anillado ni los marcadores");
  assert.ok(area.x + area.ancho <= B5.anchoMm, "el área no debe salirse de la hoja");
  assert.ok(area.alto > 100, "debería quedar hoja utilizable de sobra");
}

// ------------------------------------------------------- papel a medida

{
  // El caso que motivó todo esto: un recambio de binder vendido como "B5" que
  // mide 173 × 250 y no coincide con ningún B5 normalizado.
  const universitario = { ...B5, anchoMm: 173 };
  assert.equal(papelDe(universitario)?.id, "b5-cl");
  assert.equal(papelDe(B5)?.id, "b5");

  // Una medida que no es de ningún preset devuelve null, no el primero de la
  // lista: si cayera al primero, el selector diría "B5 ISO" mientras se
  // imprime otra cosa.
  assert.equal(papelDe({ ...B5, anchoMm: 169, altoMm: 244 }), null);

  // Y la geometría a medida sigue dando marcadores dentro de la hoja.
  for (const [x, y] of centrosMarcadorMm(universitario)) {
    assert.ok(x > 0 && x < 173 && y > 0 && y < 250, `(${x}, ${y}) fuera de la hoja`);
  }
}

{
  assert.equal(problemaDeGeometria(B5), null);
  assert.equal(problemaDeGeometria({ ...B5, anchoMm: 173 }), null);
  // Hoja chica con anillado grande: no queda dónde escribir y los marcadores
  // de los dos lados se pisarían.
  assert.match(problemaDeGeometria({ ...B5, anchoMm: 90 }), /no queda hoja/);
  assert.match(problemaDeGeometria({ ...B5, anchoMm: 40 }), /demasiado chica/);
  assert.match(problemaDeGeometria({ ...B5, anchoMm: 500 }), /más grande/);
}

// -------------------------------------------- marcadores en la hoja

{
  // Las etiquetas "ARRIBA" y "ABAJO" van al centro de cada borde, y ahí no
  // puede haber ningún marcador: son lo único que dice de qué lado entra la
  // hoja en la bandeja al imprimir el reverso.
  const yArriba = (B5.ladoAnillado === "arriba" ? B5.margenAnilladoMm : 0) + 5;
  const yAbajo = B5.altoMm - 4;

  for (const [i, [cx, cy]] of centrosMarcadorMm(B5).entries()) {
    const izq = cx - LADO_MARCADOR_MM / 2;
    const der = cx + LADO_MARCADOR_MM / 2;
    const arr = cy - LADO_MARCADOR_MM / 2;
    const aba = cy + LADO_MARCADOR_MM / 2;
    assert.ok(
      izq > 0 && arr > 0 && der < B5.anchoMm && aba < B5.altoMm,
      `el marcador ${i} se sale de la hoja`,
    );
    // Las etiquetas están centradas en x, así que basta con que ningún
    // marcador cruce el eje vertical de la hoja a esas alturas.
    const enElEje = izq < B5.anchoMm / 2 && der > B5.anchoMm / 2;
    assert.ok(
      !enElEje || (yArriba < arr && yAbajo > aba),
      `el marcador ${i} pisa las etiquetas de arriba/abajo`,
    );
  }

  // Y el borde de abajo tiene lugar para la etiqueta debajo de los marcadores.
  const bordeMarcador = MARGEN_BORDE_MM + LADO_MARCADOR_MM;
  assert.ok(yAbajo > B5.altoMm - bordeMarcador, "la etiqueta de abajo debe ir bajo los marcadores");
  assert.ok(yAbajo < B5.altoMm, "la etiqueta de abajo no debe salirse de la hoja");
}

// ------------------------------------------- frente y reverso de cada hoja

{
  // La invariante que sostiene todo el escaneo desde que la hoja dejó de
  // llevar su geometría impresa: impar = frente, par = reverso. Rust aplica la
  // misma regla en `geometria_de_pagina` para saber por qué cara va una foto.
  assert.equal(geometriaDePagina(B5, 1).ladoAnillado, "izquierda", "las impares son el frente");
  assert.equal(geometriaDePagina(B5, 2).ladoAnillado, "derecha", "las pares son el reverso");
  assert.equal(geometriaDePagina(B5, 7).ladoAnillado, "izquierda");
  assert.equal(geometriaDePagina(B5, 8).ladoAnillado, "derecha");

  // Y el reverso corre los marcadores el margen de anillado entero: si el
  // escaneo usara la cara equivocada, el recorte saldría corrido justo eso.
  const frente = centrosMarcadorMm(geometriaDePagina(B5, 7));
  const reverso = centrosMarcadorMm(geometriaDePagina(B5, 8));
  assert.equal(frente[0][0] - reverso[0][0], B5.margenAnilladoMm, "el reverso corre los marcadores");

  // Con el anillado arriba no hay nada que invertir: el volteo del dúplex
  // manual es sobre el eje vertical y deja el borde superior donde estaba.
  const arriba = { ...B5, ladoAnillado: "arriba" };
  assert.equal(geometriaDePagina(arriba, 2).ladoAnillado, "arriba");
}

// ------------------------------------------ tope del diccionario de marcadores

{
  assert.equal(problemaDeNumeracion(1, 40), null);
  assert.equal(problemaDeNumeracion(PAGINA_MAXIMA, 1), null, "la última página entra justo");
  assert.match(problemaDeNumeracion(PAGINA_MAXIMA, 2), /solo llegan/);
  // El caso real: continuar un lote alto con el dúplex, que gasta dos números
  // por hoja. Antes esto reventaba a mitad de generar el PDF.
  assert.match(problemaDeNumeracion(200, 40 * 2), /solo llegan/);
  assert.equal(problemaDeNumeracion(200, 20 * 2), null);
}

// ------------------------------------------------------ unidades

{
  // Se escribe en la unidad que sea; adentro siempre son milímetros.
  assert.equal(aMm(173, "mm"), 173);
  assert.equal(aMm(17.3, "cm"), 173);
  assert.equal(aMm(8.5, "in"), 215.9, "carta en pulgadas");
  assert.equal(aMm(11, "in"), 279.4);

  // Sin redondeo, 8.5 pulgadas deja un 215.90000000000003 en la config.
  assert.ok(Number.isInteger(aMm(8.5, "in") * 10), "a lo sumo un decimal");

  assert.equal(desdeMm(173, "mm"), 173);
  assert.equal(desdeMm(173, "cm"), 17.3);
  assert.equal(desdeMm(215.9, "in"), 8.5);

  // Ida y vuelta sin deriva: escribir en pulgadas y volver a leer no debe
  // correr la hoja un milímetro por cada visita a la pantalla.
  for (const u of ["mm", "cm", "in"]) {
    for (const mm of [173, 250, 215.9, 279.4]) {
      assert.equal(aMm(desdeMm(mm, u), u), mm, `${mm} mm en ${u} no vuelve igual`);
    }
  }
}

// ------------------------------------------------- el reverso de la hoja

{
  // Los agujeros están en el papel, no en la cara: al dar vuelta la hoja el
  // anillado queda del otro lado. Si esto se rompe, dos marcadores del reverso caen
  // justo encima de la perforación.
  const atras = caraReverso(B5);
  assert.equal(atras.ladoAnillado, "derecha");
  assert.equal(atras.margenAnilladoMm, 18, "el margen es el mismo, cambia el borde");
  assert.equal(caraReverso(atras).ladoAnillado, "izquierda", "volver a darla vuelta la deja igual");

  // El espejo del frente: lo que el frente reserva a la izquierda, el reverso
  // lo reserva a la derecha, a la misma distancia del borde.
  const frente = centrosMarcadorMm(B5);
  const reverso = centrosMarcadorMm(atras);
  assert.equal(frente[0][0], B5.anchoMm - reverso[1][0]);
  assert.equal(frente[1][0], B5.anchoMm - reverso[0][0]);

  // Y el área de escritura también se corre al otro lado.
  const aFrente = areaEscribibleMm(B5);
  const aReverso = areaEscribibleMm(atras);
  assert.equal(aFrente.ancho, aReverso.ancho, "queda el mismo ancho utilizable");
  assert.equal(aFrente.x, B5.anchoMm - (aReverso.x + aReverso.ancho));

  // Con el anillado arriba no cambia: el volteo normal es sobre el eje
  // vertical y ese eje deja el borde superior donde estaba.
  const arriba = { ...B5, ladoAnillado: "arriba" };
  assert.deepEqual(caraReverso(arriba), arriba);
}

{
  // Las impares son frentes y las pares reversos.
  assert.equal(geometriaDePagina(B5, 1).ladoAnillado, "izquierda");
  assert.equal(geometriaDePagina(B5, 2).ladoAnillado, "derecha");
  assert.equal(geometriaDePagina(B5, 7).ladoAnillado, "izquierda");
  assert.equal(geometriaDePagina(B5, 8).ladoAnillado, "derecha");
}

// -------------------------------------------------------- dúplex manual

{
  const { frente, reverso } = planDuplexManual(6, true);
  assert.deepEqual(frente, [1, 3, 5], "la cara A son las impares, en orden");
  // Al dar vuelta la pila, la última impresa queda arriba: el reverso va al revés.
  assert.deepEqual(reverso, [6, 4, 2], "la cara B va invertida");

  const { reverso: directo } = planDuplexManual(6, false);
  assert.deepEqual(directo, [2, 4, 6], "con la impresora que no invierte, va derecho");

  assert.deepEqual(ordenReverso([2, 4], true), [4, 2]);
  assert.deepEqual(ordenReverso([2, 4], false), [2, 4]);

  // Un total impar deja la última hoja sin reverso, y no debe romper nada.
  const impar = planDuplexManual(5, true);
  assert.deepEqual(impar.frente, [1, 3, 5]);
  assert.deepEqual(impar.reverso, [4, 2]);
}

// ------------------------------------------------------- orden de páginas

const pagina = (id, numero, extra = {}) => ({
  id,
  archivo: `C:/x/${id}.jpg`,
  original: null,
  numero,
  ancho: 1386,
  alto: 1969,
  bytes: 1000,
  texto: "",
  motorHtr: null,
  textoEditado: false,
  soloVisual: false,
  advertencias: [],
  ...extra,
});

{
  const desordenadas = [pagina("a", 3), pagina("b", 1), pagina("c", 2)];
  const numeros = new Map([
    ["a", 7],
    ["b", 5],
    ["c", 6],
  ]);
  const ordenadas = ordenarPorMarcador(desordenadas, numeros);
  assert.deepEqual(
    ordenadas.map((p) => p.id),
    ["b", "c", "a"],
    "el número de página del marcador manda sobre el orden en que se escanearon",
  );
  assert.deepEqual(
    ordenadas.map((p) => p.numero),
    [1, 2, 3],
    "y se renumera correlativo desde 1",
  );
}

{
  // Sin marcadores, se respeta el orden de escaneo y quedan al final de las que sí tienen.
  const mezcla = [pagina("sin-marcador", 1), pagina("con-marcador", 2)];
  const numeros = new Map([
    ["sin-marcador", null],
    ["con-marcador", 9],
  ]);
  assert.deepEqual(
    ordenarPorMarcador(mezcla, numeros).map((p) => p.id),
    ["con-marcador", "sin-marcador"],
  );
}

{
  const renumeradas = renumerar([pagina("a", 8), pagina("b", 3)]);
  assert.deepEqual(
    renumeradas.map((p) => p.numero),
    [1, 2],
  );
}

// -------------------------------------------------------- texto y visual

const apunte = (id, extra = {}) => ({
  id,
  titulo: id,
  claseId: null,
  unidadId: null,
  grabacionId: null,
  claseNombre: "Derecho",
  unidadNombre: "Unidad 1",
  carpeta: `C:/x/${id}`,
  fechaISO: "2026-08-30T12:00:00.000Z",
  paginas: [],
  idioma: "es",
  archivoTexto: `C:/x/${id}/texto.txt`,
  tags: [],
  reemplazaA: null,
  ...extra,
});

{
  const a = apunte("a", {
    paginas: [
      pagina("p2", 2, { texto: "segunda" }),
      pagina("p1", 1, { texto: "primera" }),
      pagina("p3", 3, { texto: "", soloVisual: true }),
    ],
  });
  assert.equal(
    textoDe(a),
    "primera\n\nsegunda\n\n[página 3: contenido visual]",
    "el texto sale en orden de página y la hoja de puro dibujo se marca",
  );
}

{
  assert.equal(esSoloVisual("[diagrama]"), true);
  assert.equal(esSoloVisual("[diagrama]\nEsquema"), true);
  assert.equal(
    esSoloVisual("[diagrama]\nLa obligación es un vínculo jurídico entre dos personas."),
    false,
    "una hoja con un dibujo y texto de verdad no es solo visual",
  );
  assert.equal(esSoloVisual("Texto normal sin dibujos"), false);
}

// -------------------------------------------------------------- versiones

{
  const v1 = apunte("v1");
  const v2 = apunte("v2", { reemplazaA: "v1" });
  const v3 = apunte("v3", { reemplazaA: "v2" });
  const otro = apunte("otro");
  const todos = [v1, v2, v3, otro];

  assert.deepEqual(
    vigentes(todos).map((a) => a.id),
    ["v3", "otro"],
    "solo se lista la última versión de cada hoja re-escaneada",
  );
  assert.deepEqual(
    versionesAnteriores(todos, v3).map((a) => a.id),
    ["v2", "v1"],
    "pero las anteriores siguen ahí, de la más nueva a la más vieja",
  );
  assert.deepEqual(versionesAnteriores(todos, otro), []);

  // Un ciclo en los datos no debe colgar la app.
  const ciclo = [apunte("x", { reemplazaA: "y" }), apunte("y", { reemplazaA: "x" })];
  assert.ok(versionesAnteriores(ciclo, ciclo[0]).length <= 2);
}

// ------------------------------------------------------------ por nivel

{
  const grabacion = { id: "g1", claseId: "c1", unidadId: "u1" };
  const deClase = apunte("ac", { claseId: "c1" });
  const deUnidad = apunte("au", { claseId: "c1", unidadId: "u1" });
  const deGrabacion = apunte("ag", { claseId: "c1", unidadId: "u1", grabacionId: "g1" });
  const deOtra = apunte("ax", { claseId: "c2" });

  const visibles = apuntesVisiblesDe([deClase, deUnidad, deGrabacion, deOtra], grabacion);
  assert.deepEqual(visibles.propios.map((a) => a.id), ["ag"]);
  assert.deepEqual(visibles.unidad.map((a) => a.id), ["au"], "el de la unidad no incluye el de la grabación");
  assert.deepEqual(visibles.clase.map((a) => a.id), ["ac"], "ni el de la clase incluye los de abajo");
}

{
  const a = apunte("a", {
    paginas: [pagina("p1", 1, { motorHtr: "glm-ocr" }), pagina("p2", 2)],
  });
  assert.deepEqual(progresoReconocimiento(a), { hechas: 1, total: 2 });
}

console.log("apuntes: 21 casos OK");
