import { useLayoutEffect, type RefObject } from "react";
import { hardwareKeyboard } from "../../../app/input-mode";
import { sessionChosenTakes } from "../../session/key-target";

/**
 * The rail's session list as one stop for the keyboard.
 *
 * Every row is a button followed by its own two or three (read, pin, more),
 * and every heading by its marks and tools: left to Tab, the sixth row of a
 * busy list is some thirty presses away. So the list takes one Tab stop, and
 * inside it the arrows do the walking:
 *
 * - Tab arrives on the session that is open (else the first heading or row),
 *   and the next Tab leaves, whichever control of the list it was pressed on.
 * - Up and Down step through headings and rows in the order they are drawn,
 *   past the rows of a folded group; Home and End go to the ends.
 * - Right goes into what a stop has of its own: a row's actions, a heading's
 *   marks and tools, one at a time. On a folded heading it unfolds the group
 *   first. A row that keeps its actions behind a swipe (a touch screen with a
 *   keyboard) opens its menu instead, as the context-menu key does.
 * - Left comes back out the same way; on an unfolded heading it folds the
 *   group, and on a row it goes to the heading the row sits under.
 * - Enter and Space press whatever has focus, as they always did, and the
 *   context-menu key or Shift+F10 opens a row's or a heading's menu.
 *
 * Nothing typed here is searched for: a letter belongs to the session only
 * while the session holds the keyboard, and is nobody's otherwise. One case is
 * the session's although focus is on a row: the press that opened a session
 * leaves focus there, and what is typed next is meant for it (`key-target`).
 * Those keys are left alone, arrows included.
 *
 * The rows stay the buttons they are, in lists a screen reader counts
 * (`role="list"` on a group's body, `listitem` on a row). A listbox would turn
 * opening a session into selecting an option and has no place for a row's own
 * buttons, which an option may not contain.
 *
 * This is bound to the DOM the list draws, not threaded through its props:
 * which control is the one stop follows focus, and a row that arrives later
 * (a new session, a group unfolded) must not add stops of its own.
 */
const LIST = ".herd-list";
const HEADING = ".group-title";
const ROW = ".card-main";
const STOP = `${HEADING}, ${ROW}`;
/** A stop's own controls. A row's actions behind a swipe are out of reach and not among them. */
const INNER = ".card-actions:not([aria-hidden='true']) .card-action, .group-mark, .group-tool";

const shown = (control: Element) => control.closest("[hidden]") === null;

function stopsOf(list: Element): HTMLElement[] {
  return [...list.querySelectorAll<HTMLElement>(STOP)].filter(shown);
}

/** The heading or row a control belongs to; itself, when it is one. */
function stopOf(control: Element): HTMLElement | null {
  if (control.matches(STOP)) return control as HTMLElement;
  if (!control.matches(INNER)) return null;
  return control.closest(".card")?.querySelector<HTMLElement>(ROW)
    ?? control.closest(".group-head")?.querySelector<HTMLElement>(HEADING) ?? null;
}

function innerOf(stop: Element): HTMLElement[] {
  const scope = stop.matches(ROW) ? stop.closest(".card") : stop.closest(".group-head");
  return [...scope?.querySelectorAll<HTMLButtonElement>(INNER) ?? []].filter(control => !control.disabled);
}

/** Where Tab arrives: the open session's row, else the top of the list. */
function homeOf(list: Element): HTMLElement | null {
  const stops = stopsOf(list);
  return stops.find(stop => stop.getAttribute("aria-pressed") === "true") ?? stops[0] ?? null;
}

/** One control of the list answers Tab: the one with focus, else where Tab should arrive. */
function syncStops(list: Element): void {
  const controls = [...list.querySelectorAll<HTMLElement>(`${STOP}, ${INNER}`)];
  const active = document.activeElement;
  const current = controls.find(control => control === active) ?? homeOf(list);
  for (const control of controls) {
    const index = control === current ? 0 : -1;
    if (control.tabIndex !== index) control.tabIndex = index;
  }
}

/** What a control is, in words that outlive its element: whose it is, and which of that stop's controls. */
type Place = { stop: string; part: string };

function placeOf(control: HTMLElement): Place | null {
  const stop = stopOf(control);
  if (!stop) return null;
  const owner = stop.dataset.paneId ? `row:${stop.dataset.paneId}` : `group:${stop.dataset.triggerOf ?? ""}`;
  return { stop: owner, part: control === stop ? "" : `${control.className}|${control.dataset.triggerOf ?? ""}` };
}

function controlAt(list: Element, place: Place): HTMLElement | null {
  const stop = stopsOf(list).find(candidate => placeOf(candidate)?.stop === place.stop);
  if (!stop || !place.part) return stop ?? null;
  return innerOf(stop).find(control => placeOf(control)?.part === place.part) ?? stop;
}

