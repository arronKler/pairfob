import { type Modifier } from "./keys";
import { mapPadKey } from "./modifiers";
import { bindPadPress } from "./key-press";

export type { Modifier, KeySpec } from "./keys";
export { PRIMARY_KEYS, SECONDARY_KEYS, TERTIARY_KEYS } from "./keys";

const down = new Set<Modifier>();
const sticky = new Set<Modifier>();
const used = new Set<Modifier>();
const buttons: Array<{ el: HTMLElement; mod: Modifier }> = [];
const modifierListeners = new Set<() => void>();

function active(mod: Modifier): boolean {
  return down.has(mod) || sticky.has(mod);
}

export function modifierIsActive(mod: Modifier): boolean {
  return active(mod);
}

export function subscribeModifiers(onStoreChange: () => void): () => void {
  modifierListeners.add(onStoreChange);
  return () => { modifierListeners.delete(onStoreChange); };
}

export function modifierSnapshot(): string {
  const list = (set: Set<Modifier>) => [...set].sort().join(",");
  return `${list(down)}|${list(sticky)}|${list(used)}`;
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
  for (const listener of modifierListeners) listener();
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
  if (!down.delete(mod)) return;
  if (!used.has(mod)) {
    if (sticky.has(mod)) sticky.delete(mod);
    else sticky.add(mod);
  }
  paintAllModifiers();
}

/** Map a pad token through held Ctrl/Opt/Shift/Cmd onto SendKeys-legal tokens. */
export function withModifiers(key: string): string[] {
  const flags = {
    ctrl: active("ctrl"),
    alt: active("alt"),
    shift: active("shift"),
    cmd: active("cmd"),
  };
  if (flags.ctrl || flags.alt || flags.shift || flags.cmd) {
    used.add("ctrl");
    used.add("cmd");
    used.add("alt");
    used.add("shift");
    sticky.clear();
    paintAllModifiers();
  }
  return mapPadKey(key, flags);
}

export function bindModifier(element: HTMLElement, mod: Modifier): { stop: () => void; destroy: () => void } {
  const entry = { el: element, mod };
  buttons.push(entry);
  element.classList.add("key-mod");
  element.setAttribute("aria-pressed", "false");
  const press = bindPadPress(element, () => pressModifier(mod), {
    release(cancelled) {
      if (!cancelled) {
        releaseModifier(mod);
        return;
      }
      down.delete(mod);
      used.delete(mod);
      paintAllModifiers();
    },
  });
  const destroy = () => {
    press.destroy();
    const index = buttons.indexOf(entry);
    if (index >= 0) buttons.splice(index, 1);
  };
  return { stop: press.stop, destroy };
}
