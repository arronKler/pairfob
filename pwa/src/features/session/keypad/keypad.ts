import { type Modifier } from "./keys";
import { mapPadKey } from "./modifiers";
import { bindPadPress } from "./key-press";

export type { Modifier, KeySpec } from "./keys";
export { PRIMARY_KEYS, PAGE_KEYS, SECONDARY_KEYS, TERTIARY_KEYS, EXPANDED_KEYS, EXTRA_KEYS, KEY_PAGES } from "./keys";

const down = new Set<Modifier>();
const sticky = new Set<Modifier>();
const locked = new Set<Modifier>();
export const MODIFIER_DOUBLE_TAP_MS = 350;
const pressedAt = new Map<Modifier, number>();
let lastTap: { mod: Modifier; at: number } | null = null;

const used = new Set<Modifier>();
const buttons: Array<{ el: HTMLElement; mod: Modifier }> = [];
const modifierListeners = new Set<() => void>();

function active(mod: Modifier): boolean {
  return down.has(mod) || sticky.has(mod) || locked.has(mod);
}

export function modifierIsLocked(mod: Modifier): boolean {
  return locked.has(mod);
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
  return `${list(down)}|${list(sticky)}|${list(used)}|${list(locked)}`;
}

function paintModifier(el: HTMLElement, mod: Modifier): void {
  const on = active(mod);
  el.classList.toggle("on", on);
  el.classList.toggle("is-locked", locked.has(mod));
  el.dataset.locked = String(locked.has(mod));
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
  pressedAt.clear();
  lastTap = null;
  sticky.clear();
  locked.clear();
  used.clear();
  paintAllModifiers();
}

export function pressModifier(mod: Modifier): void {
  down.add(mod);
  pressedAt.set(mod, performance.now());
  if (lastTap?.mod !== mod) lastTap = null;
  used.delete(mod);
  paintAllModifiers();
}

export function releaseModifier(mod: Modifier): void {
  if (!down.delete(mod)) return;
  const now = performance.now();
  const shortTap = now - (pressedAt.get(mod) ?? now) <= MODIFIER_DOUBLE_TAP_MS;
  pressedAt.delete(mod);
  const doubleTap = shortTap && lastTap?.mod === mod && now - lastTap.at <= MODIFIER_DOUBLE_TAP_MS;
  lastTap = null;
  if (!used.has(mod)) {
    if (locked.has(mod)) locked.delete(mod);
    else if (doubleTap && sticky.has(mod)) {
      sticky.delete(mod);
      locked.add(mod);
    } else if (sticky.has(mod)) sticky.delete(mod);
    else {
      sticky.add(mod);
      if (shortTap) lastTap = { mod, at: now };
    }
  }
  paintAllModifiers();
}

/** Apply held/latched modifiers to logical keys; transports encode the chords. */
export function withModifiers(key: string): string[] {
  lastTap = null;
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
  paintModifier(element, mod);
  const preventMenu = (event: Event) => event.preventDefault();
  element.addEventListener("contextmenu", preventMenu);
  const press = bindPadPress(element, () => pressModifier(mod), {
    release(cancelled) {
      if (!cancelled) {
        releaseModifier(mod);
        return;
      }
      lastTap = null;
      pressedAt.delete(mod);
      down.delete(mod);
      used.delete(mod);
      paintAllModifiers();
    },
  });
  const destroy = () => {
    press.destroy();
    element.removeEventListener("contextmenu", preventMenu);
    const index = buttons.indexOf(entry);
    if (index >= 0) buttons.splice(index, 1);
  };
  return { stop: press.stop, destroy };
}
