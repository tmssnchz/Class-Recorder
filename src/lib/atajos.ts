/**
 * Atajos de teclado.
 *
 * Se guardan en formato acelerador de Tauri ("Control+Shift+KeyR", "F9"), que
 * es el mismo que entiende el plugin global-shortcut. La parte de la tecla usa
 * los nombres de `KeyboardEvent.code`, así el mismo string sirve para el modo
 * global y para el listener dentro de la ventana.
 */

const MODIFICADORES = ["Control", "Alt", "Shift", "Super"] as const;

export function aceleradorDesdeEvento(e: KeyboardEvent): string | null {
  const code = e.code;
  // Una tecla modificadora sola no es un atajo válido.
  if (/^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(code)) return null;

  const partes: string[] = [];
  if (e.ctrlKey) partes.push("Control");
  if (e.altKey) partes.push("Alt");
  if (e.shiftKey) partes.push("Shift");
  if (e.metaKey) partes.push("Super");
  partes.push(code);
  return partes.join("+");
}

export function coincideAtajo(e: KeyboardEvent, acelerador: string): boolean {
  if (!acelerador) return false;
  const partes = acelerador.split("+");
  const tecla = partes[partes.length - 1];
  const mods = new Set(partes.slice(0, -1));

  if (e.code !== tecla) return false;
  if (e.ctrlKey !== (mods.has("Control") || mods.has("CommandOrControl"))) return false;
  if (e.altKey !== mods.has("Alt")) return false;
  if (e.shiftKey !== mods.has("Shift")) return false;
  if (e.metaKey !== mods.has("Super")) return false;
  return true;
}

/** "Control+Shift+KeyR" → "Ctrl + Shift + R" */
export function describirAtajo(acelerador: string): string {
  if (!acelerador) return "Sin asignar";
  return acelerador
    .split("+")
    .map((parte) => {
      if (parte === "Control" || parte === "CommandOrControl") return "Ctrl";
      if (parte === "Super") return "Win";
      if ((MODIFICADORES as readonly string[]).includes(parte)) return parte;
      return nombreDeTecla(parte);
    })
    .join(" + ");
}

function nombreDeTecla(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  const especiales: Record<string, string> = {
    Space: "Espacio",
    Enter: "Enter",
    Escape: "Esc",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    BracketLeft: "[",
    BracketRight: "]",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backslash: "\\",
    Minus: "-",
    Equal: "=",
    Backquote: "`",
  };
  return especiales[code] ?? code;
}

/** El foco está en un campo de texto: no hay que disparar atajos. */
export function escribiendoEnCampo(destino: EventTarget | null): boolean {
  const el = destino as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable
  );
}
