import { useSyncExternalStore } from "react";
import { DESK_QUERY, handheld, isDesk, keyboardIsOpen, ROOMY_QUERY } from "./viewport";

/**
 * How the reader operates the page, kept apart from how wide the page is.
 *
 * Width decides the layout (`isDesk`, `isWide`). These decide the interaction:
 * hover actions, a collapsed key row and drag selection belong to a mouse; large
 * targets, swipes and the on-screen keys belong to a finger. A landscape tablet
 * is a wide layout with touch input, and a narrow laptop window is the reverse.
 */

const FINE_POINTER = "(hover: hover) and (pointer: fine)";

function matches(query: string): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

/** The primary pointer hovers and is precise: a mouse or trackpad. */
export function pointerFine(): boolean {
  return matches(FINE_POINTER);
}

/** Some pointer on this device is a finger, so targets keep their touch size. */
export function hasTouch(): boolean {
  return matches("(any-pointer: coarse)");
}

let hardwareKeySeen = false;
const listeners = new Set<() => void>();

function setHardwareKeySeen(seen: boolean): void {
  if (hardwareKeySeen === seen) return;
  hardwareKeySeen = seen;
  for (const listener of [...listeners]) listener();
}

const EDITABLE = "input, textarea, select, [contenteditable='true']";

/**
 * An on-screen keyboard slides in over 300–400ms after its field is focused or
 * pressed, and the viewport reports it only once it has settled. A key typed
 * into a field says nothing about the keyboard until that has had time to show.
 */
const SOFT_KEYBOARD_RISE_MS = 1000;

/**
 * The field the reader last focused or pressed, and when: the moment an
 * on-screen keyboard would start to rise. `typed` and `softKeyboard` are what
 * has been seen in that focus since: a character typed with no on-screen
 * keyboard showing, and an on-screen keyboard showing at all.
 */
let engaged: { field: Element; at: number; typed: boolean; softKeyboard: boolean } | null = null;

function noteFieldEngaged(event: Event): void {
  const field = event.target instanceof Element ? event.target.closest(EDITABLE) : null;
  if (field) engaged = { field, at: performance.now(), typed: false, softKeyboard: false };
}

/** The settled on-screen keyboard, from either place the viewport publishes it. */
function softKeyboardUp(): boolean {
  return keyboardIsOpen() || (typeof document !== "undefined" && document.documentElement.dataset.kb === "open");
}

/** The navigation block of a keyboard: no on-screen keyboard draws it. */
const NAVIGATION_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "Delete", "Insert"]);

/** Keys no on-screen keyboard has: they prove a keyboard wherever focus is. */
function hardwareOnlyKey(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return true;
  return event.key === "Escape" || event.key === "Tab" || event.key.startsWith("Arrow")
    || NAVIGATION_KEYS.has(event.key) || /^F\d{1,2}$/.test(event.key);
}

/**
 * Whether a key typed into `field` came from a physical keyboard. An on-screen
 * keyboard produces keydown too, so the answer is yes only where one cannot be
 * the source: beside the list on a tablet or larger, and either a key it does
 * not have, or a character typed after the field has been focused and untouched
 * long enough for an on-screen keyboard to have shown, with none showing.
 * Return and Backspace never count by themselves: they are the two keys an
 * Android keyboard reports as real ones, and it can float clear of the viewport.
 *
 * A reader who taps the field and types at once has typed "ls" before that
 * wait is over, and the Return that follows would add a line, and keep adding
 * one. So a character typed during the wait is remembered: any key after the
 * wait, Return included, then counts, provided no on-screen keyboard has shown
 * in this focus. The characters are the evidence, as they are after the wait:
 * an Android keyboard reports its characters as composition placeholders, which
 * never get here, so its Return still has nothing to stand on.
 *
 * What neither rule can tell apart is an on-screen keyboard that reports real
 * characters and never moves the viewport (an iPad's floating keyboard): once
 * its field has been focused for the wait, its characters read as a hardware
 * keyboard's, and now its Return after an early character does too. Its own
 * Return key then sends instead of adding a line; the docked keyboard, which
 * the viewport reports, never gets that far.
 */
function fieldKeyIsHardware(event: KeyboardEvent, field: Element): boolean {
  if (!isDesk() || handheld()) return false;
  if (hardwareOnlyKey(event)) return true;
  if (engaged?.field !== field) return false;
  const character = event.key.length === 1;
  const waited = performance.now() - engaged.at >= SOFT_KEYBOARD_RISE_MS;
  const proves = waited && (character || (engaged.typed && !engaged.softKeyboard));
  if (character) engaged.typed = true;
  return proves;
}

