import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { isDesk } from "../dom/width-tier";
import { placePopover, popoverBox, popoverOrphaned, popoverReturn, TRIGGER_OPEN, type PopoverKind, type PopoverTarget } from "./popover";

/**
 * How the enclosing sheet is presented: null for the bottom sheet. Rows read it
 * to take menu semantics only where the surface really is a menu.
 */
export const PopoverKindContext = createContext<PopoverKind | null>(null);

/** `menuitem` inside a popover menu; a sheet row stays a plain button. */
export function useMenuItemRole(): "menuitem" | undefined {
  return useContext(PopoverKindContext) === "menu" ? "menuitem" : undefined;
}

const ITEM = "[role='menuitem']:not(:disabled)";
const FIELD = "input, textarea, select, [contenteditable='true']";

/** Arrow keys walk the commands and wrap; Home and End reach the ends. */
function moveFocus(dialog: HTMLElement, event: KeyboardEvent): void {
  const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
  if (!step && event.key !== "Home" && event.key !== "End") return;
  if (event.target instanceof HTMLElement && event.target.closest(FIELD)) return;
  const items = [...dialog.querySelectorAll<HTMLElement>(ITEM)];
  if (!items.length) return;
  event.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
    : at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length;
  items[next].focus();
}

const FOCUSABLE = "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]";
const BODY = ".sheet-body";

/**
 * Where focus is in a dialog, as a place that outlives a redraw: the body or
 * the chrome around it, and the control's turn there. One count over the whole
 * dialog would not do. The close control is written in the head of a sheet and
 * after the body of a desk card, so the same command has another number in each.
 */
export type FocusPlace = { body: boolean; at: number };

function controlsIn(dialog: HTMLElement, body: boolean): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(control => (control.closest(BODY) !== null) === body);
}

export function focusPlace(dialog: HTMLElement): FocusPlace | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !dialog.contains(active)) return null;
  const body = active.closest(BODY) !== null;
  const at = controlsIn(dialog, body).indexOf(active);
  return at < 0 ? null : { body, at };
}

export function controlAt(dialog: HTMLElement, place: FocusPlace): HTMLElement | null {
  return controlsIn(dialog, place.body)[place.at] ?? null;
}

/**
 * What the reader would lose with the dialog: a page they went into (a form or
 * a detail, which is what a sheet pushes) or something typed in a field. A flat
 * list of commands holds nothing.
 */
function holdsWork(dialog: HTMLElement): boolean {
  if (dialog.querySelector(".sheet-back")) return true;
  return [...dialog.querySelectorAll<HTMLElement>(FIELD)].some(field => {
    if (field instanceof HTMLTextAreaElement) return field.value !== "";
    if (field instanceof HTMLInputElement) return field.value !== "" && field.type !== "checkbox" && field.type !== "radio";
    return field.isContentEditable && !!field.textContent;
  });
}

/** Frames a trigger must stay away before its popover gives up on it: the shell draws a replaced control in the same pass or the next. */
const ORPHAN_FRAMES = 2;

/**
 * What the sheet is anchored to right now, or null while it is not anchored.
 * A popover follows the window the way the desk form does: dragged down to the
 * phone layout the same dialog is handed to the bottom sheet with everything
 * the reader left in it (a typed name, a pushed page, the scroll), and widened
 * again it hangs from its trigger once more, or is the desk card when nothing
 * is left to hang from.
 *
 * The way back is decided a frame after the resize: the shell draws its
 * columns for the new width in between, and the trigger with them.
 *
 * Inside the desk tier the trigger can leave too: its column steps aside for
 * a narrower window, its row goes, the shell draws the control again as
 * another element (`popoverOrphaned`). The popover then hangs from that
 * control's new instance when there is one. With none it closes, as Escape
 * would, because a menu floating over another column still acts on something
 * the reader can no longer see. One that holds the reader's work (`holdsWork`)
 * is not thrown away: it becomes the desk card and keeps everything in it.
 * Whether the trigger left while the dialog was a sheet is asked only when it
 * is anchored again, and the answer there is the card.
 *
 * Rows change role between a menu and a sheet, and a titled section changes
 * its wrapper, which remounts the row that held focus. Focus is put back on the
 * control at the same place in the dialog (`focusPlace`).
 */
export function usePopoverPresentation(dialog: RefObject<HTMLDialogElement | null>, target: PopoverTarget | null): PopoverTarget | null {
  const [anchor, setAnchor] = useState(target);
  const latest = useRef(anchor);
  latest.current = anchor;
  const focused = useRef<FocusPlace | null>(null);
  useEffect(() => {
    if (!target) return;
    // The trigger as last seen, so a second trip starts from the control the first one found.
    let known = target;
    let frame = 0;
    const present = (next: PopoverTarget | null) => {
      if (next === latest.current) return;
      const element = dialog.current;
      if (element) focused.current = focusPlace(element);
      if (next) known = next;
      setAnchor(next);
    };
    const resized = () => {
      cancelAnimationFrame(frame);
      if (!isDesk()) present(null);
      else if (!latest.current) frame = requestAnimationFrame(() => { if (isDesk() && !latest.current) present(popoverReturn(known)); });
    };
    window.addEventListener("resize", resized);
    let away = 0;
    let watch = requestAnimationFrame(function next() {
      watch = requestAnimationFrame(next);
      const shown = latest.current;
      const element = dialog.current;
      if (!shown || !element?.open || !isDesk() || !popoverOrphaned(shown)) { away = 0; return; }
      if (++away < ORPHAN_FRAMES) return;
      away = 0;
      const again = popoverReturn(shown);
      if (again || holdsWork(element)) present(again);
      else element.close("cancel");
    });
    return () => {
      window.removeEventListener("resize", resized);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(watch);
    };
  }, [dialog, target]);
  useLayoutEffect(() => {
    const place = focused.current;
    focused.current = null;
    const element = dialog.current;
    if (!place || !element || element.contains(document.activeElement)) return;
    controlAt(element, place)?.focus({ preventScroll: true });
  }, [dialog, anchor]);
  return anchor;
}