function openMenu(row: HTMLElement): void {
  row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
}

/**
 * Where a key takes focus from `target`, or what it does instead. Null leaves
 * the key to whoever else wants it.
 */
function answer(list: Element, target: HTMLElement, key: string): HTMLElement | (() => void) | null {
  const stop = stopOf(target);
  if (!stop) return null;
  const stops = stopsOf(list);
  const at = stops.indexOf(stop);
  const stay = () => {};
  switch (key) {
    case "ArrowDown": return stops[at + 1] ?? stay;
    case "ArrowUp": return stops[at - 1] ?? stay;
    case "Home": return stops[0] ?? stay;
    case "End": return stops.at(-1) ?? stay;
    case "ArrowRight": {
      const inner = innerOf(stop);
      if (target !== stop) return inner[inner.indexOf(target) + 1] ?? stay;
      if (stop.matches(HEADING) && stop.getAttribute("aria-expanded") === "false") return () => stop.click();
      if (inner.length) return inner[0];
      return stop.matches(ROW) ? () => openMenu(stop) : stay;
    }
    case "ArrowLeft": {
      if (target !== stop) {
        const inner = innerOf(stop);
        return inner[inner.indexOf(target) - 1] ?? stop;
      }
      if (stop.matches(HEADING)) return stop.getAttribute("aria-expanded") === "true" ? () => stop.click() : stay;
      return stop.closest(".herd-group")?.querySelector<HTMLElement>(HEADING) ?? stay;
    }
    default: return null;
  }
}

/** Bind the list inside `rail` for as long as the rail is drawn. */
export function bindListKeys(rail: HTMLElement): () => void {
  const lifetime = new AbortController();
  const { signal } = lifetime;
  const list = () => rail.querySelector(LIST);
  /** The control that had focus, kept to find it again when the list draws its row anew (a pin moves it to another group). */
  let held: { control: HTMLElement; place: Place } | null = null;
  /** Frames asked for and not yet drawn; none is left waiting once the rail is gone. */
  const frames = new Set<number>();

  const settle = () => {
    // Nothing here outlives the rail. A frame asked for as focus left, or the
    // observer's last report, can arrive after the list has gone from the page
    // with its rows still hanging from it: acting on those would hand focus to
    // a row nobody can see and keep the keyboard from whatever opens next.
    if (signal.aborted || !rail.isConnected) return;
    const current = list();
    if (!current) return;
    if (held && !held.control.isConnected) {
      const active = document.activeElement;
      const again = !active || active === document.body ? controlAt(current, held.place) : null;
      held = null;
      // Focusing it is noted below, and the stops follow.
      if (again) again.focus();
    }
    syncStops(current);
  };

  rail.addEventListener("focusin", (event) => {
    const control = event.target instanceof HTMLElement && event.target.closest(LIST) ? event.target : null;
    const place = control ? placeOf(control) : null;
    held = control && place ? { control, place } : null;
    settle();
  }, { signal });
  rail.addEventListener("focusout", (event) => {
    // A control removed from under its focus (its row drawn anew in another
    // group) reports the same as one the reader left for the page: focus going
    // nowhere, the control still in the document. They differ a moment later.
    // The removed one is gone by the time the list has changed, and `settle`
    // finds its new instance; the other is still there, and the list must not
    // call the keyboard back from wherever the reader pressed.
    const left = held;
    if (event.relatedTarget) held = null;
    // On the next frame, after the move: the browser has by then chosen where
    // Tab goes, so the stop handed back to the list's home here is never that
    // Tab's target.
    const frame = requestAnimationFrame(() => {
      frames.delete(frame);
      if (left && held === left && left.control.isConnected && document.activeElement !== left.control) held = null;
      settle();
    });
    frames.add(frame);
  }, { signal });
  rail.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const current = list();
    if (!current || !(event.target instanceof HTMLElement) || !current.contains(event.target)) return;
    if (hardwareKeyboard() && sessionChosenTakes(event)) return;
    const next = answer(current, event.target, event.key);
    if (!next) return;
    event.preventDefault();
    if (typeof next === "function") next();
    else next.focus();
  }, { signal });

  const drawn = typeof MutationObserver === "undefined" ? null : new MutationObserver(settle);
  drawn?.observe(rail, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "aria-pressed", "disabled"] });
  settle();
  return () => {
    lifetime.abort();
    drawn?.disconnect();
    for (const frame of frames) cancelAnimationFrame(frame);
    frames.clear();
    held = null;
  };
}

/** The rail's list is one keyboard stop; the phone page keeps the order it has. */
export function useListKeys(root: RefObject<HTMLElement | null>, variant: "page" | "rail"): void {
  useLayoutEffect(() => {
    if (variant !== "rail" || !root.current) return;
    return bindListKeys(root.current);
  }, [root, variant]);
}
