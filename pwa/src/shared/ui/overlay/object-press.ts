import { haptic } from "../dom/feedback";
import { contextOrigin, noteOverlayOrigin, pointerOrigin, type OverlayOrigin } from "./origin";

const HOLD_MS = 450;
const SLOP_PX = 8;

/**
 * Long-press, right-click, and the context-menu key open an object menu. The
 * opener learns what asked and where, and the same origin is left for the
 * overlay layer, so a menu opened by a mouse can appear at the pointer.
 */
export function bindObjectPress(el: HTMLElement, open: (origin: OverlayOrigin) => void): () => void {
  const lifetime = new AbortController();
  const on = <K extends keyof HTMLElementEventMap>(type: K, listener: (event: HTMLElementEventMap[K]) => void, capture = false) => {
    el.addEventListener(type, listener, { capture, signal: lifetime.signal });
  };
  let timer = 0;
  let startX = 0;
  let startY = 0;
  let eatClick = false;
  let pointerId: number | null = null;
  let press: OverlayOrigin | null = null;

  const clearTimer = () => {
    if (!timer) return;
    window.clearTimeout(timer);
    timer = 0;
  };

  const fire = (origin: OverlayOrigin, fromHold = false) => {
    if (!el.isConnected || eatClick) return;
    eatClick = true;
    haptic(8);
    noteOverlayOrigin(origin);
    open(origin);
    if (fromHold && pointerId !== null) swallowReleaseClick(el.ownerDocument, pointerId);
  };

  on("pointerdown", (event) => {
    if (!event.isPrimary) { clearTimer(); return; }
    eatClick = false;
    pointerId = null;
    clearTimer();
    if (event.pointerType === "mouse" && event.button !== 0) return;
    pointerId = event.pointerId;
    press = pointerOrigin(event);
    startX = event.clientX;
    startY = event.clientY;
    timer = window.setTimeout(() => {
      timer = 0;
      // A held mouse button asks for the object's menu the way a right-click does.
      if (press) fire({ ...press, atPointer: press.input === "mouse" }, true);
    }, HOLD_MS);
  });
  on("pointermove", (event) => {
    if (!timer || event.pointerId !== pointerId) return;
    if (Math.hypot(event.clientX - startX, event.clientY - startY) > SLOP_PX) clearTimer();
  });
  on("pointerup", () => { clearTimer(); pointerId = null; });
  on("pointercancel", clearTimer);
  on("pointerleave", clearTimer);
  on("lostpointercapture", clearTimer);
  on(
    "click",
    (event) => {
      if (!eatClick) return;
      eatClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
  on("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") eatClick = false;
  });
  on("contextmenu", (event) => {
    event.preventDefault();
    clearTimer();
    if (pointerId === null) eatClick = false;
    fire(contextOrigin(event));
  });
  return () => {
    clearTimer();
    lifetime.abort();
  };
}

/** showModal can retarget the opening gesture's click onto its backdrop or an
 * action. Capture that click above both targets, until the next user gesture.
 *
 * `release` is for a guard armed as the pointer lifts, when the release itself
 * replaced the screen under it and its click would press whatever sits there
 * now. That click is the browser's own and comes at once, so the guard lapses
 * after `withinMs` and lets a scripted or assistive activation (detail 0) by. */
export function swallowReleaseClick(doc: Document, pointerId: number, release?: { withinMs: number }): void {
  let lapse = 0;
  const cleanup = () => {
    if (lapse) clearTimeout(lapse);
    doc.removeEventListener("click", swallow, true);
    doc.removeEventListener("pointerdown", nextPress, true);
    doc.removeEventListener("pointercancel", cancel, true);
    doc.removeEventListener("keydown", cleanup, true);
    doc.defaultView?.removeEventListener("blur", cleanup);
  };
  const swallow = (event: MouseEvent) => {
    if (release && event.detail === 0) return;
    cleanup();
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const nextPress = (event: PointerEvent) => {
    if (event.isPrimary) cleanup();
  };
  const cancel = (event: PointerEvent) => {
    if (event.pointerId === pointerId) cleanup();
  };
  doc.addEventListener("click", swallow, true);
  doc.addEventListener("pointerdown", nextPress, true);
  doc.addEventListener("pointercancel", cancel, true);
  doc.addEventListener("keydown", cleanup, true);
  doc.defaultView?.addEventListener("blur", cleanup, { once: true });
  if (release) lapse = setTimeout(cleanup, release.withinMs) as unknown as number;
}
