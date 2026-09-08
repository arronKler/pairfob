import { haptic, prefersReducedMotion } from "./dom";

/**
 * Drag-to-dismiss for bottom sheets.
 *
 * The close button sits in the top-right corner, which is exactly where a thumb
 * cannot reach on a phone held in one hand. Below the desk breakpoint the modal
 * is already a bottom sheet (see `settings.scss`), so a downward drag there means
 * "put it away" — the same gesture both mobile platforms train.
 */

/** Only below this width is the modal a bottom sheet, so only there can it be dragged down. */
const PHONE = "(max-width: 899.98px)";

/** Past a quarter of the sheet, or fast enough, the finger meant to dismiss it. */
const TRAVEL_RATIO = 0.25;
const FLICK_PX_PER_MS = 0.5;

/** Movement that separates a drag from a tap on a menu row. */
const ENGAGE_PX = 8;

/** Upward travel is resisted and capped: there is nothing above a bottom sheet. */
const UP_DAMPING = 0.22;
const UP_LIMIT = 34;

/** Safety net for a transitionend that never arrives (element removed mid-flight). */
const CLOSE_FALLBACK_MS = 420;

export function sheetRelease(travel: number, height: number, velocity: number): "close" | "spring" {
  if (travel <= 0) return "spring";
  return travel > height * TRAVEL_RATIO || velocity > FLICK_PX_PER_MS ? "close" : "spring";
}

export function sheetTravel(dy: number): number {
  return dy >= 0 ? dy : Math.max(dy * UP_DAMPING, -UP_LIMIT);
}

export type SheetDrag = {
  dialog: HTMLDialogElement;
  /** Transform lives on the inner form: a transform on <dialog> leaves the top layer. */
  form: HTMLElement;
  /** The element that scrolls, if any. A drag from inside it only starts at the top. */
  scroller?: HTMLElement | null;
  close: () => void;
};

export function bindSheetDrag({ dialog, form, scroller, close }: SheetDrag): () => void {
  const bindings = new AbortController();
  const signal = bindings.signal;
  let retired = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    if (retired) return;
    retired = true;
    bindings.abort();
    clearTimeout(closeTimer);
    form.classList.remove("is-sheet-dragging", "is-sheet-closing");
    form.style.transform = "";
    document.body.classList.remove("sheet-open", "sheet-dragging");
    document.body.style.removeProperty("--sheet-lift");
  };
  // The page behind recedes for as long as the sheet is up. The class rides the
  // dialog's own lifecycle so no caller has to remember to clear it.
  queueMicrotask(() => {
    if (!retired && dialog.open) document.body.classList.add("sheet-open");
  });
  dialog.addEventListener("close", cleanup, { signal });

  let startY = 0;
  let startX = 0;
  let lastY = 0;
  let lastAt = 0;
  let velocity = 0;
  let travel = 0;
  let tracking = false;
  let engaged = false;
  /** Measured once per gesture: reading it per move would lay out on every frame. */
  let height = 1;

  const lift = (value: number) => document.body.style.setProperty("--sheet-lift", String(value));

  const settle = () => {
    form.classList.remove("is-sheet-dragging");
    document.body.classList.remove("sheet-dragging");
    form.style.transform = "";
    lift(1);
  };

  const dismiss = () => {
    form.classList.remove("is-sheet-dragging");
    document.body.classList.remove("sheet-dragging");
    if (prefersReducedMotion()) {
      close();
      return;
    }
    haptic(8);
    form.style.transform = "";
    form.classList.add("is-sheet-closing");
    lift(0);
    let done = false;
    const run = () => {
      if (done || retired) return;
      done = true;
      close();
    };
    form.addEventListener("transitionend", (event) => {
      if (event.propertyName === "transform") run();
    }, { signal });
    closeTimer = setTimeout(run, CLOSE_FALLBACK_MS);
  };

  dialog.addEventListener(
    "touchstart",
    (event) => {
      if (!window.matchMedia(PHONE).matches || event.touches.length !== 1) return;
      const target = event.target as Element | null;
      // Typing in an operation dialog must not be interrupted by a drag.
      if (target?.closest?.("input, textarea, select")) return;
      // A scrolled list keeps its own scroll; the sheet only follows from the top.
      const inScroller = scroller && target?.closest?.(".sheet-body, .operation-body");
      if (inScroller && scroller.scrollTop > 0) return;
      const touch = event.touches[0];
      tracking = true;
      engaged = false;
      travel = 0;
      velocity = 0;
      startX = touch.clientX;
      startY = touch.clientY;
      lastY = touch.clientY;
      lastAt = event.timeStamp;
    },
    { passive: true, signal },
  );

  dialog.addEventListener(
    "touchmove",
    (event) => {
      if (!tracking) return;
      const touch = event.touches[0];
      const dy = touch.clientY - startY;
      const dx = touch.clientX - startX;
      if (!engaged) {
        if (Math.abs(dy) < ENGAGE_PX || Math.abs(dy) < Math.abs(dx) * 1.2) return;
        if (dy < 0 && scroller && scroller.scrollTop <= 0 && scroller.scrollHeight > scroller.clientHeight) {
          // Upward from the top of a scrollable list is still a scroll.
          tracking = false;
          return;
        }
        engaged = true;
        height = Math.max(1, form.getBoundingClientRect().height);
        form.classList.add("is-sheet-dragging");
        document.body.classList.add("sheet-dragging");
      }
      event.preventDefault();
      const span = Math.max(1, event.timeStamp - lastAt);
      velocity = (touch.clientY - lastY) / span;
      lastY = touch.clientY;
      lastAt = event.timeStamp;
      travel = sheetTravel(dy);
      form.style.transform = `translateY(${travel}px)`;
      // The further the sheet goes, the more of the page behind comes back.
      lift(Math.max(0, 1 - Math.max(0, travel) / height));
    },
    { passive: false, signal },
  );

  const release = () => {
    if (!tracking) return;
    tracking = false;
    if (!engaged) return;
    engaged = false;
    if (sheetRelease(travel, height, velocity) === "close") dismiss();
    else settle();
    travel = 0;
  };

  dialog.addEventListener("touchend", release, { signal });
  dialog.addEventListener("touchcancel", release, { signal });
  return cleanup;
}
