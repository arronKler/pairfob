import { button, node } from "../lib/dom";
import { t } from "../lib/i18n";
import { tapAsMouse } from "./full-terminal-input";

/** Pixels of finger or wheel travel that map to one remote TUI line. */
export const SCROLL_LINE_PX = 36;
const ENGAGE_PX = 12;
const REPEAT_DELAY_MS = 380;
const REPEAT_EVERY_MS = 90;

export type ScrollAt = { column: number; row: number };
export type RemoteScroll = (
  direction: "up" | "down",
  lines: number,
  source: "wheel" | "page_key",
  at?: ScrollAt,
) => void;

export type HostScrollOptions = {
  /** When false, touch starts are not canceled before a pan is captured. */
  grabTouch?: boolean;
  /** Active horizontal scroller for an explicit touch/pen pan. */
  panXScroller?: () => HTMLElement | null;
  /** Return false to leave this gesture to the host scroller. */
  capturePan?: (fingerDy: number) => boolean;
  /** Synthesize xterm mouse clicks on a still touch tap. */
  tapAsClick?: boolean;
};

export function pageLineCount(viewportRows: number): number {
  if (!Number.isFinite(viewportRows)) return 1;
  return Math.max(1, Math.round(viewportRows) - 1);
}

/**
 * Forward pan and wheel to the live PTY. xterm scrollback stays empty so a
 * TUI's own mouse-wheel / pager logic is what actually moves the view.
 */
export function bindHostScroll(
  host: HTMLElement,
  scroll: RemoteScroll,
  cellAt: (x: number, y: number) => ScrollAt | undefined,
  opts: HostScrollOptions = {},
): () => void {
  const grabTouch = opts.grabTouch !== false;
  const tapAsClick = opts.tapAsClick !== false;
  let pointer: number | null = null;
  let lastX = 0;
  let lastY = 0;
  let panRemainder = 0;
  let wheelRemainder = 0;
  let engaged = false;
  let horizontal = false;
  let panXScroller: HTMLElement | null = null;
  let at: ScrollAt | undefined;

  const resetPointer = () => {
    pointer = null;
    engaged = false;
    horizontal = false;
    panXScroller = null;
    panRemainder = 0;
  };

  const onDown = (event: PointerEvent) => {
    if (pointer !== null || !event.isPrimary || event.button !== 0) return;
    if ((event.target as HTMLElement | null)?.closest?.("button")) return;
    pointer = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    panRemainder = 0;
    engaged = false;
    horizontal = false;
    at = cellAt(event.clientX, event.clientY);
    if (event.pointerType === "touch" || event.pointerType === "pen") {
      const candidate = opts.panXScroller?.() ?? null;
      if (candidate && candidate.scrollWidth > candidate.clientWidth) panXScroller = candidate;
    }
    if (grabTouch && (event.pointerType === "touch" || event.pointerType === "pen")) event.preventDefault();
  };

  const onMove = (event: PointerEvent) => {
    if (event.pointerId !== pointer) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    if (!engaged) {
      if (Math.abs(dy) < ENGAGE_PX && Math.abs(dx) < ENGAGE_PX) return;
      if (Math.abs(dy) < Math.abs(dx) * 1.2) {
        if (!panXScroller) {
          resetPointer();
          return;
        }
        horizontal = true;
      } else if (opts.capturePan && !opts.capturePan(dy)) {
        resetPointer();
        return;
      }
      engaged = true;
      try {
        host.setPointerCapture?.(event.pointerId);
      } catch {
        // A canceled or synthetic pointer can lose capture eligibility. The
        // host still receives the current move, so panning can continue.
      }
    }
    event.preventDefault();
    lastX = event.clientX;
    lastY = event.clientY;
    if (horizontal && panXScroller) {
      panXScroller.scrollLeft -= dx;
      return;
    }
    panRemainder -= dy;
    const lines = Math.trunc(Math.abs(panRemainder) / SCROLL_LINE_PX);
    if (!lines) return;
    const direction = panRemainder < 0 ? "up" : "down";
    panRemainder %= SCROLL_LINE_PX;
    scroll(direction, Math.min(lines, 40), "wheel", at);
  };

  const onUp = (event: PointerEvent) => {
    if (event.pointerId !== pointer) return;
    const tap = tapAsClick && !engaged && (event.pointerType === "touch" || event.pointerType === "pen");
    resetPointer();
    if (tap) tapAsMouse(host, event);
  };

  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey) return;
    if (opts.panXScroller?.() && Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    if (opts.capturePan && !opts.capturePan(-event.deltaY)) return;
    event.preventDefault();
    wheelRemainder += event.deltaY;
    const lines = Math.trunc(Math.abs(wheelRemainder) / SCROLL_LINE_PX);
    if (!lines) return;
    const direction = wheelRemainder < 0 ? "up" : "down";
    wheelRemainder %= SCROLL_LINE_PX;
    scroll(direction, Math.min(lines, 40), "wheel", cellAt(event.clientX, event.clientY));
  };

  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length > 1) {
      resetPointer();
    }
  };

  host.addEventListener("pointerdown", onDown, { passive: false });
  host.addEventListener("pointermove", onMove, { passive: false, capture: true });
  host.addEventListener("pointerup", onUp);
  host.addEventListener("pointercancel", onUp);
  host.addEventListener("lostpointercapture", onUp);
  host.addEventListener("wheel", onWheel, { passive: false });
  host.addEventListener("touchstart", onTouchStart, { passive: true });
  return () => {
    host.removeEventListener("pointerdown", onDown);
    host.removeEventListener("pointermove", onMove, { capture: true } as AddEventListenerOptions);
    host.removeEventListener("pointerup", onUp);
    host.removeEventListener("pointercancel", onUp);
    host.removeEventListener("lostpointercapture", onUp);
    host.removeEventListener("wheel", onWheel);
    host.removeEventListener("touchstart", onTouchStart);
  };
}

