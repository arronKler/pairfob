import { button, node } from "../lib/dom";
import { isPageZoomed } from "../lib/gesture-boundary";
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
  let source: "pointer" | "touch" | null = null;
  let pointer: number | null = null;
  let touch: number | null = null;
  let lastX = 0;
  let lastY = 0;
  let panRemainder = 0;
  let wheelRemainder = 0;
  let engaged = false;
  let horizontal = false;
  let panXScroller: HTMLElement | null = null;
  let at: ScrollAt | undefined;

  const resetGesture = () => {
    source = null;
    pointer = null;
    touch = null;
    engaged = false;
    horizontal = false;
    panXScroller = null;
    panRemainder = 0;
    at = undefined;
  };

  const beginGesture = (
    nextSource: "pointer" | "touch",
    id: number,
    point: Pick<PointerEvent, "clientX" | "clientY">,
    canPanX: boolean,
  ) => {
    resetGesture();
    source = nextSource;
    if (nextSource === "pointer") pointer = id;
    else touch = id;
    lastX = point.clientX;
    lastY = point.clientY;
    panRemainder = 0;
    at = cellAt(point.clientX, point.clientY);
    if (canPanX) {
      const candidate = opts.panXScroller?.() ?? null;
      if (candidate && candidate.scrollWidth > candidate.clientWidth) panXScroller = candidate;
    }
  };

  const moveGesture = (clientX: number, clientY: number): boolean => {
    const dx = clientX - lastX;
    const dy = clientY - lastY;
    if (!engaged) {
      if (Math.abs(dy) < ENGAGE_PX && Math.abs(dx) < ENGAGE_PX) return false;
      if (Math.abs(dy) < Math.abs(dx) * 1.2) {
        if (!panXScroller) {
          resetGesture();
          return false;
        }
        horizontal = true;
      } else if (opts.capturePan && !opts.capturePan(dy)) {
        resetGesture();
        return false;
      }
      engaged = true;
    }
    lastX = clientX;
    lastY = clientY;
    if (horizontal && panXScroller) {
      panXScroller.scrollLeft -= dx;
      return true;
    }
    panRemainder -= dy;
    const lines = Math.trunc(Math.abs(panRemainder) / SCROLL_LINE_PX);
    if (!lines) return true;
    const direction = panRemainder < 0 ? "up" : "down";
    panRemainder %= SCROLL_LINE_PX;
    scroll(direction, Math.min(lines, 40), "wheel", at);
    return true;
  };

  const onDown = (event: PointerEvent) => {
    if (event.pointerType !== "mouse" && isPageZoomed(host.ownerDocument)) return;
    if (source !== null || !event.isPrimary || event.button !== 0) return;
    if ((event.target as HTMLElement | null)?.closest?.("button")) return;
    beginGesture(
      "pointer",
      event.pointerId,
      event,
      event.pointerType === "touch" || event.pointerType === "pen",
    );
    if (grabTouch && (event.pointerType === "touch" || event.pointerType === "pen")) event.preventDefault();
  };

  const onMove = (event: PointerEvent) => {
    if (event.pointerType !== "mouse" && isPageZoomed(host.ownerDocument)) {
      resetGesture();
      return;
    }
    if (source !== "pointer" || event.pointerId !== pointer) return;
    const wasEngaged = engaged;
    if (!moveGesture(event.clientX, event.clientY)) return;
    if (!wasEngaged && engaged) {
      try {
        host.setPointerCapture?.(event.pointerId);
      } catch {
        // A canceled or synthetic pointer can lose capture eligibility. The
        // host still receives the current move, so panning can continue.
      }
    }
    event.preventDefault();
  };

  const onUp = (event: PointerEvent) => {
    if (source !== "pointer" || event.pointerId !== pointer) return;
    const tap = event.type === "pointerup" && tapAsClick && !engaged && !isPageZoomed(host.ownerDocument)
      && (event.pointerType === "touch" || event.pointerType === "pen");
    resetGesture();
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

  const findTouch = (list: TouchList, identifier: number): Touch | null => {
    for (let index = 0; index < list.length; index++) {
      if (list[index].identifier === identifier) return list[index];
    }
    return null;
  };

  const onTouchStart = (event: TouchEvent) => {
    if (isPageZoomed(host.ownerDocument)) {
      resetGesture();
      return;
    }
    if (!grabTouch) {
      if (event.touches.length > 1) resetGesture();
      return;
    }
    if (event.touches.length !== 1) {
      resetGesture();
      return;
    }
    if ((event.target as HTMLElement | null)?.closest?.("button")) return;
    const point = event.touches[0];
    beginGesture("touch", point.identifier, point, true);
    event.preventDefault();
  };

  const onTouchMove = (event: TouchEvent) => {
    if (isPageZoomed(host.ownerDocument)) {
      resetGesture();
      return;
    }
    if (source !== "touch" || touch === null) return;
    if (event.touches.length !== 1) {
      resetGesture();
      return;
    }
    const point = findTouch(event.touches, touch);
    if (!point) return;
    event.preventDefault();
    moveGesture(point.clientX, point.clientY);
  };

  const onTouchEnd = (event: TouchEvent) => {
    if (source !== "touch" || touch === null) return;
    const point = findTouch(event.changedTouches, touch);
    if (!point) return;
    const tap = tapAsClick && !engaged && !isPageZoomed(host.ownerDocument);
    resetGesture();
    if (tap) tapAsMouse(host, point);
  };

  const onTouchCancel = () => {
    if (source === "touch") resetGesture();
  };

  host.addEventListener("pointerdown", onDown, { passive: false });
  host.addEventListener("pointermove", onMove, { passive: false, capture: true });
  host.addEventListener("pointerup", onUp);
  host.addEventListener("pointercancel", onUp);
  host.addEventListener("lostpointercapture", onUp);
  host.addEventListener("wheel", onWheel, { passive: false });
  host.addEventListener("touchstart", onTouchStart, { passive: false });
  host.addEventListener("touchmove", onTouchMove, { passive: false });
  host.addEventListener("touchend", onTouchEnd);
  host.addEventListener("touchcancel", onTouchCancel);
  return () => {
    host.removeEventListener("pointerdown", onDown);
    host.removeEventListener("pointermove", onMove, { capture: true } as AddEventListenerOptions);
    host.removeEventListener("pointerup", onUp);
    host.removeEventListener("pointercancel", onUp);
    host.removeEventListener("lostpointercapture", onUp);
    host.removeEventListener("wheel", onWheel);
    host.removeEventListener("touchstart", onTouchStart);
    host.removeEventListener("touchmove", onTouchMove);
    host.removeEventListener("touchend", onTouchEnd);
    host.removeEventListener("touchcancel", onTouchCancel);
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
