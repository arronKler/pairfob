import { haptic, node, prefersReducedMotion } from "../lib/dom";
import { app, state } from "../state";
import { isDesk } from "../viewport";
import { homePage } from "./home";

/**
 * Edge swipe back.
 *
 * The gesture is invisible unless something hints at it, so the pane carries a
 * faint edge line that brightens under the finger, and the screen it came from
 * follows the drag underneath. Both make the same point: this pane is a layer
 * on top of the list, and it can be pushed off.
 */

/** Matches the Android system back gesture zone. Widening it would fight the OS. */
const EDGE_PX = 28;

/** Travel before the drag is the app's rather than a scroll or a tap. */
const ENGAGE_PX = 14;

/** Past this the pane keeps going on its own. */
const THRESHOLD_PX = 90;

/** The pane trails the finger slightly; it is being pushed, not carried. */
const FOLLOW = 0.85;

/** Where the layer underneath starts: back and to the left, in the middle distance. */
const UNDER_SCALE = 0.94;
const UNDER_SHIFT = 18;

/** Ceiling for the settle animation, matching --dur-4. */
const SETTLE_MS = 320;

const HINT_KEY = "pairfob_swipe_hint";

function hintAlreadyShown(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === "1";
  } catch {
    // Private mode denies storage; a hint on every visit is worse than none.
    return true;
  }
}

/**
 * Play the edge hint once ever. It is an animation class rather than a tooltip
 * so it costs nothing on every later paint.
 */
export function armSwipeHint(paneRoot: HTMLElement): void {
  if (isDesk() || prefersReducedMotion() || hintAlreadyShown()) return;
  paneRoot.classList.add("hint-edge");
  try {
    localStorage.setItem(HINT_KEY, "1");
  } catch {
    /* the hint just plays again next time */
  }
}

/** Underneath a pane is the herd list. Board keeps its own camera, so it is not rebuilt here. */
function underLayer(): HTMLElement | null {
  if (state.boardReturn || prefersReducedMotion()) return null;
  const under = node("div", "pane-under");
  under.setAttribute("aria-hidden", "true");
  under.append(homePage());
  under.style.transform = `translateX(-${UNDER_SHIFT}%) scale(${UNDER_SCALE})`;
  return under;
}

function drop(under: HTMLElement | null): void {
  if (!under) return;
  let gone = false;
  const remove = () => {
    if (gone) return;
    gone = true;
    under.remove();
  };
  under.addEventListener("transitionend", remove, { once: true });
  window.setTimeout(remove, SETTLE_MS + 80);
}

export function initSwipeBack(goBack: () => void): void {
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let tracking = false;
  let engaged = false;
  let root: HTMLElement | null = null;
  let under: HTMLElement | null = null;

  const paint = (progress: number) => {
    if (!under) return;
    const shift = UNDER_SHIFT * (1 - progress);
    const scale = UNDER_SCALE + (1 - UNDER_SCALE) * progress;
    under.style.transform = `translateX(-${shift}%) scale(${scale})`;
  };

  app.addEventListener(
    "touchstart",
    (event) => {
      if (state.phase !== "live" || state.screen !== "pane" || isDesk()) return;
      if (event.touches.length !== 1) return;
      if ((event.target as Element | null)?.closest?.(".full-terminal-pan")) return;
      const touch = event.touches[0];
      if (touch.clientX > EDGE_PX) return;
      tracking = true;
      engaged = false;
      startX = touch.clientX;
      startY = touch.clientY;
      dx = 0;
      root = app.querySelector(".pane-root");
      // Brighten the edge line as soon as the finger lands on the hot zone.
      root?.classList.add("edge-armed");
    },
    { passive: true },
  );

  app.addEventListener(
    "touchmove",
    (event) => {
      if (!tracking || !root) return;
      const touch = event.touches[0];
      const nx = touch.clientX - startX;
      const ny = touch.clientY - startY;
      if (!engaged) {
        if (Math.abs(nx) < ENGAGE_PX || Math.abs(nx) < Math.abs(ny) * 1.2) return;
        if (nx <= 0) {
          tracking = false;
          root.classList.remove("edge-armed");
          return;
        }
        engaged = true;
        root.classList.add("dragging");
        // Built from state that is already in memory: no read is issued for it.
        under = underLayer();
        if (under) app.insertBefore(under, app.firstChild);
      }
      event.preventDefault();
      dx = Math.max(0, nx);
      root.style.transform = `translateX(${dx * FOLLOW}px)`;
      paint(Math.min(1, dx / Math.max(1, window.innerWidth)));
    },
    { passive: false },
  );

  const finish = () => {
    const element = root;
    const layer = under;
    under = null;
    if (!tracking || !element) {
      tracking = false;
      element?.classList.remove("edge-armed");
      return;
    }
    tracking = false;
    element.classList.remove("edge-armed");
    if (!engaged) return;
    engaged = false;
    element.classList.remove("dragging");
    const done = dx > THRESHOLD_PX;
    dx = 0;
    if (prefersReducedMotion()) {
      element.style.transform = "";
      drop(layer);
      if (done) goBack();
      return;
    }
    element.classList.add("settling");
    if (layer) layer.classList.add("settling");
    if (done) {
      haptic(8);
      // The layer underneath arrives at its real size just as the pane leaves,
      // so the paint that follows lands on an identical screen.
      element.style.transform = "translateX(100%)";
      if (layer) layer.style.transform = "none";
      // goBack() repaints #app, which takes the borrowed layer with it.
      window.setTimeout(goBack, SETTLE_MS);
      return;
    }
    element.style.transform = "";
    if (layer) layer.style.transform = `translateX(-${UNDER_SHIFT}%) scale(${UNDER_SCALE})`;
    drop(layer);
    window.setTimeout(() => element.classList.remove("settling"), SETTLE_MS);
  };

  app.addEventListener("touchend", finish);
  app.addEventListener("touchcancel", finish);
}
