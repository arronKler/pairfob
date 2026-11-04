import { prefersReducedMotion } from "../lib/dom";
import { tryAppRoot } from "./dom-root";
import { holdCommits } from "./host";
import { isDesk } from "./viewport";

/**
 * Screen transitions.
 *
 * This app repaints constantly: every poll, every read, every key echo calls
 * `render()`. So a transition is never inferred from a DOM difference — a
 * navigation has to declare one, and everything else stays `none`. Getting that
 * backwards would animate the screen while someone is typing into a terminal.
 */
export type TransitionKind = "push" | "pop" | "fade" | "expand" | "view" | "session" | "page-push" | "page-pop" | "none";

/*
 * Four kinds are moves inside what stays on screen, and say so, so the part
 * that stays is not moved with the rest:
 *
 * - `view`: another view of the same session (guided, chat, the complete
 *   terminal). Its header is the same header; what is under it arrives.
 * - `session`: another session in the column the open one stood in, beside
 *   the list. The header keeps its place and says the other name; what is
 *   under it arrives, one step shorter than a view, since readers go from
 *   session to session in a row.
 * - `page-push` / `page-pop`: one page deeper under the same tab, and back
 *   (Settings to a computer's page). The tab bar is the same bar.
 */

/** What a declared kind becomes on the layout in front of the reader. */
function effectiveKind(kind: TransitionKind): TransitionKind {
  if (kind === "view" || kind === "session") return kind;
  // On a desk layout the pane is already beside the list, so nothing travels.
  return isDesk() ? "fade" : kind;
}

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

/**
 * How a session arrives from `from`. Beside the list another session takes the
 * place of the open one, in the same column (`session`); from anywhere else it
 * is the ordinary move to the pane screen.
 */
export function transitionToPane(from: TransitionScreen): TransitionKind {
  return from === "pane" && isDesk() ? "session" : transitionFor(from, "pane");
}

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
  settleMorph();
}

/** Mark the element a pane grows out of, or collapses back into. */
export function shareOpening(element: HTMLElement | null | undefined): void {
  element?.style.setProperty("view-transition-name", OPENING_NAME);
}

type ViewTransition = {
  finished: Promise<void>;
  updateCallbackDone?: Promise<void>;
  skipTransition?: () => void;
};

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => ViewTransition;
};

/**
 * Arrival-only CSS fallback, shared by the ordinary adapter and the narrow
 * synchronous entry. Animate the arriving screen and remove the marker (and the
 * morphing-pane id) once the animation window closes. This is the supported
 * synchronous transition: old-to-new capture needs the native API's deferred
 * update callback, which a synchronous boundary never provides.
 */