/**
 * Bind an open dialog to its anchor. Runs after the dialog lifecycle has shown
 * it, so the first measurement is of the laid-out popover and nothing paints at
 * the default position. A mouse press outside closes it at once: unlike a
 * sheet's backdrop there is no opening click to guard against, because a
 * popover never opens under a finger.
 *
 * It stays bound for as long as it is open. The page under it keeps moving
 * after the window has changed size: the shell lays its columns out again, the
 * board fits its camera to the new stage from a `ResizeObserver`, a rotating
 * tablet does both. None of that raises an event here, so every frame asks what
 * a placement depends on (the trigger's box, the window, the popover's own
 * size) and places again only when one of them has changed.
 *
 * A frame callback runs before that frame's layout, so on its own it would
 * draw the popover one frame behind a trigger the page moves from a resize
 * observer of its own. This one is made later than any the page already has
 * and so is told after them, in the same frame: the popover is drawn where the
 * trigger is drawn.
 */
export function usePopover(dialog: RefObject<HTMLDialogElement | null>, target: PopoverTarget | null, dismiss: () => void): void {
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element || !target) return;
    const viewport = () => {
      const root = document.documentElement;
      return { width: root.clientWidth || window.innerWidth, height: root.clientHeight || window.innerHeight };
    };
    // Rounded: a box that drifts by a fraction of a pixel is the same place to hang from.
    const seen = () => {
      const box = popoverBox(target)?.box;
      const size = element.getBoundingClientRect();
      const { width, height } = viewport();
      return [box?.left, box?.top, box?.right, box?.bottom, width, height, size.width, size.height]
        .map(value => value === undefined ? "" : Math.round(value)).join();
    };
    let placed = "";
    const place = () => {
      const anchor = popoverBox(target);
      // Measure the natural size: a height limit from an earlier, smaller window must not shape this one.
      element.style.maxHeight = "";
      const size = element.getBoundingClientRect();
      const spot = placePopover(target.kind, anchor?.box ?? null, size, viewport(), anchor?.atPoint);
      element.style.left = `${Math.round(spot.left)}px`;
      element.style.top = `${Math.round(spot.top)}px`;
      element.style.maxHeight = `${Math.round(spot.maxHeight)}px`;
      placed = seen();
    };
    // Marked first: a trigger that folds away unless it is pointed at is placed against as the open one.
    target.anchor?.setAttribute(TRIGGER_OPEN, target.kind);
    place();
    // Only a trigger that announces a popup gains the expanded state, and never
    // one that already uses the attribute for something of its own (a heading
    // that folds its group).
    const announces = target.anchor?.hasAttribute("aria-haspopup") === true && !target.anchor.hasAttribute("aria-expanded");
    if (announces) target.anchor?.setAttribute("aria-expanded", "true");
    const lifetime = new AbortController();
    const { signal } = lifetime;
    // Below the desk tier the owner hands the dialog to the sheet (`usePopoverPresentation`).
    window.addEventListener("resize", () => { if (isDesk()) place(); }, { signal });
    const follow = () => { if (element.open && isDesk() && seen() !== placed) place(); };
    let frame = requestAnimationFrame(function next() {
      frame = requestAnimationFrame(next);
      follow();
    });
    const boxes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(follow);
    boxes?.observe(document.documentElement);
    boxes?.observe(element);
    if (target.anchor) boxes?.observe(target.anchor);
    element.addEventListener("pointerdown", (event) => {
      // A tap's click is hit-tested after the finger lifts and would land on the
      // page under a popover already gone; the backdrop click closes it instead.
      if (event.pointerType !== "mouse") return;
      const box = element.getBoundingClientRect();
      const outside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
      if (event.target === element && outside) dismiss();
    }, { signal });
    if (target.kind === "menu") element.addEventListener("keydown", event => moveFocus(element, event), { signal });
    return () => {
      lifetime.abort();
      cancelAnimationFrame(frame);
      boxes?.disconnect();
      // As a sheet the dialog sits where its own rules put it.
      element.style.left = "";
      element.style.top = "";
      element.style.maxHeight = "";
      target.anchor?.removeAttribute(TRIGGER_OPEN);
      if (announces) target.anchor?.removeAttribute("aria-expanded");
    };
  }, [dialog, target, dismiss]);
}
