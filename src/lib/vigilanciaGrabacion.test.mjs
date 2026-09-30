/**
 * Test de la vigilancia de grabación: detección de chunks que dejan de llegar,
 * comparación de duración registrada vs real y control compartido de suspensión.
 */
import assert from "node:assert/strict";

import {
  avisoDuracion,
  estaSinChunks,
  huecoEntreChunks,
  lineaLog,
  mensajeProblemaAudio,
} from "./vigilanciaGrabacion.ts";
import { crearControlSuspension } from "./suspension.ts";

// Chunks cada 5 s: nunca alarma. 10 s justos tampoco; pasado el límite, sí.
assert.equal(estaSinChunks(5000, 0), false);
assert.equal(estaSinChunks(10000, 0), false);
assert.equal(estaSinChunks(10001, 0), true);

// Hueco: solo se anota si se pasó de lo normal.
assert.equal(huecoEntreChunks(5000, 0), null);
assert.equal(huecoEntreChunks(30000, 0), 30);

// Duración: 2 h 36 vs 53 s avisa; diferencia chica o dato faltante, no.
assert.match(avisoDuracion(9360, 53), /solo 00:53/);
assert.equal(avisoDuracion(3600, 3590), null);
assert.equal(avisoDuracion(3600, 3571), null);
assert.notEqual(avisoDuracion(3600, 3569), null);
assert.equal(avisoDuracion(3600, 0), null);
assert.equal(avisoDuracion(0, 100), null);
assert.match(avisoDuracion(100, 400), /dura 06:40/);

// Mensajes: ended manda sobre lo demás; sin problemas no hay aviso.
assert.equal(mensajeProblemaAudio(new Set()), null);
assert.match(mensajeProblemaAudio(new Set(["sin-datos", "ended"])), /dejó de entregar/);
assert.match(mensajeProblemaAudio(new Set(["mute"])), /silenció/);
assert.match(mensajeProblemaAudio(new Set(["sin-datos"]), 12.4), /Hace 12 s/);

assert.equal(
  lineaLog(1.25, 0.5, "inicio", "x"),
  "[reloj      1.3 s | cron      0.5 s] inicio — x",
);

// Suspensión: la cola de transcripciones no se pierde si la grabación suelta.
const llamadas = [];
const fijar = crearControlSuspension((v) => llamadas.push(v));
fijar("grabacion", true);
fijar("transcripcion", true);
fijar("grabacion", false);
assert.deepEqual(llamadas, [true], "sigue la cola: no se libera");
fijar("transcripcion", false);
assert.deepEqual(llamadas, [true, false]);
fijar("transcripcion", false);
assert.deepEqual(llamadas, [true, false], "soltar de más no repite la llamada");

console.log("vigilanciaGrabacion: ok");
