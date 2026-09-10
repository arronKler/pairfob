/**
 * Board rail visibility adapter.
 *
 * The two rails scroll horizontally, so the only honest overflow indicator and
 * the only reliable way to bring the selected chip into view is a measurement
 * after layout. This module owns that measurement: it runs on a frame, tolerates
 * missing nodes, and returns the cancel function a React effect cleans up with.
 */

export const RAIL_OVERFLOW_SLACK_PX = 8;

export type RailElements = {
  root: HTMLElement | null;
  spaceRail: HTMLElement | null;
  spaces: HTMLElement | null;
  tabRail: HTMLElement | null;
  tabs: HTMLElement | null;
};

export function markRailOverflow(rail: HTMLElement, scroller: HTMLElement): void {
  rail.classList.toggle("overflow", scroller.scrollWidth > scroller.clientWidth + RAIL_OVERFLOW_SLACK_PX);
}

export function revealSelection(root: HTMLElement): void {
  root.querySelector<HTMLElement>(".board-chip.on, .board-tab.on")?.scrollIntoView({
    inline: "nearest",
    block: "nearest",
  });
}

/** Measure both rails and reveal the selection on the next frame. */
export function scheduleRailVisibility(rails: RailElements): () => void {
  const frame = requestAnimationFrame(() => {
    if (rails.spaceRail && rails.spaces) markRailOverflow(rails.spaceRail, rails.spaces);
    if (rails.tabRail && rails.tabs) markRailOverflow(rails.tabRail, rails.tabs);
    if (rails.root) revealSelection(rails.root);
  });
  return () => cancelAnimationFrame(frame);
}
