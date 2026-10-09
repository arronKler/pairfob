import { haptic } from "../dom/feedback";
import { prefersReducedMotion } from "../dom/motion";
import { CARD } from "./desk-form";

/**
 * Drag-to-dismiss for bottom sheets.
 *
 * The close button sits in the top-right corner, which is exactly where a thumb
 * cannot reach on a phone held in one hand. Below the desk breakpoint the modal
 * is already a bottom sheet (see `overlay.scss`), so a downward drag there means
 * "put it away" — the same gesture both mobile platforms train.
 *
 * A dialog a mouse or the keyboard opened beside the list is a card below that
 * width too (`desk-form`). Nothing here applies to it for as long as it is one:
 * it is asked on every gesture and every time its class changes, because a
 * window dragged down to the phone layout turns the open card into the sheet,
 * and widening it again turns the sheet back into the card.
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

/** Upward travel that asks an expandable sheet for its taller height. */
const EXPAND_PX = 48;

/** Safety net for a transitionend that never arrives (element removed mid-flight). */
const CLOSE_FALLBACK_MS = 420;

export function sheetRelease(travel: number, height: number, velocity: number): "close" | "spring" {
  if (travel <= 0) return "spring";
  return travel > height * TRAVEL_RATIO || velocity > FLICK_PX_PER_MS ? "close" : "spring";
}

/**
 * Release for a sheet with two heights. Up expands a collapsed sheet; down from
 * the expanded height collapses it first, and only a collapsed sheet closes.
 */
export function sheetDetentRelease(dy: number, height: number, velocity: number,
  expanded: boolean): "expand" | "collapse" | "close" | "spring" {
  if (dy < 0) return !expanded && (-dy > EXPAND_PX || velocity < -FLICK_PX_PER_MS) ? "expand" : "spring";
  const release = sheetRelease(dy, height, velocity);
  return release === "close" && expanded ? "collapse" : release;
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
  /** Two heights instead of one; the owner renders the expanded state. */
  detents?: { expanded(): boolean; set(expanded: boolean): void };
};

/**
 * The sheets that hold the page back right now. A sheet may open over another
 * as its next step (`DIALOG_STEP`): the page stays back until the last of them
 * lets go, so putting the step away leaves the first one's page where it was.
 */
const holding = new Set<HTMLDialogElement>();

function holdPage(dialog: HTMLDialogElement, held: boolean): void {
  if (held) holding.add(dialog);
  else holding.delete(dialog);
  // A sheet that went away without its close being heard holds nothing.
  for (const other of holding) if (!other.isConnected || !other.open) holding.delete(other);
  document.body.classList.toggle("sheet-open", holding.size > 0);
}

export function bindSheetDrag({ dialog, form, scroller, close, detents }: SheetDrag): () => void {
  const bindings = new AbortController();
  const signal = bindings.signal;
  let retired = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  /** This sheet is what holds the page back. */
  let receded = false;
  const cleanup = () => {
    if (retired) return;
    retired = true;
    bindings.abort();
    clearTimeout(closeTimer);
    form.classList.remove("is-sheet-dragging", "is-sheet-closing");
    form.style.transform = "";
    // Only what this sheet pushed back comes forward: another one may still be up.
    if (receded) holdPage(dialog, false);
    document.body.classList.remove("sheet-dragging");
    document.body.style.removeProperty("--sheet-lift");
  };
  let startY = 0;
  let startX = 0;
  let lastY = 0;
  let lastAt = 0;
  let velocity = 0;
  let travel = 0;
  let pull = 0;
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

  // The page behind recedes for as long as the sheet is up. The class rides the
  // dialog's own lifecycle so no caller has to remember to clear it. A card
  // leaves the page where it is; its owner can hand it to the sheet and take it
  // back, and a drag caught by that change is let go where it started.
  const present = () => {
    if (retired || !dialog.open) return;
    const card = dialog.matches(CARD);
    if (card === !receded) return;
    receded = !card;
    holdPage(dialog, receded);
    if (!card) return;
    tracking = false;
    if (engaged) settle();
    engaged = false;
  };
  queueMicrotask(present);
  const presented = typeof MutationObserver === "function" ? new MutationObserver(present) : null;
  presented?.observe(dialog, { attributes: true, attributeFilter: ["class"] });
  signal.addEventListener("abort", () => presented?.disconnect());
  dialog.addEventListener("close", cleanup, { signal });

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
      if (!window.matchMedia(PHONE).matches || dialog.matches(CARD) || event.touches.length !== 1) return;
      const target = event.target as Element | null;
      // Typing in an operation dialog must not be interrupted by a drag.
      if (target?.closest?.("input, textarea, select")) return;
      // Content with its own drag (a layout preview's dividers and lift) opts out.
      if (target?.closest?.("[data-sheet-gesture]")) return;
      // A scrolled list keeps its own scroll; the sheet only follows from the top.
      const inScroller = scroller && target && scroller.contains(target);
      if (inScroller && scroller.scrollTop > 0) return;
      const touch = event.touches[0];
      tracking = true;
      engaged = false;
      travel = 0;
      pull = 0;
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
        const expanding = !!detents && !detents.expanded();
        if (dy < 0 && !expanding && scroller && scroller.scrollTop <= 0 && scroller.scrollHeight > scroller.clientHeight) {
          // Upward from the top of a scrollable list is still a scroll, unless
          // the sheet can still grow: then the first pull expands it.
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
      pull = dy;
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
    const release = detents ? sheetDetentRelease(pull, height, velocity, detents.expanded())
      : sheetRelease(travel, height, velocity);
    if (release === "close") dismiss();
    else {
      settle();
      if (release === "expand" || release === "collapse") detents?.set(release === "expand");
    }
    travel = 0;
    pull = 0;
  };

  dialog.addEventListener("touchend", release, { signal });
  dialog.addEventListener("touchcancel", release, { signal });
  return cleanup;
}
