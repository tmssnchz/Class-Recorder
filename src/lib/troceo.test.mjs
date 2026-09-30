/**
 * Test del troceo para la transcripción por API: dónde se corta, cómo se
 * reajustan los tiempos al reloj de la clase y cómo se deduplican las uniones.
 * Si algo de esto falla en silencio, la transcripción sale con frases
 * repetidas o con tiempos corridos y nadie lo nota hasta leerla entera.
 */
import assert from "node:assert/strict";

import {
  aTiempoGlobal,
  deduplicarUnion,
  filtrarAlucinaciones,
  fraccionSilencio,
  mapConcurrente,
  parsearSilencios,
  planearTrozos,
  segmentoDeTrozo,
} from "./troceo.ts";

const seg = (desdeMs, hastaMs, texto) => ({ desdeMs, hastaMs, texto });

// ------------------------------------------------------------- silencedetect
{
  const salida = [
    "[silencedetect @ 0x1] silence_start: 12.5",
    "[silencedetect @ 0x1] silence_end: 15.25 | silence_duration: 2.75",
    "[silencedetect @ 0x1] silence_start: 99",
  ].join("\n");
  assert.deepEqual(parsearSilencios(salida, 120), [
    { desdeSeg: 12.5, hastaSeg: 15.25 },
    { desdeSeg: 99, hastaSeg: 120 }, // el último no cierra: llega al final
  ]);
}

// ------------------------------------------------------------------- troceo
// 90 min sin ningún silencio: cortes duros cada 240 s, todos consecutivos y sin huecos.
{
  const duracion = 90 * 60;
  const trozos = planearTrozos(duracion, []);
  assert.equal(trozos[0].desdeSeg, 0);
  assert.equal(trozos.at(-1).hastaSeg, duracion);
  for (let i = 1; i < trozos.length; i++) {
    assert.equal(trozos[i].propioDesdeSeg, trozos[i - 1].hastaSeg, "sin huecos ni traslape de lo propio");
    assert.equal(trozos[i].desdeSeg, trozos[i].propioDesdeSeg - 2, "solape de 2 s hacia atrás");
  }
  for (const t of trozos) {
    assert.ok(t.hastaSeg - t.propioDesdeSeg <= 300, "ningún trozo pasa del máximo");
    assert.ok(t.hastaSeg - t.desdeSeg <= 302);
  }
  assert.equal(trozos.length, 23); // 22 de 240 s + el resto
}

// Con silencios cerca del objetivo, corta en el medio del más cercano a 240 s.
{
  const silencios = [
    { desdeSeg: 200, hastaSeg: 202 }, // 201: dentro de [180, 300], lejos de 240
    { desdeSeg: 238, hastaSeg: 242 }, // 240: el mejor
    { desdeSeg: 290, hastaSeg: 292 },
    { desdeSeg: 100, hastaSeg: 110 }, // antes del mínimo: se ignora
  ];
  const trozos = planearTrozos(600, silencios);
  assert.equal(trozos[0].hastaSeg, 240);
  assert.equal(trozos[1].propioDesdeSeg, 240);
}

// Audio corto: un solo trozo. Duración 0: ninguno.
assert.equal(planearTrozos(200, []).length, 1);
assert.equal(planearTrozos(0, []).length, 0);

// Un trozo casi todo silencio se detecta para no mandarlo.
{
  const [t] = planearTrozos(100, []);
  assert.ok(fraccionSilencio(t, [{ desdeSeg: 2, hastaSeg: 100 }]) >= 0.95);
  assert.ok(fraccionSilencio(t, [{ desdeSeg: 10, hastaSeg: 20 }]) < 0.2);
}

// ---------------------------------------------------- reajuste de timestamps
{
  const [, t1] = planearTrozos(600, [], { objetivoSeg: 240, minSeg: 180, maxSeg: 300, solapeSeg: 2 });
  assert.equal(t1.desdeSeg, 238);
  // Relativo a 238: 0-1 s cae en el solape (238-239 < 240), 5-8 s es del trozo.
  const globales = aTiempoGlobal(
    [
      { inicioS: 0, finS: 1, texto: "en el solape" },
      { inicioS: 5, finS: 8, texto: "propio" },
      { inicioS: 9, finS: 9999, texto: "termina fuera" }, // se recorta al largo del trozo
    ],
    t1,
  );
  assert.deepEqual(globales[0], seg(243000, 246000, "propio"));
  assert.equal(globales.length, 2);
  assert.equal(globales[1].hastaMs, t1.hastaSeg * 1000);
}

// El segmento a caballo del corte es del trozo nuevo si su punto medio es posterior.
{
  const [, t1] = planearTrozos(600, [], { objetivoSeg: 240, minSeg: 180, maxSeg: 300, solapeSeg: 2 });
  const [s] = aTiempoGlobal([{ inicioS: 1, finS: 4, texto: "cruza" }], t1); // 239-242 s, medio 240,5
  assert.equal(s.desdeMs, 239000);
}

