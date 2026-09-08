/**
 * Organización previa de una tanda de fotos: a qué apunte va cada hoja y en qué
 * orden queda dentro de él.
 *
 * Existe para el caso de la primera importación grande, que es distinto del uso
 * normal. Escaneando el cuaderno de la semana, las cuatro o cinco fotos van
 * todas al mismo apunte y el número del marcador las ordena solo. Pero una tanda
 * de hojas viejas que se imprimieron en varias corridas y después se
 * desordenaron físicamente no tiene ninguna de las dos cosas: los números se
 * repiten entre corridas, y el orden en que se sacaron las fotos no agrupa nada.
 * Ahí la única fuente de verdad es el contenido de la hoja, o sea el ojo del
 * usuario, y lo que hace falta es una pantalla donde verlas todas juntas.
 *
 * Todo lo de este archivo es puro: decide asignaciones sobre listas de rutas y
 * no toca disco. Los archivos recién se escriben después, en el modo ráfaga.
 */

/** Un apunte en construcción: su destino y las fotos que ya se le asignaron. */
export interface GrupoOrganizado {
  /** Id interno de esta sesión de organización, no el id final del apunte. */
  clave: string;
  claseId: string | null;
  unidadId: string | null;
  titulo: string;
  /** Rutas de las fotos, ya en el orden que van a tener como páginas. */
  fotos: string[];
}

/**
 * Número de página que trajo el marcador de cada foto. `null` cuando no se pudo
 * leer, que es un caso normal: una esquina con sombra o comida por el anillado.
 */
export type NumerosDeFoto = Map<string, number | null>;

/**
 * Orden en que se muestran las fotos sin asignar.
 *
 * Por número de marcador, y las que no trajeron ninguno al final en el orden en
 * que se sacaron. Con los números repetidos entre corridas de impresión esto no
 * reconstruye el cuaderno, pero sí deja juntas las hojas de una misma corrida
 * —que son las que probablemente vayan al mismo apunte— y pone las "página 5"
 * duplicadas una al lado de la otra, que es justo donde hay que mirar.
 */
export function ordenDelMeson(fotos: string[], numeros: NumerosDeFoto): string[] {
  const indice = new Map(fotos.map((f, i) => [f, i]));
  return [...fotos].sort((a, b) => {
    const na = numeros.get(a) ?? null;
    const nb = numeros.get(b) ?? null;
    if (na === null && nb === null) return indice.get(a)! - indice.get(b)!;
    if (na === null) return 1;
    if (nb === null) return -1;
    // Empate de número: dos hojas de corridas distintas. El orden en que se
    // sacaron las fotos es lo único que las separa, y las deja adyacentes.
    return na - nb || indice.get(a)! - indice.get(b)!;
  });
}

/**
 * Números de página que aparecen en más de una foto.
 *
 * Se marcan en la interfaz porque son la señal visible de que hubo varias
 * corridas de impresión: donde hay repetidos, el número no alcanza para ordenar
 * y hay que mirar el contenido.
 */
export function numerosRepetidos(fotos: string[], numeros: NumerosDeFoto): Set<number> {
  const vistos = new Set<number>();
  const repetidos = new Set<number>();
  for (const f of fotos) {
    const n = numeros.get(f) ?? null;
    if (n === null) continue;
    if (vistos.has(n)) repetidos.add(n);
    vistos.add(n);
  }
  return repetidos;
}

/**
 * Asigna fotos a un grupo, sacándolas de cualquier otro donde estuvieran.
 *
 * Las que ya estaban en ese mismo grupo no se mueven de lugar: reasignar una
 * selección que incluye alguna hoja ya puesta no debería reordenar el apunte.
 * Las nuevas se agregan al final, en el orden en que vienen.
 */
export function asignar(
  grupos: GrupoOrganizado[],
  clave: string,
  fotos: string[],
): GrupoOrganizado[] {
  const entrantes = new Set(fotos);
  return grupos.map((g) => {
    if (g.clave !== clave) {
      return { ...g, fotos: g.fotos.filter((f) => !entrantes.has(f)) };
    }
    const nuevas = fotos.filter((f) => !g.fotos.includes(f));
    return { ...g, fotos: [...g.fotos, ...nuevas] };
  });
}

/** Saca fotos de todos los grupos: vuelven al mesón. */
export function devolverAlMeson(
  grupos: GrupoOrganizado[],
  fotos: string[],
): GrupoOrganizado[] {
  const salientes = new Set(fotos);
  return grupos.map((g) => ({ ...g, fotos: g.fotos.filter((f) => !salientes.has(f)) }));
}

/**
 * Mueve una foto dentro de su grupo, de la posición `desde` a la `hacia`.
 *
 * Es lo que arregla el orden de páginas cuando el número del marcador no sirve,
 * que en una tanda con números repetidos es la mitad de las hojas.
 */
export function moverEnGrupo(
  grupos: GrupoOrganizado[],
  clave: string,
  desde: number,
  hacia: number,
): GrupoOrganizado[] {
  return grupos.map((g) => {
    if (g.clave !== clave) return g;
    if (desde < 0 || desde >= g.fotos.length || hacia < 0 || hacia >= g.fotos.length) return g;
    const fotos = [...g.fotos];
    const [movida] = fotos.splice(desde, 1);
    fotos.splice(hacia, 0, movida);
    return { ...g, fotos };
  });
}

/**
 * Reordena un grupo por el número de página del marcador.
 *
 * Es el atajo para el caso normal: con la mayoría de las hojas numeradas, el
 * orden correcto ya lo sabe la app y no tiene por qué armarlo el usuario a mano.
 * Las que no traen número se van al final conservando el orden que tenían, que
 * es donde el usuario las va a querer acomodar.
 *
 * No es automático a propósito: en una tanda con números repetidos entre
 * corridas de impresión, ordenar por número puede empeorar un orden que el
 * usuario ya arregló mirando el contenido. Que sea un botón lo deja elegir.
 */
export function ordenarGrupoPorPagina(
  grupos: GrupoOrganizado[],
  clave: string,
  numeros: NumerosDeFoto,
): GrupoOrganizado[] {
  return grupos.map((g) => (g.clave === clave ? { ...g, fotos: ordenDelMeson(g.fotos, numeros) } : g));
}

/** Fotos que todavía no están en ningún grupo, en el orden que reciben. */
export function sinAsignar(fotos: string[], grupos: GrupoOrganizado[]): string[] {
  const asignadas = new Set(grupos.flatMap((g) => g.fotos));
  return fotos.filter((f) => !asignadas.has(f));
}

/**
 * Posición final de cada foto dentro de su grupo, para el modo ráfaga.
 *
 * La ráfaga ya sabe ordenar las páginas de un apunte a partir de un número por
 * foto —lo usa con el número del marcador—, así que alcanza con darle esta
 * posición en vez de aquel y el orden que se armó acá se respeta tal cual,
 * incluso si una hoja quedó pendiente y se confirmó al final de la tanda.
 */
export function posicionesEnGrupo(grupos: GrupoOrganizado[]): Map<string, number> {
  const posiciones = new Map<string, number>();
  for (const g of grupos) {
    g.fotos.forEach((f, i) => posiciones.set(f, i + 1));
  }
  return posiciones;
}