/**
 * A key from a physical keyboard. There is no direct test for an attached
 * keyboard, so a touch device is assumed to have none until it proves
 * otherwise, and the proof has to be one an on-screen keyboard cannot produce:
 * a real key (not the composition placeholder some of them send), while no
 * keyboard inset is showing, with focus outside any field — an on-screen
 * keyboard only exists while a field is focused, including a floating one that
 * leaves the viewport alone. Inside a field the bar is higher; see
 * `fieldKeyIsHardware`.
 */
export function noteKeydown(event?: KeyboardEvent): void {
  if (softKeyboardUp()) {
    if (engaged) engaged.softKeyboard = true;
    return;
  }
  if (hardwareKeySeen) return;
  if (event) {
    if (event.isComposing || event.keyCode === 229 || event.key === "Unidentified" || event.key === "Process") return;
    const field = event.target instanceof Element ? event.target.closest(EDITABLE) : null;
    if (field && !fieldKeyIsHardware(event, field)) return;
  }
  setHardwareKeySeen(true);
}

/**
 * Typing reaches the page without an on-screen keyboard. A phone layout never
 * infers one: its Return key and focus rules stay exactly the phone's, whatever
 * keys its on-screen keyboard reports.
 */
export function hardwareKeyboard(): boolean {
  return pointerFine() || (hardwareKeySeen && isDesk());
}

/**
 * Tell `listener` when `hardwareKeyboard()` may have changed: a first physical
 * key, an on-screen keyboard taking the proof back, a mouse arriving or
 * leaving, or the layout crossing a tier.
 */
export function subscribeHardwareKeyboard(listener: () => void): () => void {
  listeners.add(listener);
  const lists = typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? [FINE_POINTER, DESK_QUERY, ROOMY_QUERY].map((query) => window.matchMedia(query))
    : [];
  for (const list of lists) list.addEventListener?.("change", listener);
  return () => {
    listeners.delete(listener);
    for (const list of lists) list.removeEventListener?.("change", listener);
  };
}

/**
 * `hardwareKeyboard()` for a component whose markup or copy follows it. A touch
 * tablet proves its keyboard with the first physical key, long after the page
 * has rendered: a field's Return rule, its fold and its hints change on that
 * key, in place.
 */
export function useHardwareKeyboard(): boolean {
  return useSyncExternalStore(subscribeHardwareKeyboard, hardwareKeyboard, () => false);
}

/**
 * Watch the page for what tells the two keyboards apart: keys, the field the
 * reader engages, and the on-screen keyboard itself. Once that one is showing,
 * the keyboard that proved itself is gone or set aside (a folded-back keyboard
 * case), so the proof is withdrawn and Return is a new line again until a
 * physical key says otherwise.
 */
export function bindInputMode(doc: Document = document): () => void {
  const keydown = (event: KeyboardEvent): void => noteKeydown(event);
  doc.addEventListener("keydown", keydown, true);
  doc.addEventListener("focusin", noteFieldEngaged, true);
  doc.addEventListener("pointerdown", noteFieldEngaged, true);
  const Observer = doc.defaultView?.MutationObserver;
  const observer = Observer ? new Observer(() => {
    if (!softKeyboardUp()) return;
    if (engaged) engaged.softKeyboard = true;
    setHardwareKeySeen(false);
  }) : null;
  observer?.observe(doc.documentElement, { attributes: true, attributeFilter: ["data-kb"] });
  return () => {
    doc.removeEventListener("keydown", keydown, true);
    doc.removeEventListener("focusin", noteFieldEngaged, true);
    doc.removeEventListener("pointerdown", noteFieldEngaged, true);
    observer?.disconnect();
  };
}

/** The platform whose Command key carries application shortcuts. */
export function macPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
}

/**
 * Search-and-jump has a shortcut only where it cannot collide: Command+K on
 * macOS. Elsewhere Ctrl+K is "kill line" in a terminal, so the search box is
 * the entry and no hint is shown.
 */
export function commandKOffered(): boolean {
  return hardwareKeyboard() && macPlatform();
}

export function resetInputMode(): void {
  engaged = null;
  setHardwareKeySeen(false);
}
