import { useLayoutEffect, type RefObject } from "react";
import { MOTION_MS, MOTION_SPRING, motionMs } from "../dom/motion";

/** The sheet card's last laid-out height, kept current while any view of it is shown. */
const heights = new WeakMap<Element, number>();
const watched = new WeakSet<Element>();

function watch(card: HTMLElement): void {
  if (watched.has(card) || typeof ResizeObserver === "undefined") return;
  watched.add(card);
  new ResizeObserver(() => heights.set(card, card.getBoundingClientRect().height)).observe(card);
}

/**
 * A sheet whose content is replaced whole (a page pushed or popped, a form
 * swapping in its full list) eases from the height it had to the one it has,
 * instead of jumping. Call it from the component that is mounted anew with
 * each view, with a ref inside the sheet. Only the card animates; it sits in
 * the top layer, so nothing behind it is laid out again.
 *
 * The first view of a sheet has no height to come from and is just there.
 */
export function useSheetHeight(inside: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const card = inside.current?.closest<HTMLElement>("dialog > form");
    if (!card) return;
    const before = heights.get(card);
    const after = card.getBoundingClientRect().height;
    heights.set(card, after);
    watch(card);
    const duration = motionMs(MOTION_MS.panel);
    if (before === undefined || Math.abs(before - after) < 2 || !duration || typeof card.animate !== "function") return;
    const animation = card.animate([{ height: `${before}px` }, { height: `${after}px` }], { duration, easing: MOTION_SPRING });
    void animation.finished?.catch(() => undefined);
  }, [inside]);
}
