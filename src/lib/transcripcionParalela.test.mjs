/**
 * Test de la transcripción que corre junto a la grabación.
 *
 * Lo que se rompe en silencio acá es el pegado de las ventanas: si se cuela un
 * segmento repetido, el .txt queda con frases duplicadas en cada borde de
 * ventana y nadie lo nota hasta leer la clase entera.
 */
import assert from "node:assert/strict";

import { fusionarSegmentos } from "./transcripcionParalela.ts";

const seg = (desdeMs, hastaMs, texto) => ({ desdeMs, hastaMs, texto });

// Sin nada previo se queda con todo, y sin compartir el arreglo de entrada.
{
  const nuevos = [seg(0, 3000, "hola")];
  const salida = fusionarSegmentos([], nuevos);
  assert.deepEqual(salida, nuevos);
  assert.notEqual(salida, nuevos);
}

// El colchón de la última ventana repite lo que ya estaba: se descarta.
{
  const previos = [seg(0, 118000, "primera ventana")];
  const nuevos = [
    seg(116000, 119000, "primera ventana"),
    seg(120000, 124000, "esto es nuevo"),
  ];
  assert.deepEqual(fusionarSegmentos(previos, nuevos), [
    seg(0, 118000, "primera ventana"),
    seg(120000, 124000, "esto es nuevo"),
  ]);
}

// El segmento que arranca justo donde terminó el anterior no es un repetido.
{
  const previos = [seg(0, 120000, "a")];
  const nuevos = [seg(120000, 122000, "b")];
  assert.equal(fusionarSegmentos(previos, nuevos).length, 2);
}

// Una ventana entera de silencio no borra ni mueve lo ya transcrito.
{
  const previos = [seg(0, 120000, "a")];
  assert.deepEqual(fusionarSegmentos(previos, []), previos);
}

console.log("transcripcionParalela: OK");
