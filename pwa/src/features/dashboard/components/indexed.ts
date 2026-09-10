import type { CSSProperties } from "react";

/**
 * Entrance stagger position.
 *
 * The card animation delays are CSS custom properties, so the model only has to
 * say where a row sits in the list; this turns that into the inline variable.
 */
export function indexedStyle(index: number): CSSProperties {
  return { "--i": String(index) } as CSSProperties;
}
