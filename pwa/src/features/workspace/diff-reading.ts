import { useEffect, type CSSProperties, type RefObject } from "react";
import { pointerFine } from "../../app/input-mode";
import { isPageZoomed, PinchSteps, touchSpread } from "../../lib/gesture-boundary";
import { DIFF_SIZES, diffSize, setDiffSize, useDiffSize, useDiffWrap } from "./prefs";

/** The shared pinch recognizer, re-exported where the diff's own tests and calls look for it. */
export { PINCH_IN, PINCH_OUT, PinchSteps } from "../../lib/gesture-boundary";

/**
 * The reading size and wrap of a diff (kept in `prefs`) on its lines: the size
 * they are drawn at, its steps, and the two-finger pinch that takes them.
 */

/**
 * The size the style sheet gives the lines when the reader has picked none
 * (`--diff-fs-auto`, registered as a length so it is read here in px): it
 * follows the terminal's size, a size up under a finger. A browser without
 * registered properties (Safari before 16.4) leaves it unworked, so the size
 * is read off the lines themselves, or, while the reader's own is on them,
 * off a box beside them that only the style sheet sizes.
 */
export function autoDiffSize(lines: Element | null): number {
  const view = lines?.ownerDocument.defaultView;
  if (!lines || !view) return pointerFine() ? 12.5 : 13;
  const style = view.getComputedStyle(lines);
  const auto = Number.parseFloat(style.getPropertyValue("--diff-fs-auto"));
  if (auto > 0) return auto;
  let drawn = Number.parseFloat(style.fontSize);
  if (diffSize() !== null) {
    const probe = lines.ownerDocument.createElement("div");
    probe.className = "workspace-diff-pending";
    probe.hidden = true;
    lines.after(probe);
    drawn = Number.parseFloat(view.getComputedStyle(probe).fontSize);
    probe.remove();
  }
  return drawn > 0 ? drawn : pointerFine() ? 12.5 : 13;
}

/** The size the lines are drawn at: the reader's, or else the style sheet's. */
export function drawnDiffSize(lines: Element | null): number {
  return diffSize() ?? autoDiffSize(lines);
}

/** A size this close to another is the same size. */
const SAME_SIZE = 0.05;

/**
 * The steps from small to large: the reader's sizes, and the style sheet's own
 * where it is not one of them, so a step can always come back to it.
 */
function steps(auto: number): number[] {
  const sizes: number[] = [...DIFF_SIZES];
  if (!sizes.some((size) => Math.abs(size - auto) <= SAME_SIZE)) sizes.push(auto);
  return sizes.sort((a, b) => a - b);
}

function nextSize(direction: 1 | -1, auto: number): number | undefined {
  const from = diffSize() ?? auto;
  const sizes = steps(auto);
  return direction > 0
    ? sizes.find((size) => size > from + SAME_SIZE)
    : sizes.reverse().find((size) => size < from - SAME_SIZE);
}

export function canStepDiffSize(direction: 1 | -1, auto: number): boolean {
  return nextSize(direction, auto) !== undefined;
}

/**
 * The step bigger (1) or smaller (-1) than the size drawn, where `auto` is the
 * style sheet's. Landing on the style sheet's size gives the choice back to it,
 * so the lines follow the terminal again. False past either end.
 */
export function stepDiffSize(direction: 1 | -1, auto: number): boolean {
  const next = nextSize(direction, auto);
  if (next === undefined) return false;
  setDiffSize(Math.abs(next - auto) <= SAME_SIZE ? null : next);
  return true;
}

export type DiffReading = { className: string; style?: CSSProperties };

/** The reader's size on a box of diff lines (`has-diff-fs`): the lines, and the skeleton that stands in for them. */
export function useDiffSizeBox(): DiffReading {
  const size = useDiffSize();
  return size === null ? { className: "" } : { className: " has-diff-fs", style: { "--diff-fs": `${size}px` } as CSSProperties };
}

/**
 * The scroller's classes and style for how the reader wants the lines: their
 * size, kept whole where wrapping is off (never side by side), and the gutter
 * as wide as the patch's longest line number (`digits`).
 */
export function useDiffReading(split: boolean, digits?: number): DiffReading {
  const box = useDiffSizeBox();
  const wraps = useDiffWrap();
  const className = `${box.className}${!split && !wraps ? " is-nowrap" : ""}`;
  if (digits === undefined) return { className, style: box.style };
  return { className, style: { ...box.style, "--diff-digits": String(digits) } as CSSProperties };
}

/**
 * Two fingers on the diff step its size instead of zooming the page. One
 * finger is left alone: the listener for a one-finger move never cancels it,
 * so scrolling stays native. A page the reader has already zoomed keeps its
 * own pinch, so it can always be zoomed back out over the lines (the style
 * sheet hands `pinch-zoom` back too, and `gesture-boundary` Safari's gesture
 * events).
 */
export function useDiffPinch(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pinch = new PinchSteps();
    const zoomed = () => isPageZoomed(el.ownerDocument);
    const onStart = (event: TouchEvent) => {
      if (event.touches.length === 2 && !zoomed()) pinch.start(touchSpread(event.touches));
      else pinch.end();
    };
    const onMove = (event: TouchEvent) => {
      if (event.touches.length !== 2 || !pinch.active) return;
      if (zoomed()) {
        pinch.end();
        return;
      }
      if (event.cancelable) event.preventDefault();
      const step = pinch.move(touchSpread(event.touches));
      if (!step) return;
      stepDiffSize(step, autoDiffSize(el));
    };
    const onEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) pinch.end();
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [ref]);
}
