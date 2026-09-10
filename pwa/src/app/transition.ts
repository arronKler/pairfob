import { prefersReducedMotion } from "../lib/dom";
import { isDesk } from "./viewport";

/**
 * Screen transitions.
 *
 * This app repaints constantly: every poll, every read, every key echo calls
 * `render()`. So a transition is never inferred from a DOM difference — a
 * navigation has to declare one, and everything else stays `none`. Getting that
 * backwards would animate the screen while someone is typing into a terminal.
 */
export type TransitionKind = "push" | "pop" | "fade" | "expand" | "none";

/**
 * Mirrors `state.Screen`, declared here so this module imports nothing from
 * state and stays out of its import cycle. Callers pass `state.screen`, so a new
 * screen there fails to typecheck until it is given a depth below.
 */
export type TransitionScreen = "home" | "pane" | "workspace" | "settings" | "quota" | "computers" | "board";

/** How deep each screen sits. Equal depth is a sideways move, so it cross-fades. */
const DEPTH: Record<TransitionScreen, number> = {
  home: 0,
  board: 0,
  settings: 0,
  quota: 0,
  computers: 0,
  pane: 1,
  workspace: 2,
};

export function transitionFor(from: TransitionScreen, to: TransitionScreen): TransitionKind {
  if (from === to) return "none";
  if (DEPTH[to] > DEPTH[from]) return "push";
  if (DEPTH[to] < DEPTH[from]) return "pop";
  return "fade";
}

/** The name both the card title and the pane title carry, so the two morph into one. */
const TITLE_NAME = "pane-title";

/** The name a board tile and the pane screen share, so one expands into the other. */
const OPENING_NAME = "pane-open";

let queued: TransitionKind = "none";
let queuedPane: string | null = null;
const fallbackTimers = new Set<number>();
let transitionGeneration = 0;

/**
 * Declare the transition for the navigation about to happen. The next paint
 * consumes it; a paint with nothing declared does not animate.
 */
export function nextTransition(kind: TransitionKind, paneId?: string | null): void {
  if (kind === "none") return;
  queued = kind;
  queuedPane = paneId ?? null;
}

export function takeTransition(): TransitionKind {
  const kind = queued;
  queued = "none";
  return kind;
}

/**
 * What the pending navigation asked for. A screen builder needs this to decide
 * whether it owns a shared element for this particular navigation.
 */
export function queuedKind(): TransitionKind {
  return queued;
}

/** The pane whose title is morphing, if this navigation has one. */
export function morphingPane(): string | null {
  return queuedPane;
}

/**
 * Explicit teardown for the transition state: forget a declared navigation, cancel
 * the arrival-only fallback and drop the markers this module put on the document.
 * The application lifecycle calls it when it stops; a fixture calls it between
 * cases so a queued transition cannot animate an unrelated paint.
 */
export function resetTransitionState(): void {
  queued = "none";
  queuedPane = null;
  transitionGeneration += 1;
  for (const timer of fallbackTimers) window.clearTimeout(timer);
  fallbackTimers.clear();
  const root = document.documentElement;
  delete root.dataset.transition;
  delete root.dataset.fallbackTransition;
}

/** Give an element the shared title name; the browser interpolates the rest. */
export function shareTitle(element: HTMLElement | null | undefined): void {
  element?.style.setProperty("view-transition-name", TITLE_NAME);
}

/** Mark the element a pane grows out of, or collapses back into. */
export function shareOpening(element: HTMLElement | null | undefined): void {
  element?.style.setProperty("view-transition-name", OPENING_NAME);
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { finished: Promise<void> };
};

/**
 * Arrival-only CSS fallback, shared by the ordinary adapter and the narrow
 * synchronous entry. Animate the arriving screen and remove the marker (and the
 * morphing-pane id) once the animation window closes. This is the supported
 * synchronous transition: old-to-new capture needs the native API's deferred
 * update callback, which a synchronous boundary never provides.
 */
function runFallbackTransition(effective: TransitionKind, paint: () => void): void {
  const root = document.documentElement;
  root.dataset.fallbackTransition = effective;
  paint();
  const generation = transitionGeneration;
  const timer = window.setTimeout(() => {
    fallbackTimers.delete(timer);
    if (generation !== transitionGeneration) return;
    if (root.dataset.fallbackTransition === effective) delete root.dataset.fallbackTransition;
    queuedPane = null;
  }, FALLBACK_MS);
  fallbackTimers.add(timer);
}

export function withTransition(kind: TransitionKind, paint: () => void): void {
  if (kind === "none" || prefersReducedMotion()) {
    paint();
    return;
  }
  // On a desk layout the pane is already beside the list, so nothing travels.
  const effective: TransitionKind = isDesk() ? "fade" : kind;
  const root = document.documentElement;
  const start = (document as ViewTransitionDocument).startViewTransition;
  if (typeof start !== "function") {
    // Older WebKit: animate the arriving screen only. Cloning a live terminal
    // grid to animate the outgoing one costs more than the effect is worth.
    runFallbackTransition(effective, paint);
    return;
  }
  root.dataset.transition = effective;
  const generation = transitionGeneration;
  try {
    const run = start.call(document, paint);
    void run.finished
      .catch(() => {
        /* a superseded transition is not an error */
      })
      .then(() => {
        if (generation !== transitionGeneration) return;
        delete root.dataset.transition;
        queuedPane = null;
      });
  } catch {
    // A transition already in flight: the paint still has to happen.
    delete root.dataset.transition;
    queuedPane = null;
    paint();
  }
}

/**
 * Narrow synchronous controller entry.
 *
 * The public synchronous commit/navigation boundary must return with the
 * arriving DOM already rendered, so it can never hand its update to a native
 * `startViewTransition` — that API defers its update callback, and old-to-new
 * native capture therefore requires an asynchronous update this boundary does
 * not promise (the DOM has already changed by the time the callback could run).
 * This entry always animates through the shared arrival-only CSS fallback above
 * (reduced motion skips the animation, cleanup is the same timer path) and never
 * starts a native ViewTransition. Callers that are explicitly asynchronous and
 * native-capable keep using `withTransition` with their real update callback.
 */
export function withSynchronousTransition(kind: TransitionKind, paint: () => void): void {
  if (kind === "none" || prefersReducedMotion()) {
    paint();
    return;
  }
  runFallbackTransition(isDesk() ? "fade" : kind, paint);
}

/** Long enough for the arrival animation, matching --dur-4 plus a frame. */
const FALLBACK_MS = 340;