function bindHold(element: HTMLElement, fire: () => void): void {
  let hold: number | null = null;
  let tick: number | null = null;
  const stop = () => {
    if (hold !== null) window.clearTimeout(hold);
    if (tick !== null) window.clearInterval(tick);
    hold = null;
    tick = null;
  };
  element.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    fire();
    stop();
    hold = window.setTimeout(() => {
      if (!element.isConnected) return;
      tick = window.setInterval(() => {
        // A detached button never receives pointerup; see session/keys.ts.
        if (!element.isConnected) {
          stop();
          return;
        }
        fire();
      }, REPEAT_EVERY_MS);
    }, REPEAT_DELAY_MS);
  });
  element.addEventListener("click", (event) => {
    // Pointer activation already fired on pointerdown so the press can repeat.
    // Keyboard and programmatic button activation produce a zero-detail click.
    if (event.detail !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    fire();
  });
  element.addEventListener("keydown", (event) => {
    // Some embedded browsers do not synthesize a click for Space on buttons.
    // Own both key phases so no native click or page scroll can duplicate it.
    if (event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
  });
  element.addEventListener("keyup", (event) => {
    if (event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    fire();
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave", "lostpointercapture"] as const) {
    element.addEventListener(type, stop);
  }
}

export function scrollRail(scroll: RemoteScroll, pageLines: () => number): HTMLElement {
  const rail = node("div", "full-terminal-scroll");
  rail.setAttribute("role", "group");
  rail.setAttribute("aria-label", t("keys.scrollAria"));
  const add = (
    mark: string,
    aria: string,
    direction: "up" | "down",
    source: "wheel" | "page_key",
    lines: number | (() => number),
  ) => {
    const el = button("", `full-terminal-scroll-btn ${mark}`);
    el.setAttribute("aria-label", aria);
    el.title = aria;
    bindHold(el, () => {
      const count = typeof lines === "function" ? lines() : lines;
      scroll(direction, Number.isFinite(count) ? Math.max(1, Math.round(count)) : 1, source);
    });
    rail.append(el);
  };
  add("scroll-up", t("keys.wheelUp"), "up", "wheel", 3);
  add("scroll-page-up", t("keys.pageUp"), "up", "page_key", pageLines);
  add("scroll-page-down", t("keys.pageDown"), "down", "page_key", pageLines);
  add("scroll-down", t("keys.wheelDown"), "down", "wheel", 3);
  return rail;
}
