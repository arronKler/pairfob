import { tabStops } from "./tab-stops";
import { liveTrigger } from "./trigger";

/**
 * Where the keyboard goes when what a dialog did takes away the control focus
 * went back to.
 *
 * Closing a session takes its row out of the list a moment after the dialog
 * that confirmed it has given focus back to that row, and focus then falls to
 * the page with no position at all. The row's neighbours are noted while it is
 * still there; when it leaves, focus lands on the row that took its place: the
 * next one, the previous one if it was the last, and what stands before an
 * emptied list (its heading) after that.
 *
 * The search stays in the list's own section. A list whose other rows hold no
 * control (the paired devices, once the last one that could be unpaired is
 * gone) has no successor among them, and the nearest control further out
 * belongs to something else: there focus lands on the section's heading
 * instead, which is given the keyboard for that one landing.
 *
 * An action that removes nothing can still redraw the control (a split opens
 * the new session, and the header is the new session's): the same control in
 * its new place takes focus again, and nothing else is looked for. Nothing
 * moves while focus is somewhere of the reader's own choosing.
 */

/** How long a confirmed removal may take to show; after that nothing is waited for. */
const WAIT_MS = 30_000;
/** How long a control is watched for being drawn again by an action that removed nothing. */
const REDRAW_MS = 10_000;
/** How long after the row has gone a control that held focus may still follow it out. */
const SETTLE_MS = 1_500;

type Level = { parent: HTMLElement; after: Element[]; before: Element[] };

/** The ancestors of `subject`, innermost first, each with its siblings on either side, nearest first. */
function neighbours(subject: HTMLElement): Level[] {
  const levels: Level[] = [];
  for (let node: HTMLElement = subject; node.parentElement && node !== document.body; node = node.parentElement) {
    const siblings = [...node.parentElement.children];
    const at = siblings.indexOf(node);
    levels.push({ parent: node.parentElement, after: siblings.slice(at + 1), before: siblings.slice(0, at).reverse() });
  }
  return levels;
}

function stopIn(element: Element): HTMLElement | null {
  if (!(element instanceof HTMLElement) || !element.isConnected || element.closest("dialog")) return null;
  return tabStops(element.parentElement ?? element).find(stop => element === stop || element.contains(stop)) ?? null;
}

/** What sets a list apart from its neighbours on the page: past its edge the controls are another section's. */
const SECTION = "section, article, fieldset, aside, nav, main, [role='group'], [role='region']";
const HEADING = "h1, h2, h3, h4, h5, h6, legend, [role='heading']";
/** A heading or a list given focus for one landing; the rule that rings it is in `styles/overlay.scss`. */
const LANDING = "data-focus-landing";

/**
 * Give `element` the keyboard although it is no control: where a list's last
 * removable row was, its heading is where the reader is. The mark goes when
 * focus moves on, so the page's Tab order is what it was.
 */
function land(element: HTMLElement): HTMLElement {
  element.setAttribute("tabindex", "-1");
  element.setAttribute(LANDING, "");
  element.addEventListener("blur", () => {
    element.removeAttribute("tabindex");
    element.removeAttribute(LANDING);
  }, { once: true });
  return element;
}

/**
 * The control that stands where the removed one stood. The first level whose
 * parent survived is the list the item left: its next sibling, then the one
 * before. Above that the list itself is gone or empty, and what came before it
 * (a heading) is nearer to the reader than what follows.
 *
 * The climb ends at the edge of the list's section. With no control found by
 * then the section's heading takes the landing, or the list itself where it
 * has none; a list that is no part of any section has the whole page to look in.
 */
function successor(levels: Level[]): HTMLElement | null {
  let list: HTMLElement | null = null;
  for (const [index, level] of levels.entries()) {
    if (!level.parent.isConnected) continue;
    const order = list ? [...level.before, ...level.after] : [...level.after, ...level.before];
    list ??= level.parent;
    for (const sibling of order) {
      const stop = stopIn(sibling);
      if (stop) return stop;
    }
    if (!level.parent.matches(SECTION)) continue;
    // A section that stands alone in its container is the page's own column, not one of several.
    const beyond = levels[index + 1];
    if (!beyond || beyond.before.length + beyond.after.length === 0) continue;
    const heading = [...level.parent.children].find(child => child.matches(HEADING)) ?? level.parent.querySelector(HEADING);
    return land(heading instanceof HTMLElement ? heading : list);
  }
  return null;
}

function focusLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected;
}

/**
 * Watch `opener` (or the control that names the object `of`, where the opener
 * is not the row itself: `data-trigger-of`, `trigger.ts`). Once it has left the
 * page with focus on nothing, focus lands on the same control drawn again if
 * there is one, else on its successor, else on `home`, else on the page's
 * first control. With `redrawOnly` only the control itself is looked for: the
 * dialog removed nothing, so a neighbour would be a guess.
 */
export function followRemoval(opener: HTMLElement | null,
  options: { of?: string; home?: () => HTMLElement | null; redrawOnly?: boolean } = {}): void {
  const named = options.of === undefined ? null
    : [...document.querySelectorAll<HTMLElement>("[data-trigger-of]")]
      .find(control => control.getAttribute("data-trigger-of") === options.of && !control.closest("dialog")) ?? null;
  const subject = named ?? opener;
  if (!subject?.isConnected || typeof MutationObserver === "undefined") return;
  const levels = neighbours(subject);
  let timer = 0;
  // The row and the control that held focus may leave in either order (a closed
  // session takes its header with it), so a loss of focus is waited for a short
  // while after the row has gone as well.
  const watcher = new MutationObserver(() => {
    if (subject.isConnected) return;
    if (document.querySelector("dialog[open]")) return stop();
    if (!focusLost()) {
      if (settling) return;
      settling = true;
      window.clearTimeout(timer);
      timer = window.setTimeout(stop, SETTLE_MS);
      return;
    }
    stop();
    const again = liveTrigger(subject);
    const next = again ?? (options.redrawOnly ? null : successor(levels) ?? options.home?.() ?? tabStops(document.body)[0]);
    next?.focus({ preventScroll: true });
  });
  let settling = false;
  const stop = () => { watcher.disconnect(); window.clearTimeout(timer); };
  watcher.observe(document.body, { childList: true, subtree: true });
  timer = window.setTimeout(stop, options.redrawOnly ? REDRAW_MS : WAIT_MS);
}
