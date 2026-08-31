import { haptic } from "../state";

const HOLD_MS = 450;
const SLOP_PX = 8;
const EAT_CLICK_MS = 400;

/** Long-press, right-click, and the context-menu key open an object menu. */
export function bindObjectPress(el: HTMLElement, open: () => void): void {
  let timer = 0;
  let startX = 0;
  let startY = 0;
  let eatClickUntil = 0;

  const clearTimer = () => {
    if (!timer) return;
    window.clearTimeout(timer);
    timer = 0;
  };

  const fire = () => {
    eatClickUntil = performance.now() + EAT_CLICK_MS;
    haptic(8);
    open();
  };

  el.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    clearTimer();
    startX = event.clientX;
    startY = event.clientY;
    timer = window.setTimeout(() => {
      timer = 0;
      fire();
    }, HOLD_MS);
  });
  el.addEventListener("pointermove", (event) => {
    if (!timer) return;
    if (Math.hypot(event.clientX - startX, event.clientY - startY) > SLOP_PX) clearTimer();
  });
  el.addEventListener("pointerup", clearTimer);
  el.addEventListener("pointercancel", clearTimer);
  el.addEventListener(
    "click",
    (event) => {
      if (performance.now() >= eatClickUntil) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
  el.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    clearTimer();
    fire();
  });
}
