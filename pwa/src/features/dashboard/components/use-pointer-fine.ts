import { useSyncExternalStore } from "react";
import { pointerFine } from "../../../app/input-mode";

/** The query `pointerFine` reads; a tablet gaining or losing a mouse flips it. */
const FINE_POINTER = "(hover: hover) and (pointer: fine)";

function subscribe(listener: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(FINE_POINTER);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

/**
 * `pointerFine()` for a component whose markup follows it. The style sheet
 * switches on the same media query, so the two must change together.
 */
export function usePointerFine(): boolean {
  return useSyncExternalStore(subscribe, pointerFine);
}