function runFallbackTransition(effective: TransitionKind | "reduced", paint: () => void): void {
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
  const effective = effectiveKind(kind);
  const root = document.documentElement;
  const start = (document as ViewTransitionDocument).startViewTransition;
  // The moves inside a screen have no captured pair to animate: arrival only.
  if (typeof start !== "function" || kind === "view" || kind === "session" || kind === "page-push" || kind === "page-pop") {
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
 * native-capable keep using `withTransition` with their real update callback
 * (boot), or `navigateWithTransition` (the list ↔ pane pair, below).
 */
export function withSynchronousTransition(kind: TransitionKind, paint: () => void): void {
  if (kind === "none" || prefersReducedMotion()) {
    paint();
    return;
  }
  runFallbackTransition(effectiveKind(kind), paint);
}

/** Long enough for the arrival animation, matching --dur-4 plus a frame. */
const FALLBACK_MS = 340;

/* --- Shared list ↔ pane transition --------------------------------------------
   The one navigation that is a single motion: the tapped card grows into the
   pane, and on the way back the pane shrinks into its card. The list stays where
   it is under a dim. Everything else keeps the push / pop / fade above.

   Names live only on the morphing pane's elements and only for the length of
   one transition: two elements with the same name make the native API skip the
   whole transition, so they are put on imperatively right before each capture
   and taken off when it ends.
   ------------------------------------------------------------------------------ */

const CONTAINER_NAME = "pane-container";
const AVATAR_NAME = "pane-avatar";
const TITLE_NAME = "pane-title";
/** Header status line and buttons: not shared, they fade in late on arrival. */
const META_NAME = "pane-meta";
const ACTIONS_NAME = "pane-actions";

const OPEN_MS = 300;
const CLOSE_MS = 260;
const OPEN_EASE = "cubic-bezier(.2,0,0,1)";
const CLOSE_EASE = "cubic-bezier(.3,0,.1,1)";
const CARD_RADIUS = 14;
/** Close to a phone's own corner, so the grown card meets the screen edge. */
const SCREEN_RADIUS = 35;
/** A native update callback that never runs must not strand the navigation. */
const HOLD_MS = 1000;
/** Reduced motion: no travel, only a short fade (see the reduced-motion styles). */
const REDUCED_MS = 160;

/**
 * Which way the pane travels. `open` names the element that was tapped (a list
 * card or a "needs you" ticket); `close` finds the pane's card after the list
 * has rendered and skips the morph when it is gone or out of view.
 */
export type PaneMorph =
  | { direction: "open"; paneId: string; source: HTMLElement | null | undefined }
  | { direction: "close"; paneId: string };

type MorphParts = { container: HTMLElement; avatar: HTMLElement | null; title: HTMLElement | null };

let morphGeneration = 0;
let named: HTMLElement[] = [];
/** Ends whatever the current morph still has running: native skip or FLIP cancel. */
let stopMorph: (() => void) | null = null;

function nameElement(element: HTMLElement | null | undefined, name: string): void {
  if (!element) return;
  element.style.setProperty("view-transition-name", name);
  named.push(element);
}

function clearNames(): void {
  for (const element of named) element.style.removeProperty("view-transition-name");
  named = [];
}

/** Take down every trace of the current morph. Safe to call at any time. */
function settleMorph(): void {
  morphGeneration += 1;
  const stop = stopMorph;
  stopMorph = null;
  stop?.();
  clearNames();
  const root = document.documentElement;
  if (root.dataset.transition === "morph-open" || root.dataset.transition === "morph-close") delete root.dataset.transition;
}

function inView(element: HTMLElement): boolean {
  // A row of a folded group is laid out and clipped away: it has a box and nothing to land on.
  if (element.closest("[inert]")) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const height = window.visualViewport?.height ?? window.innerHeight;
  return rect.top >= 0 && rect.bottom <= height && rect.left >= 0 && rect.right <= window.innerWidth;
}

/** The card (or ticket) a tap came from, with the avatar and title that travel. */
function sourceParts(source: HTMLElement | null | undefined): MorphParts | null {
  const container = source?.closest<HTMLElement>(".card-main, .attn-ticket") ?? null;
  if (!container || !container.isConnected || !inView(container)) return null;
  return {
    container,
    avatar: container.querySelector<HTMLElement>(".agent-avatar"),
    title: container.querySelector<HTMLElement>(".card-name, .attn-ticket-name"),
  };
}

/** The pane's card in the rendered list, only when it is on screen. */
function cardParts(paneId: string): MorphParts | null {
  const app = tryAppRoot();
  const container = [...(app?.querySelectorAll<HTMLElement>(".card-main[data-pane-id]") ?? [])]
    .find((element) => element.dataset.paneId === paneId);
  if (!container || !inView(container)) return null;
  return {
    container,
    avatar: container.querySelector<HTMLElement>(".agent-avatar"),
    title: container.querySelector<HTMLElement>(".card-name"),
  };
}

function paneParts(): (MorphParts & { meta: HTMLElement | null; actions: HTMLElement | null }) | null {
  const container = tryAppRoot()?.querySelector<HTMLElement>(".pane-root") ?? null;
  if (!container) return null;
  const header = container.querySelector<HTMLElement>(":scope > .chrome");
  return {
    container,
    avatar: header?.querySelector<HTMLElement>(".chrome-avatar") ?? null,
    title: header?.querySelector<HTMLElement>(".chrome-name") ?? null,
    meta: header?.querySelector<HTMLElement>(".chrome-meta") ?? null,
    actions: header?.querySelector<HTMLElement>(".chrome-actions") ?? null,
  };
}

function nameParts(parts: MorphParts | null): void {
  if (!parts) return;
  nameElement(parts.container, CONTAINER_NAME);
  nameElement(parts.avatar, AVATAR_NAME);
  nameElement(parts.title, TITLE_NAME);
}

/**
 * Asynchronous navigation adapter for the list ↔ pane pair.
 *
 * Unlike `commitView`, this boundary does not promise the arriving DOM when it
 * returns: with the native API the commit runs inside `startViewTransition`'s
 * deferred update callback, so the old list can be captured first. Callers
 * await the returned promise (the update callback being done) before measuring
 * or refreshing the arriving page. Until then the commit pipeline is held, so a
 * coalesced commit request cannot paint the destination before the capture.
 *
 * Every other case commits synchronously exactly as the controller boundary
 * does: no morph requested, nothing declared, a desk layout (the pane is already
 * beside the list), or no source card on screen. Reduced motion commits
 * synchronously with a short fade. Without the native API the same motion runs
 * as FLIP with Web Animations after a synchronous commit.
 */
export function navigateWithTransition(commit: () => void, morph: PaneMorph | null): Promise<void> {
  settleMorph();
  const kind = takeTransition();
  const expected = morph?.direction === "open" ? "push" : "pop";
  const source = morph?.direction === "open" ? sourceParts(morph.source) : null;
  const eligible = morph !== null && kind === expected && !isDesk()
    && (morph.direction === "close" ? paneParts() !== null : source !== null);
  if (!eligible) {
    withSynchronousTransition(kind, commit);
    return Promise.resolve();
  }
  if (prefersReducedMotion()) {
    runFallbackTransition("reduced", commit);
    return Promise.resolve();
  }
  const start = (document as ViewTransitionDocument).startViewTransition;
  if (typeof start === "function") return nativeMorph(start, commit, morph, source);
  flipMorph(commit, morph, source);
  return Promise.resolve();
}

function nativeMorph(
  start: NonNullable<ViewTransitionDocument["startViewTransition"]>,
  commit: () => void,
  morph: PaneMorph,
  source: MorphParts | null,
): Promise<void> {
  const generation = morphGeneration;
  const root = document.documentElement;
  const release = holdCommits();
  let updated = false;
  const update = (): void => {
    if (updated) return;
    updated = true;
    release();
    commit();
    // A newer navigation took over while this one waited for its capture.
    if (generation !== morphGeneration) return;
    if (morph.direction === "open") {
      const pane = paneParts();
      nameParts(pane);
      nameElement(pane?.meta, META_NAME);
      nameElement(pane?.actions, ACTIONS_NAME);
    } else {
      // A card that is gone or scrolled away leaves the pane to fade out on
      // its own: a plain return instead of a flight to the wrong place.
      nameParts(cardParts(morph.paneId));
    }
  };
  if (morph.direction === "open") nameParts(source);
  else nameParts(paneParts());
  root.dataset.transition = morph.direction === "open" ? "morph-open" : "morph-close";
  let transition: ViewTransition;
  try {
    transition = start.call(document, update);
  } catch {
    // Another transition in flight or a hidden document: the commit still happens.
    settleMorph();
    update();
    return Promise.resolve();
  }
  const guard = window.setTimeout(update, HOLD_MS);
  // Superseded or torn down: let go of the hold without committing here. A newer
  // navigation commits the staged state itself; a teardown wants no commit.
  stopMorph = () => {
    window.clearTimeout(guard);
    updated = true;
    release();
    transition.skipTransition?.();
  };
  const done = (): void => {
    window.clearTimeout(guard);
    if (generation !== morphGeneration) return;
    stopMorph = null;
    clearNames();
    delete root.dataset.transition;
    queuedPane = null;
  };
  void transition.finished.catch(() => undefined).then(done);
  const callback = transition.updateCallbackDone ?? transition.finished;
  return callback.catch(() => undefined).then(() => {
    // An engine that reports done before running the callback must still commit.
    update();
  });
}

type Box = { top: number; right: number; bottom: number; left: number; width: number; height: number };

function rectOf(element: HTMLElement | null | undefined): Box | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

/** `inset()` that puts `inner` inside `outer`, both in viewport coordinates. */
function insetFor(inner: Box, outer: Box, radius: number): string {
  const top = Math.max(0, inner.top - outer.top);
  const right = Math.max(0, outer.right - inner.right);
  const bottom = Math.max(0, outer.bottom - inner.bottom);
  const left = Math.max(0, inner.left - outer.left);
  return `inset(${top}px ${right}px ${bottom}px ${left}px round ${radius}px)`;
}

/** Transform that lays `last` over `first` with one uniform scale (text never stretches). */
function flipFrom(first: Box, last: Box): string {
  const scale = first.height / last.height;
  return `translate(${first.left - last.left}px, ${first.top - last.top}px) scale(${scale})`;
}

function canAnimate(element: Element | null | undefined): element is HTMLElement {
  return Boolean(element && typeof (element as HTMLElement).animate === "function");
}

/**
 * A static picture of the list for the pane to grow over: a clone of the page
 * without its behaviour, holding the scroll position the reader left it at.
 * Only the list is copied — never a terminal.
 */
function listSnapshot(app: HTMLElement): { layer: HTMLElement; restoreScroll: () => void } {
  const layer = document.createElement("div");
  layer.className = "pane-morph-under";
  layer.setAttribute("aria-hidden", "true");
  layer.inert = true;
  // `#app` rules are keyed on the id the copy cannot keep, so the copy takes the
  // root's measured box and layout instead.
  const page = app.cloneNode(true) as HTMLElement;
  page.removeAttribute("id");
  page.classList.add("pane-morph-page");
  const box = app.getBoundingClientRect();
  const computed = getComputedStyle(app);
  Object.assign(page.style, {
    left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, minHeight: `${box.height}px`,
    display: computed.display, flexDirection: computed.flexDirection, gap: computed.gap,
    padding: computed.padding, background: computed.background,
  });
  const originals = [...app.querySelectorAll<HTMLElement>("*")];
  const offsets = originals.flatMap((element, index) =>
    element.scrollTop || element.scrollLeft ? [{ index, top: element.scrollTop, left: element.scrollLeft }] : []);
  const clones = [...page.querySelectorAll<HTMLElement>("*")];
  for (const clone of page.querySelectorAll("[id]")) clone.removeAttribute("id");
  const dim = document.createElement("div");
  dim.className = "pane-morph-dim";
  layer.append(page, dim);
  // Clones lose their scroll offsets; put them back once the clone is laid out.
  const restoreScroll = (): void => {
    for (const offset of offsets) {
      const clone = clones[offset.index];
      if (!clone) continue;
      clone.scrollTop = offset.top;
      clone.scrollLeft = offset.left;
    }
  };
  return { layer, restoreScroll };
}

/**
 * FLIP fallback for engines without the native API. The commit is synchronous;
 * the motion is drawn afterwards from rectangles measured before it.
 */
function flipMorph(commit: () => void, morph: PaneMorph, source: MorphParts | null): void {
  const generation = morphGeneration;
  const app = tryAppRoot();
  if (morph.direction === "open") {
    const from = source ? { container: rectOf(source.container), avatar: rectOf(source.avatar), title: rectOf(source.title) } : null;
    const under = app ? listSnapshot(app) : null;
    commit();
    const pane = paneParts();
    if (!from?.container || !pane || !canAnimate(pane.container) || generation !== morphGeneration) return;
    if (under && app?.parentNode) {
      app.parentNode.insertBefore(under.layer, app);
      under.restoreScroll();
    }
    flipOpen({ ...from, container: from.container }, pane, under?.layer ?? null);
    return;
  }
  const pane = paneParts();
  const from = pane ? {
    container: rectOf(pane.container), avatar: rectOf(pane.avatar), title: rectOf(pane.title),
  } : null;
  const ghost = pane ? paneGhost(pane.container) : null;
  commit();
  const card = cardParts(morph.paneId);
  if (!from?.container || !card || !ghost || generation !== morphGeneration) {
    // Nothing to land on: the ordinary return animation.
    runFallbackTransition("pop", () => undefined);
    return;
  }
  flipClose({ ...from, container: from.container }, card, ghost);
}

function track(animations: Animation[], cleanup: () => void, generation: number): void {
  let settled = false;
  const finish = (): void => {
    if (settled) return;
    settled = true;
    for (const animation of animations) {
      // Cancelling rejects the finished promise; nothing awaits it, so handle
      // the rejection here.
      void animation.finished?.catch(() => undefined);
      animation.cancel();
    }
    cleanup();
    if (generation === morphGeneration) {
      stopMorph = null;
      queuedPane = null;
    }
  };
  stopMorph = finish;
  const last = animations[0];
  if (!last) {
    finish();
    return;
  }
  void last.finished.catch(() => undefined).then(finish);
  // Forced cleanup if the engine never reports the end (a hidden tab).
  const timer = window.setTimeout(finish, OPEN_MS + 200);
  fallbackTimers.add(timer);
}

type FlipRects = { container: Box; avatar: Box | null; title: Box | null };

function flipOpen(from: FlipRects, pane: NonNullable<ReturnType<typeof paneParts>>, under: HTMLElement | null): void {
  const generation = morphGeneration;
  const timing = { duration: OPEN_MS, easing: OPEN_EASE, fill: "both" as const };
  const linear = { duration: OPEN_MS, easing: "linear", fill: "both" as const };
  const to = pane.container.getBoundingClientRect();
  const animations: Animation[] = [];
  animations.push(pane.container.animate([
    { clipPath: insetFor(from.container, to, CARD_RADIUS), backgroundColor: "var(--surface)" },
    { clipPath: `inset(0px 0px 0px 0px round ${SCREEN_RADIUS}px)`, backgroundColor: "var(--term-bg)" },
  ], timing));
  const header = pane.container.querySelector<HTMLElement>(":scope > .chrome");
  for (const child of pane.container.children) {
    if (child === header || !canAnimate(child)) continue;
    animations.push(child.animate([{ opacity: 0 }, { opacity: 0, offset: 0.25 }, { opacity: 1 }], linear));
  }
  for (const late of header?.querySelectorAll<HTMLElement>(":scope > .chrome-back, .chrome-meta, :scope > .chrome-actions") ?? []) {
    if (canAnimate(late)) animations.push(late.animate([{ opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1 }], linear));
  }
  if (canAnimate(header)) {
    animations.push(header.animate([
      { backgroundColor: "transparent", borderBottomColor: "transparent" },
      { backgroundColor: "transparent", borderBottomColor: "transparent", offset: 0.25 },
      {},
    ], linear));
  }
  for (const [first, element] of [[from.avatar, pane.avatar], [from.title, pane.title]] as const) {
    const last = rectOf(element);
    if (!first || !last || !canAnimate(element)) continue;
    animations.push(element.animate([
      { transformOrigin: "0 0", transform: flipFrom(first, last) },
      { transformOrigin: "0 0", transform: "none" },
    ], timing));
  }
  const dim = under?.querySelector(".pane-morph-dim");
  if (canAnimate(dim)) animations.push(dim.animate([{ opacity: 0 }, { opacity: 1 }], timing));
  // The session shell paints the terminal ground; let the list copy show
  // around the growing pane until it covers the screen.
  const root = document.documentElement;
  root.dataset.morph = "open";
  track(animations, () => {
    under?.remove();
    if (root.dataset.morph === "open") delete root.dataset.morph;
  }, generation);
}

/**
 * The pane's stand-in while it shrinks: the terminal ground and a copy of the
 * header, laid over the list that is already rendered underneath.
 */
function paneGhost(container: HTMLElement): HTMLElement {
  const layer = document.createElement("div");
  layer.className = "pane-morph-ghost";
  layer.setAttribute("aria-hidden", "true");
  layer.inert = true;
  const header = container.querySelector(":scope > .chrome");
  if (header) layer.append(header.cloneNode(true));
  return layer;
}

function flipClose(from: FlipRects, card: MorphParts, ghost: HTMLElement): void {
  const generation = morphGeneration;
  const timing = { duration: CLOSE_MS, easing: CLOSE_EASE, fill: "both" as const };
  const linear = { duration: CLOSE_MS, easing: "linear", fill: "both" as const };
  const dim = document.createElement("div");
  dim.className = "pane-morph-dim is-over";
  dim.setAttribute("aria-hidden", "true");
  document.body.append(dim, ghost);
  const to = card.container.getBoundingClientRect();
  const height = window.visualViewport?.height ?? window.innerHeight;
  const screen: Box = { top: 0, left: 0, right: window.innerWidth, bottom: height, width: window.innerWidth, height };
  if (typeof ghost.animate !== "function") {
    ghost.remove();
    dim.remove();
    return;
  }
  const animations: Animation[] = [];
  animations.push(ghost.animate([
    { clipPath: insetFor(from.container, screen, SCREEN_RADIUS), backgroundColor: "var(--term-bg)" },
    { clipPath: insetFor(to, screen, CARD_RADIUS), backgroundColor: "var(--surface)" },
  ], timing));
  const header = ghost.firstElementChild;
  for (const content of header?.querySelectorAll<HTMLElement>(":scope > .chrome-back, .chrome-meta, :scope > .chrome-actions") ?? []) {
    animations.push(content.animate([{ opacity: 1 }, { opacity: 0, offset: 0.35 }, { opacity: 0 }], linear));
  }
  if (canAnimate(header)) {
    animations.push(header.animate([{}, { backgroundColor: "transparent", borderBottomColor: "transparent", offset: 0.35 },
      { backgroundColor: "transparent", borderBottomColor: "transparent" }], linear));
  }
  const flying = [
    [from.avatar, header?.querySelector<HTMLElement>(".chrome-avatar"), rectOf(card.avatar)],
    [from.title, header?.querySelector<HTMLElement>(".chrome-name"), rectOf(card.title)],
  ] as const;
  for (const [first, element, last] of flying) {
    if (!first || !last || !canAnimate(element)) continue;
    // The copy sits where the header had it; move it onto the card's own spot.
    animations.push(element.animate([
      { transformOrigin: "0 0", transform: "none" },
      { transformOrigin: "0 0", transform: flipFrom(last, first) },
    ], timing));
  }
  if (canAnimate(dim)) animations.push(dim.animate([{ opacity: 1 }, { opacity: 0 }], timing));
  track(animations, () => {
    ghost.remove();
    dim.remove();
  }, generation);
}

/** The soft keyboard is up (`app/viewport` keeps `html[data-kb]` current). */
export function keyboardOpen(): boolean {
  return document.documentElement.dataset.kb === "open";
}

/** Longest wait for the keyboard to leave before navigating anyway. */
const KEYBOARD_SETTLE_MS = 400;
/** The viewport counts as settled after this long without a resize. */
const KEYBOARD_QUIET_MS = 90;

/**
 * Dismiss the keyboard and wait for the visual viewport to settle: no resize for
 * a moment (or a cap), then one frame. A transition captured while the viewport
 * is still growing back would jump.
 */
export function settleKeyboard(): Promise<void> {
  const active = document.activeElement;
  if (active instanceof HTMLElement) active.blur();
  return new Promise((resolve) => {
    const viewport = window.visualViewport;
    let quiet = 0;
    const finish = (): void => {
      viewport?.removeEventListener("resize", resized);
      window.clearTimeout(quiet);
      window.clearTimeout(cap);
      requestAnimationFrame(() => resolve());
    };
    const resized = (): void => {
      window.clearTimeout(quiet);
      quiet = window.setTimeout(finish, KEYBOARD_QUIET_MS);
    };
    const cap = window.setTimeout(finish, KEYBOARD_SETTLE_MS);
    viewport?.addEventListener("resize", resized);
    resized();
  });
}
