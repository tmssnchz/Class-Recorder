/**
 * Test de la estimación de fecha de un audio importado.
 *
 * Es la señal de la que depende la sugerencia de clase: si acá se cuela una
 * fecha equivocada, el audio termina asignado a la materia que no era.
 */
import assert from "node:assert/strict";

import { bloqueEn } from "./horario.ts";
import { estimarFecha, fechaDesdeNombre, sugerirClase } from "./fechaAudio.ts";

// --- patrones de nombre reales -------------------------------------------
{
  const casos = [
    ["Grabacion_20260807_143000.m4a", 2026, 7, 7, 14, 30],
    ["REC-20260807-143000.mp3", 2026, 7, 7, 14, 30],
    ["20260807 143000.wav", 2026, 7, 7, 14, 30],
    ["2026-08-07_14-30-00.m4a", 2026, 7, 7, 14, 30],
    ["Audio 2026-08-07 14.30.00.opus", 2026, 7, 7, 14, 30],
    ["2026-08-07_14-30.m4a", 2026, 7, 7, 14, 30],
  ];
  for (const [nombre, a, mes, d, h, min] of casos) {
    const f = fechaDesdeNombre(nombre);
    assert.ok(f, `no reconoció ${nombre}`);
    assert.equal(f.getFullYear(), a, nombre);
    assert.equal(f.getMonth(), mes, nombre);
    assert.equal(f.getDate(), d, nombre);
    assert.equal(f.getHours(), h, nombre);
    assert.equal(f.getMinutes(), min, nombre);
  }
}

// --- WhatsApp: trae fecha pero no hora -----------------------------------
{
  const f = fechaDesdeNombre("PTT-20260807-WA0001.opus");
  assert.ok(f);
  assert.equal(f.getDate(), 7);
  assert.equal(f.getHours(), 0, "sin hora en el nombre queda a medianoche");
}

// --- nombres sin fecha ---------------------------------------------------
{
  assert.equal(fechaDesdeNombre("Nueva grabación 3.m4a"), null, "iPhone Voice Memos");
  assert.equal(fechaDesdeNombre("New Recording 12.m4a"), null);
  assert.equal(fechaDesdeNombre("clase de micro.mp3"), null);
}

// --- fechas imposibles no se aceptan -------------------------------------
{
  assert.equal(fechaDesdeNombre("20260231_143000.m4a"), null, "31 de febrero");
  assert.equal(fechaDesdeNombre("20261307_143000.m4a"), null, "mes 13");
  assert.equal(fechaDesdeNombre("20260807_256000.m4a"), null, "hora 25");
  assert.equal(fechaDesdeNombre("19850807_143000.m4a"), null, "año fuera de rango");
}

// --- prioridad entre señales ---------------------------------------------
{
  const llegada = new Date(2026, 7, 10, 20, 0).getTime();
  const metadata = new Date(2026, 7, 7, 14, 30);

  // La metadata gana sobre todo lo demás.
  const conMeta = estimarFecha("20260101_090000.m4a", llegada, metadata, true);
  assert.equal(conMeta.origen, "metadata");
  assert.equal(conMeta.fecha.getDate(), 7);

  // Sin metadata, manda el nombre.
  const conNombre = estimarFecha("20260807_143000.m4a", llegada, null, true);
  assert.equal(conNombre.origen, "nombre");
  assert.equal(conNombre.fecha.getHours(), 14);

  // Sin ninguna de las dos, la llegada, si el usuario la autorizó.
  const conLlegada = estimarFecha("Nueva grabación.m4a", llegada, null, true);
  assert.equal(conLlegada.origen, "llegada");
  assert.equal(conLlegada.fecha.getHours(), 20);

  // Si no la autorizó, la fecha viene igual (hace falta para el nombre del
  // archivo) pero marcada como no confiable.
  const sinPermiso = estimarFecha("Nueva grabación.m4a", llegada, null, false);
  assert.equal(sinPermiso.origen, "ninguna");
  assert.equal(sinPermiso.fecha.getTime(), llegada);
}

// --- sugerencia cruzada contra el horario --------------------------------
{
  const horario = [
    { id: "b1", dia: 5, inicio: "14:00", fin: "16:00", claseId: "micro" },
  ];
  // Viernes 7 de agosto de 2026, 14:30.
  const dentro = { fecha: new Date(2026, 7, 7, 14, 30), origen: "nombre" };
  assert.equal(sugerirClase(dentro, horario, bloqueEn), "micro");

  const fuera = { fecha: new Date(2026, 7, 7, 18, 0), origen: "nombre" };
  assert.equal(sugerirClase(fuera, horario, bloqueEn), null);

  // Aunque la hora caiga dentro del bloque, sin fecha confiable no se sugiere.
  const noConfiable = { fecha: new Date(2026, 7, 7, 14, 30), origen: "ninguna" };
  assert.equal(
    sugerirClase(noConfiable, horario, bloqueEn),
    null,
    "sin fecha confiable no se adivina la clase",
  );
}

console.log("fechaAudio: 6 casos OK");
