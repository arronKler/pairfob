import { node } from "../lib/dom";

export type Modifier = "ctrl" | "alt" | "shift" | "cmd";

export type KeySpec = {
  key: string;
  label?: string;
  aria?: string;
  repeat?: boolean;
  modifier?: Modifier;
};

/** Primary phone row: escape, movement, delete. */
export const PRIMARY_KEYS: KeySpec[] = [
  { key: "esc", label: "Esc" },
  { key: "up", label: "↑", aria: "上箭头", repeat: true },
  { key: "down", label: "↓", aria: "下箭头", repeat: true },
  { key: "left", label: "←", aria: "左箭头", repeat: true },
  { key: "right", label: "→", aria: "右箭头", repeat: true },
  { key: "backspace", label: "⌫", aria: "退格", repeat: true },
];

export const SECONDARY_KEYS: KeySpec[] = [
  { key: "tab", label: "Tab" },
  { key: "enter", label: "Enter" },
  { key: "ctrl+c", label: "Ctrl+C" },
  { key: "ctrl+z", label: "Ctrl+Z" },
  { key: "ctrl+d", label: "Ctrl+D" },
  { key: "ctrl+l", label: "Ctrl+L" },
];

/**
 * Extra row when expanded. Ctrl/Opt/Shift/Cmd are holds: press to latch,
 * hold while tapping another pad key, tap again to cancel. Herdr only takes
 * ctrl+[a-z] plus named keys, so Opt/Shift remap onto that table.
 */
export const TERTIARY_KEYS: KeySpec[] = [
  { key: "ctrl", label: "Ctrl", aria: "Control", modifier: "ctrl" },
  { key: "alt", label: "Opt", aria: "Option", modifier: "alt" },
  { key: "shift", label: "Shift", aria: "Shift", modifier: "shift" },
  { key: "cmd", label: "Cmd", aria: "Command", modifier: "cmd" },
  { key: "ctrl+a", label: "Ctrl+A", repeat: true },
  { key: "ctrl+e", label: "Ctrl+E", repeat: true },
  { key: "ctrl+k", label: "Ctrl+K", repeat: true },
];

const down = new Set<Modifier>();
const sticky = new Set<Modifier>();
const used = new Set<Modifier>();
const buttons: Array<{ el: HTMLElement; mod: Modifier }> = [];

function active(mod: Modifier): boolean {
  return down.has(mod) || sticky.has(mod);
}

function paintModifier(el: HTMLElement, mod: Modifier): void {
  const on = active(mod);
  el.classList.toggle("on", on);
  el.setAttribute("aria-pressed", on ? "true" : "false");
}

function paintAllModifiers(): void {
  for (let i = buttons.length - 1; i >= 0; i--) {
    if (!buttons[i].el.isConnected) {
      buttons.splice(i, 1);
      continue;
    }
    paintModifier(buttons[i].el, buttons[i].mod);
  }
}

export function clearModifiers(): void {
  down.clear();
  sticky.clear();
  used.clear();
  paintAllModifiers();
}

export function pressModifier(mod: Modifier): void {
  down.add(mod);
  used.delete(mod);
  paintAllModifiers();
}

export function releaseModifier(mod: Modifier): void {
  down.delete(mod);
  if (!used.has(mod)) {
    if (sticky.has(mod)) sticky.delete(mod);
    else sticky.add(mod);
  }
  paintAllModifiers();
}

/** Map a pad token through held Ctrl/Opt/Shift/Cmd onto SendKeys-legal tokens. */
export function withModifiers(key: string): string[] {
  const ctrl = active("ctrl") || active("cmd");
  const alt = active("alt");
  const shift = active("shift");
  if (ctrl || alt || shift) {
    used.add("ctrl");
    used.add("cmd");
    used.add("alt");
    used.add("shift");
    sticky.clear();
    paintAllModifiers();
  }
  const letter = /^ctrl\+([a-z])$/.exec(key)?.[1] ?? (/^[a-z]$/i.test(key) ? key.toLowerCase() : "");
  if (ctrl && letter) return [`ctrl+${letter}`];
  if (ctrl) return [];
  if (alt) {
    if (key === "left") return ["esc", "b"];
    if (key === "right") return ["esc", "f"];
    if (key === "backspace") return ["ctrl+w"];
    if (letter) return ["esc", letter];
    return [];
  }
  if (shift && letter) return [letter.toUpperCase()];
  if (shift && key.length === 1) return [key.toUpperCase()];
  return [key];
}

export function bindModifier(element: HTMLElement, mod: Modifier): void {
  buttons.push({ el: element, mod });
  element.classList.add("key-mod");
  element.setAttribute("aria-pressed", "false");
  element.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    pressModifier(mod);
  });
  const end = () => releaseModifier(mod);
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
    element.addEventListener(type, end);
  }
}

export function paintKey(spec: KeySpec): HTMLButtonElement {
  const el = node("button", spec.modifier ? "key key-mod" : "key", spec.label ?? "");
  el.type = "button";
  const name = spec.aria ?? spec.label;
  if (name) el.setAttribute("aria-label", name);
  if (spec.modifier) el.setAttribute("aria-pressed", "false");
  return el;
}
