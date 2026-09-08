import { haptic, prefersReducedMotion } from "../lib/dom";
import { currentViewIncarnation } from "../compose-drafts";
import { app, state } from "../state";
import { isDesk } from "../viewport";
import { mountPaneUnderlay, type PaneUnderlay } from "./react/pane-underlay";

/** Edge swipe-back uses the same travel and spring as the pane's list transition. */
const EDGE_PX = 28;
const ENGAGE_PX = 14;
const THRESHOLD_PX = 90;
const FOLLOW = 0.85;
const UNDER_SCALE = 0.94;
const UNDER_SHIFT = 18;
const SETTLE_MS = 320;
const HINT_KEY = "pairfob_swipe_hint";

function hintAlreadyShown(): boolean {
  try { return localStorage.getItem(HINT_KEY) === "1"; }
  catch { return true; }
}

export function armSwipeHint(paneRoot: HTMLElement): void {
  if (isDesk() || prefersReducedMotion() || hintAlreadyShown()) return;
  paneRoot.classList.add("hint-edge");
  try { localStorage.setItem(HINT_KEY, "1"); }
  catch { /* An unavailable preference does not prevent the gesture. */ }
}

type Swipe = {
  root: HTMLElement;
  session: typeof state.live;
  paneId: string;
  incarnation: number;
  boardReturn: boolean;
  touchId: number;
  startX: number;
  startY: number;
  dx: number;
  tracking: boolean;
  engaged: boolean;
  transform: string;
  appliedTransform: string;
  under: PaneUnderlay | null;
  stopTransition?: () => void;
  timers: Set<number>;
};

let installed: (() => void) | undefined;

