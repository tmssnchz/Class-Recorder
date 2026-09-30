/**
 * Varios motivos pueden pedir que el equipo no se suspenda (hay una grabación,
 * hay transcripciones en cola). Windows solo tiene un interruptor, así que
 * este control lo suelta recién cuando ya no queda ningún motivo activo.
 */
export function crearControlSuspension(aplicar: (evitar: boolean) => void) {
  const motivos = new Set<string>();
  return function fijar(motivo: string, activo: boolean): void {
    const antes = motivos.size > 0;
    if (activo) motivos.add(motivo);
    else motivos.delete(motivo);
    const ahora = motivos.size > 0;
    if (ahora !== antes) aplicar(ahora);
  };
}
