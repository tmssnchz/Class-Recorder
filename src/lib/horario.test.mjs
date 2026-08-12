/**
 * Test del horario semanal.
 *
 * Lo frágil acá es el parseo del texto que devuelve una IA externa: no
 * controlamos su formato exacto, así que hay que tolerar variaciones sin
 * aceptar basura.
 */
import assert from "node:assert/strict";

import {
  armarPrompt,
  aMinutos,
  bloqueEn,
  clasificarNombres,
  diaANumero,
  normalizarHora,
  ordenarHorario,
  parsearHorario,
} from "./horario.ts";

// --- nombres de día: mayúsculas, acentos faltantes, abreviaturas ---------
{
  assert.equal(diaANumero("Lunes"), 1);
  assert.equal(diaANumero("lunes"), 1);
  assert.equal(diaANumero("  LUNES  "), 1);
  assert.equal(diaANumero("miércoles"), 3);
  assert.equal(diaANumero("miercoles"), 3, "sin acento tiene que funcionar");
  assert.equal(diaANumero("Mié"), 3, "abreviatura de tres letras");
  assert.equal(diaANumero("sabado"), 6);
  assert.equal(diaANumero("domingo"), 7);
  assert.equal(diaANumero("blursday"), null);
  assert.equal(diaANumero(""), null);
}

// --- horas ---------------------------------------------------------------
{
  assert.equal(normalizarHora("8:30"), "08:30");
  assert.equal(normalizarHora("08:30"), "08:30");
  assert.equal(normalizarHora("8.30"), "08:30");
  assert.equal(normalizarHora(" 14:05 "), "14:05");
  assert.equal(normalizarHora("25:00"), null, "hora fuera de rango");
  assert.equal(normalizarHora("10:75"), null, "minutos fuera de rango");
  assert.equal(normalizarHora("mañana"), null);
  assert.equal(aMinutos("08:30"), 510);
}

// --- parseo del JSON pegado ---------------------------------------------
{
  const { bloques, errores } = parsearHorario(
    '[{"dia":"Lunes","inicio":"08:30","fin":"10:00","clase":"Micro"}]',
  );
  assert.equal(errores.length, 0);
  assert.deepEqual(bloques, [
    { dia: 1, inicio: "08:30", fin: "10:00", claseNombre: "Micro" },
  ]);
}

// --- la IA suele envolver el JSON en un bloque de código ------------------
{
  const pegado = `Claro, acá está tu horario:

\`\`\`json
[{"dia": "martes", "inicio": "9:00", "fin": "11:30", "clase": "Contabilidad"}]
\`\`\`

Avisame si querés que lo ajuste.`;
  const { bloques, errores } = parsearHorario(pegado);
  assert.equal(errores.length, 0, "el texto alrededor no debe romper el parseo");
  assert.equal(bloques.length, 1);
  assert.equal(bloques[0].inicio, "09:00");
}

// --- filas malas no descartan las buenas ---------------------------------
{
  const { bloques, errores } = parsearHorario(
    `[{"dia":"Lunes","inicio":"08:30","fin":"10:00","clase":"Micro"},
      {"dia":"Blursday","inicio":"08:30","fin":"10:00","clase":"X"},
      {"dia":"Martes","inicio":"12:00","fin":"11:00","clase":"Y"},
      {"dia":"Martes","inicio":"10:00","fin":"11:00","clase":""}]`,
  );
  assert.equal(bloques.length, 1, "solo la fila válida entra");
  assert.equal(errores.length, 3, "las otras tres reportan su motivo");
  assert.match(errores[1], /fin no puede ser anterior/);
}

// --- texto que no es JSON ------------------------------------------------
{
  const r = parsearHorario("no tengo tu horario, perdón");
  assert.equal(r.bloques.length, 0);
  assert.equal(r.errores.length, 1);
}

// --- clases conocidas vs nuevas -----------------------------------------
{
  const clases = [
    { id: "c1", nombre: "Microeconomía", color: "#000", creadaEn: "", unidades: [] },
  ];
  const { conocidas, nuevas } = clasificarNombres(
    [
      { dia: 1, inicio: "08:00", fin: "10:00", claseNombre: "microeconomia" },
      { dia: 2, inicio: "08:00", fin: "10:00", claseNombre: "Álgebra" },
      { dia: 3, inicio: "08:00", fin: "10:00", claseNombre: "Álgebra" },
    ],
    clases,
  );
  assert.equal(
    conocidas.get("microeconomia")?.id,
    "c1",
    "sin acento y en minúscula encuentra la clase existente",
  );
  assert.deepEqual(nuevas, ["Álgebra"], "la nueva aparece una sola vez");
}

// --- sugerencia por momento ----------------------------------------------
{
  const horario = [
    { id: "b1", dia: 1, inicio: "08:00", fin: "10:00", claseId: "c1" },
    { id: "b2", dia: 1, inicio: "14:00", fin: "16:00", claseId: "c2" },
  ];
  // Lunes 10 de agosto de 2026, 09:00.
  assert.equal(bloqueEn(horario, new Date(2026, 7, 10, 9, 0))?.id, "b1");
  // Justo en el límite superior: ya no pertenece al bloque.
  assert.equal(bloqueEn(horario, new Date(2026, 7, 10, 10, 0)), null);
  // Otro día a la misma hora.
  assert.equal(bloqueEn(horario, new Date(2026, 7, 11, 9, 0)), null);
}

// --- bloques superpuestos: no se adivina ---------------------------------
{
  const horario = [
    { id: "b1", dia: 1, inicio: "08:00", fin: "10:00", claseId: "c1" },
    { id: "b2", dia: 1, inicio: "09:00", fin: "11:00", claseId: "c2" },
  ];
  assert.equal(
    bloqueEn(horario, new Date(2026, 7, 10, 9, 30)),
    null,
    "con ambigüedad se deja sin sugerencia",
  );
}

// --- el prompt incluye los nombres reales --------------------------------
{
  const clases = [
    { id: "c1", nombre: "Microeconomía", color: "#000", creadaEn: "", unidades: [] },
  ];
  const p = armarPrompt("materias: {CLASES}", clases);
  assert.match(p, /"Microeconomía"/);
  assert.doesNotMatch(armarPrompt("materias: {CLASES}", []), /\{CLASES\}/);
}

// --- orden --------------------------------------------------------------
{
  const o = ordenarHorario([
    { id: "b1", dia: 3, inicio: "08:00", fin: "09:00", claseId: "c" },
    { id: "b2", dia: 1, inicio: "14:00", fin: "15:00", claseId: "c" },
    { id: "b3", dia: 1, inicio: "08:00", fin: "09:00", claseId: "c" },
  ]);
  assert.deepEqual(o.map((b) => b.id), ["b3", "b2", "b1"]);
}

console.log("horario: 10 casos OK");
