import { useSyncExternalStore } from "react";

/**
 * A phone on its side: plenty of width, and about 390px of height to share
 * between the session header, the terminal, the key pad and the compose row.
 * The pad is laid out for that here (one row of keys per page, its tabs and
 * dots beside the row instead of under it), and the compose field keeps to the
 * lines the terminal can spare.
 *
 * The width floor keeps a portrait phone out: with the on-screen keyboard up, a
 * layout viewport that resizes for it is briefly wider than it is tall.
 */
export const SHORT_LANDSCAPE_QUERY = "(max-height: 500px) and (orientation: landscape) and (min-width: 480px)";

export function shortLandscape(view: Window | null | undefined = typeof window === "undefined" ? undefined : window): boolean {
  return typeof view?.matchMedia === "function" && view.matchMedia(SHORT_LANDSCAPE_QUERY).matches;
}

function subscribe(listener: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const list = window.matchMedia(SHORT_LANDSCAPE_QUERY);
  list.addEventListener?.("change", listener);
  return () => list.removeEventListener?.("change", listener);
}

/** `shortLandscape()` for a component whose markup follows it. */
export function useShortLandscape(): boolean {
  return useSyncExternalStore(subscribe, () => shortLandscape(), () => false);
}