// Sin tiempos del proveedor: un segmento por trozo.
{
  const [, t1] = planearTrozos(600, [], { objetivoSeg: 240, minSeg: 180, maxSeg: 300, solapeSeg: 2 });
  assert.deepEqual(segmentoDeTrozo(" hola ", t1), [seg(240000, 480000, "hola")]);
  assert.deepEqual(segmentoDeTrozo("  ", t1), []);
}

// ------------------------------------------------------------- deduplicación
// El solape repite el final del trozo anterior: se quita del inicio del nuevo.
{
  const previos = [seg(0, 240000, "el contrato de compraventa se perfecciona por el consentimiento")];
  const nuevos = [
    seg(238000, 244000, "se perfecciona por el consentimiento de las partes."),
    seg(244000, 250000, "Luego viene la tradición."),
  ];
  assert.deepEqual(deduplicarUnion(previos, nuevos), [
    seg(238000, 244000, "de las partes."),
    seg(244000, 250000, "Luego viene la tradición."),
  ]);
}

// Ignora mayúsculas y puntuación al comparar.
{
  const previos = [seg(0, 100000, "Artículo 1.545, todo contrato legalmente celebrado")];
  const nuevos = [seg(99000, 105000, "todo contrato legalmente celebrado es una ley para los contratantes")];
  assert.equal(deduplicarUnion(previos, nuevos)[0].texto, "es una ley para los contratantes");
}

// Un segmento repetido entero desaparece.
{
  const previos = [seg(0, 100000, "esto ya se dijo aquí")];
  const nuevos = [seg(98000, 101000, "esto ya se dijo aquí"), seg(101000, 104000, "y esto no")];
  assert.deepEqual(deduplicarUnion(previos, nuevos), [seg(101000, 104000, "y esto no")]);
}

// Menos de 3 palabras en común no se toca (podría ser una repetición legítima).
{
  const previos = [seg(0, 100000, "sí, claro")];
  const nuevos = [seg(100000, 102000, "claro que sí")];
  assert.deepEqual(deduplicarUnion(previos, nuevos), nuevos);
}

// Si el nuevo arranca lejos de donde terminó lo previo, no es una unión.
{
  const previos = [seg(0, 100000, "una dos tres cuatro")];
  const nuevos = [seg(500000, 502000, "una dos tres cuatro")];
  assert.deepEqual(deduplicarUnion(previos, nuevos), nuevos);
}

// Sin previos o sin nuevos.
assert.deepEqual(deduplicarUnion([], [seg(0, 1, "hola")]), [seg(0, 1, "hola")]);
assert.deepEqual(deduplicarUnion([seg(0, 1, "hola")], []), []);

// --------------------------------------------------------- alucinaciones
{
  const entrada = [
    seg(0, 5000, "Esto es la demanda del mercado."),
    seg(5000, 35000, "Gracias."),
    seg(35000, 65000, "Gracias."),
    seg(65000, 70000, "Gracias por ver el video."),
    seg(70000, 75000, "a la presidencia, a la presidencia, a la presidencia, a la presidencia, a la presidencia, a la presidencia, a la presidencia"),
    seg(75000, 80000, "Entonces la elasticidad es negativa."),
    seg(80000, 85000, "Entonces la elasticidad es negativa."), // repetido idéntico
    seg(85000, 90000, "Gracias a la derivada, la pendiente es menos dos."), // frase real que empieza con gracias
  ];
  const { segmentos, descartados } = filtrarAlucinaciones(entrada);
  assert.deepEqual(
    segmentos.map((s) => s.texto),
    [
      "Esto es la demanda del mercado.",
      "Entonces la elasticidad es negativa.",
      "Gracias a la derivada, la pendiente es menos dos.",
    ],
  );
  assert.equal(descartados, 5);
}

// Bucle dentro de un segmento con más texto: se deja una sola vez. Tres repeticiones no se tocan.
{
  const largo = seg(0, 9000, "siempre puedes ir a verme, a la presidencia, a la presidencia, a la presidencia, a la presidencia, a la presidencia. Bien.");
  assert.equal(
    filtrarAlucinaciones([largo]).segmentos[0].texto,
    "siempre puedes ir a verme, a la presidencia, Bien.",
  );
  const dictado = seg(0, 5000, "menos 0,1, menos 0,1, menos 0,1, donde vamos");
  assert.equal(filtrarAlucinaciones([dictado]).segmentos[0].texto, dictado.texto);
}

// ------------------------------------------------------------- concurrencia
{
  let activos = 0;
  let maximo = 0;
  const res = await mapConcurrente([1, 2, 3, 4, 5, 6], 2, async (n) => {
    activos++;
    maximo = Math.max(maximo, activos);
    await new Promise((r) => setTimeout(r, 5));
    activos--;
    if (n === 3) throw new Error("falla el 3");
    return n * 10;
  });
  assert.equal(maximo, 2, "nunca más de 2 a la vez");
  assert.deepEqual(
    res.map((r) => (r.ok ? r.valor : "x")),
    [10, 20, "x", 40, 50, 60],
    "un fallo no tumba a los demás y el orden se conserva",
  );
}

console.log("troceo: ok");