/** Reinitializing replaces this binding; callers may also dispose it explicitly. */
export function initSwipeBack(goBack: () => void): () => void {
  installed?.();
  const view = window;
  let swipe: Swipe | null = null;
  let retired = false;
  const current = (owner: Swipe) => !retired && state.phase === "live" && state.screen === "pane"
    && !isDesk() && state.live === owner.session && state.paneId === owner.paneId
    && currentViewIncarnation() === owner.incarnation && state.boardReturn === owner.boardReturn
    && owner.root.isConnected && app.querySelector(".pane-root") === owner.root;

  const restoreRoot = (owner: Swipe) => {
    owner.root.classList.remove("edge-armed", "dragging", "settling");
    if (owner.root.style.transform === owner.appliedTransform) owner.root.style.transform = owner.transform;
  };
  const clear = () => {
    const owner = swipe;
    swipe = null;
    observer.disconnect();
    if (!owner) return;
    for (const timer of owner.timers) view.clearTimeout(timer);
    owner.timers.clear();
    owner.stopTransition?.();
    restoreRoot(owner);
    owner.under?.dispose();
    owner.under = null;
  };
  const checkOwner = () => { if (swipe && !current(swipe)) clear(); };
  // A route paint can retire the gesture before its animation/navigation timer.
  const observer = new MutationObserver(checkOwner);
  const later = (owner: Swipe, delay: number, run: () => void) => {
    const timer = view.setTimeout(() => {
      owner.timers.delete(timer);
      if (swipe !== owner) return;
      if (!current(owner)) { clear(); return; }
      run();
    }, delay);
    owner.timers.add(timer);
  };
  const translate = (owner: Swipe, transform: string) => {
    owner.root.style.transform = transform;
    owner.appliedTransform = owner.root.style.transform;
  };

  const start = (event: TouchEvent) => {
    clear();
    if (retired || state.phase !== "live" || state.screen !== "pane" || isDesk()) return;
    if (event.touches.length !== 1) return;
    if ((event.target as Element | null)?.closest?.(".full-terminal-pan")) return;
    const touch = event.touches[0];
    if (touch.clientX > EDGE_PX) return;
    const root = app.querySelector<HTMLElement>(".pane-root");
    if (!root) return;
    swipe = { root, session: state.live, paneId: state.paneId, incarnation: currentViewIncarnation(),
      boardReturn: state.boardReturn, touchId: touch.identifier, startX: touch.clientX, startY: touch.clientY,
      dx: 0, tracking: true, engaged: false, transform: root.style.transform, appliedTransform: root.style.transform,
      under: null, timers: new Set() };
    root.classList.add("edge-armed");
    observer.observe(app, { childList: true, subtree: true });
  };

  const move = (event: TouchEvent) => {
    const owner = swipe;
    if (!owner?.tracking) return;
    if (!current(owner) || event.touches.length !== 1) { clear(); return; }
    const touch = event.touches[0];
    if (touch.identifier !== owner.touchId) { clear(); return; }
    const nx = touch.clientX - owner.startX;
    const ny = touch.clientY - owner.startY;
    if (!owner.engaged) {
      if (Math.abs(nx) < ENGAGE_PX || Math.abs(nx) < Math.abs(ny) * 1.2) return;
      if (nx <= 0) { clear(); return; }
      owner.engaged = true;
      owner.root.classList.add("dragging");
      if (!state.boardReturn && !prefersReducedMotion()) {
        owner.under = mountPaneUnderlay(app, `translateX(-${UNDER_SHIFT}%) scale(${UNDER_SCALE})`);
      }
    }
    event.preventDefault();
    owner.dx = Math.max(0, nx);
    translate(owner, `translateX(${owner.dx * FOLLOW}px)`);
    if (owner.under) {
      const progress = Math.min(1, owner.dx / Math.max(1, view.innerWidth));
      owner.under.element.style.transform = `translateX(-${UNDER_SHIFT * (1 - progress)}%) scale(${UNDER_SCALE + (1 - UNDER_SCALE) * progress})`;
    }
  };

  const finish = (cancelled: boolean) => {
    const owner = swipe;
    if (!owner?.tracking) return;
    if (!current(owner) || !owner.engaged) { clear(); return; }
    owner.tracking = false;
    owner.root.classList.remove("edge-armed", "dragging");
    const done = !cancelled && owner.dx > THRESHOLD_PX;
    if (prefersReducedMotion()) {
      clear();
      if (done) goBack();
      return;
    }
    owner.root.classList.add("settling");
    const layer = owner.under?.element;
    layer?.classList.add("settling");
    if (done) {
      haptic(8);
      translate(owner, "translateX(100%)");
      if (layer) layer.style.transform = "none";
      later(owner, SETTLE_MS, () => { clear(); goBack(); });
      return;
    }
    translate(owner, owner.transform);
    if (layer) {
      layer.style.transform = `translateX(-${UNDER_SHIFT}%) scale(${UNDER_SCALE})`;
      const transition = (event: Event) => {
        if (event.target !== layer) return;
        owner.stopTransition?.();
        owner.under?.dispose();
        owner.under = null;
      };
      layer.addEventListener("transitionend", transition);
      owner.stopTransition = () => layer.removeEventListener("transitionend", transition);
      later(owner, SETTLE_MS + 80, clear);
    }
    later(owner, SETTLE_MS, () => {
      restoreRoot(owner);
      if (!owner.under) clear();
    });
  };
  const end = () => finish(false);
  const cancel = () => finish(true);
  const pageHide = () => clear();
  app.addEventListener("touchstart", start, { passive: true });
  app.addEventListener("touchmove", move, { passive: false });
  app.addEventListener("touchend", end);
  app.addEventListener("touchcancel", cancel);
  view.addEventListener("resize", checkOwner);
  view.addEventListener("pagehide", pageHide);

  const dispose = () => {
    if (retired) return;
    retired = true;
    clear();
    app.removeEventListener("touchstart", start);
    app.removeEventListener("touchmove", move);
    app.removeEventListener("touchend", end);
    app.removeEventListener("touchcancel", cancel);
    view.removeEventListener("resize", checkOwner);
    view.removeEventListener("pagehide", pageHide);
    if (installed === dispose) installed = undefined;
  };
  installed = dispose;
  return dispose;
}
