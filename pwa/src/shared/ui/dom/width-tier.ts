/**
 * Width tiers. Each answers one layout question; none of them says anything
 * about how the reader points or types (see `app/input-mode.ts`). The queries
 * are what a listener subscribes to; the functions also know that a phone
 * turned on its side is wide without being a tablet.
 *
 * Pure DOM queries, kept in `shared/` because the shell and the overlays must
 * agree on them: a menu is anchored exactly where the list sits beside the
 * page. `app/viewport` re-exports them for the application layer.
 */
/** The list sits beside the page: a tablet in portrait and everything wider. */
export const DESK_QUERY = "(min-width: 720px)";
/** Desktop-sized pages, and the inspector beside a session instead of a page of its own. */
export const ROOMY_QUERY = "(min-width: 900px)";
/** The list, the session and the inspector side by side. */
export const WIDE_QUERY = "(min-width: 1200px)";

/** A tablet's short side starts around 600px; no phone's reaches 500. */
const HANDHELD_SHORT_SIDE = 500;

/**
 * A phone-sized screen, whichever way it is held. Width alone cannot tell a
 * phone in landscape from a tablet in portrait; the screen's short side can,
 * and unlike the viewport's height it does not move with the keyboard.
 */
export function handheld(): boolean {
  if (typeof screen === "undefined") return false;
  const short = Math.min(screen.width, screen.height);
  return short > 0 && short < HANDHELD_SHORT_SIDE;
}

/** A phone keeps its own layout until it is as wide as the list beside a page always needed. */
export function isDesk(): boolean {
  return window.matchMedia(ROOMY_QUERY).matches || (window.matchMedia(DESK_QUERY).matches && !handheld());
}

export function isRoomy(): boolean {
  return window.matchMedia(ROOMY_QUERY).matches && !handheld();
}

export function isWide(): boolean {
  return window.matchMedia(WIDE_QUERY).matches;
}
