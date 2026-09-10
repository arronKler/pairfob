/**
 * Motion preference read for shared UI.
 *
 * Pure DOM query: no app state, no paint, no `#app` lookup. Lives in `shared/`
 * so shared controls never reach back into an application module for it.
 */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
