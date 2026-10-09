/**
 * DOM effects and shared interaction exports.
 *
 * Press feedback and motion preference
 * live in `shared/ui/dom`, and the promise dialogs live in
 * `shared/ui/overlay/basic-dialogs`. Both are re-exported here so existing
 * callers have a stable import surface. This module also owns the
 * element factory, the app-wide ripple surface, and which desk column holds
 * the keyboard.
 */
export { askConfirm, askText, showHelp, type ConfirmRequest, type HelpBlock, type TextRequest } from "../shared/ui/overlay/basic-dialogs";
export { haptic, tapAck } from "../shared/ui/dom/feedback";
export { prefersReducedMotion } from "../shared/ui/dom/motion";

import { prefersReducedMotion } from "../shared/ui/dom/motion";

export function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/**
 * True while any native `<dialog>` is open (showModal or show). Used to gate
 * page-level typing so keys never reach a pane while a modal (e.g. the
 * attachment sheet) is up — even after focus has dropped to <body>. The
 * anchored menus and panels are native dialogs too, so they count; a surface
 * built without `<dialog>` joins by declaring itself a modal dialog.
 */
export function hasOpenDialog(): boolean {
  return document.querySelector("dialog[open], [role='dialog'][aria-modal='true']") !== null;
}

/**
 * A dialog that has to be answered or dismissed before anything else. An
 * anchored menu or panel is not one: a global shortcut may close it and go on.
 */
export function hasBlockingDialog(): boolean {
  return document.querySelector("dialog[open]:not([data-popover]), [role='dialog'][aria-modal='true']") !== null;
}

/**
 * Desk columns beside the session that keep the keyboard to themselves. The
 * shell marks the app root `inspector` while that column is open, so a column
 * is matched below the root, never as it.
 */
const ZONE_SELECTORS = ["#app .rail", "#app .inspector"];
export const KEYBOARD_ZONES = ZONE_SELECTORS.join(", ");

/** Top-layer surfaces that borrow the keyboard for as long as they are open. */
const OVERLAYS = "dialog, [popover], [role='dialog'], [role='menu'], [role='listbox']";

let heldZone: Element | null = null;
/** Which column was held, so the hold outlives the node when the column is rebuilt. */
let heldSelector = "";
let moves = 0;

/**
 * How many times the reader has pressed or moved focus on the page, a visit to
 * a dialog, menu or panel aside. Two readings that agree mean they have done
 * neither in between: whatever was handed the keyboard then still has it.
 */
export function keyboardMoves(): number {
  return moves;
}

/**
 * The zone the reader last pressed or focused in, while it is still on screen.
 * A press on non-focusable content (a diff line, a list heading) leaves focus
 * on <body>; the column still holds the keyboard until the reader presses or
 * focuses somewhere else, so the session must neither read those keys nor pull
 * focus back to itself.
 */
export function heldKeyboardZone(): Element | null {
  if (heldZone?.isConnected) return heldZone;
  // A column that left and came back (the inspector across a rotation or a
  // narrow window) is a new node holding the same place: the reader has not
  // pressed anywhere else since, so the keyboard is still theirs there.
  if (heldSelector) heldZone = document.querySelector(heldSelector);
  return heldZone;
}

export function bindKeyboardZones(root: Document): () => void {
  const note = (event: Event): void => {
    // Icons are SVG elements, not HTMLElements, and a press usually lands on one.
    const target = event.target as Partial<Element> | null;
    if (typeof target?.closest !== "function") {
      moves += 1;
      heldZone = null;
      heldSelector = "";
      return;
    }
    // A dialog, menu or panel is a visit, not a move: the column that opened it
    // still holds the keyboard when it closes and focus falls back to <body>.
    if (target.closest(OVERLAYS)) return;
    moves += 1;
    heldZone = target.closest(KEYBOARD_ZONES);
    heldSelector = heldZone ? ZONE_SELECTORS.find(selector => heldZone?.matches(selector)) ?? "" : "";
  };
  root.addEventListener("pointerdown", note, true);
  root.addEventListener("focusin", note);
  return () => {
    root.removeEventListener("pointerdown", note, true);
    root.removeEventListener("focusin", note);
    heldZone = null;
    heldSelector = "";
  };
}

const RIPPLE_MS = 520;

/** Selectors whose geometry motion.css prepares as a ripple host. */
export const RIPPLE_ACTIONS = ".btn-primary, .btn-scan, .send-btn, .card-main, .menu-item";

function spawnRipple(host: HTMLElement, clientX: number, clientY: number): void {
  if (prefersReducedMotion() || host.matches(":disabled, [aria-disabled='true']")) return;
  const box = host.getBoundingClientRect();
  if (!box.width || !box.height) return;
  const x = clientX - box.left;
  const y = clientY - box.top;
  const ink = node("span", "ripple");
  ink.style.left = `${x}px`;
  ink.style.top = `${y}px`;
  const reach = Math.hypot(Math.max(x, box.width - x), Math.max(y, box.height - y));
  ink.style.width = `${reach * 2}px`;
  ink.style.height = `${reach * 2}px`;
  host.append(ink);
  setTimeout(() => ink.remove(), RIPPLE_MS);
}

/** One document listener covers React controls and dialogs across route changes. */
export function bindRippleSurface(root: Document | HTMLElement, selector = RIPPLE_ACTIONS): () => void {
  const onPointerDown = (event: Event): void => {
    if (!(event instanceof PointerEvent) || event.button !== 0) return;
    const host = (event.target as Element | null)?.closest?.(selector);
    if (host instanceof HTMLElement) spawnRipple(host, event.clientX, event.clientY);
  };
  root.addEventListener("pointerdown", onPointerDown);
  return () => {
    root.removeEventListener("pointerdown", onPointerDown);
  };
}
