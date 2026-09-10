import { haptic } from "../dom/feedback";

const HOLD_MS = 450;
const SLOP_PX = 8;

/** Long-press, right-click, and the context-menu key open an object menu. */
export function bindObjectPress(el: HTMLElement, open: () => void): () => void {
  const lifetime = new AbortController();
  const on = <K extends keyof HTMLElementEventMap>(type: K, listener: (event: HTMLElementEventMap[K]) => void, capture = false) => {
    el.addEventListener(type, listener, { capture, signal: lifetime.signal });
  };
  let timer = 0;
  let startX = 0;
  let startY = 0;
  let eatClick = false;
  let pointerId: number | null = null;

  const clearTimer = () => {
    if (!timer) return;
    window.clearTimeout(timer);
    timer = 0;
  };

  const fire = (fromHold = false) => {
    if (!el.isConnected || eatClick) return;
    eatClick = true;
    haptic(8);
    open();
    if (fromHold && pointerId !== null) swallowReleaseClick(el.ownerDocument, pointerId);
  };

  on("pointerdown", (event) => {
    if (!event.isPrimary) { clearTimer(); return; }
    eatClick = false;
    pointerId = null;
    clearTimer();
    if (event.pointerType === "mouse" && event.button !== 0) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    timer = window.setTimeout(() => {
      timer = 0;
      fire(true);
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
    fire();
  });
  return () => {
    clearTimer();
    lifetime.abort();
  };
}

/** showModal can retarget the opening gesture's click onto its backdrop or an
 * action. Capture that click above both targets, until the next user gesture. */
function swallowReleaseClick(doc: Document, pointerId: number): void {
  const cleanup = () => {
    doc.removeEventListener("click", swallow, true);
    doc.removeEventListener("pointerdown", nextPress, true);
    doc.removeEventListener("pointercancel", cancel, true);
    doc.removeEventListener("keydown", cleanup, true);
    doc.defaultView?.removeEventListener("blur", cleanup);
  };
  const swallow = (event: MouseEvent) => {
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
}
