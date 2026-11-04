/**
 * Motion preference read for shared UI.
 *
 * Pure DOM query: no app state, no paint, no `#app` lookup. Lives in `shared/`
 * so shared controls never reach back into an application module for it.
 */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The durations of `--dur-1..4` and `--dur-trace` (shared/ui/styles/tokens.scss),
 * for code that has to wait out a CSS exit before it removes a node. Pick by
 * role, as in the stylesheet; a timer that mirrors a transition names its token
 * here instead of repeating the number.
 */
export const MOTION_MS = {
  /** `--dur-1`: press and hover acknowledgement, and the exit of a small floating thing. */
  press: 120,
  /** `--dur-2`: an element entering or leaving. */
  element: 180,
  /** `--dur-3`: sheets, panels and a block folding open or shut. */
  panel: 240,
  /** `--dur-4`: a screen arriving or leaving. */
  screen: 320,
  /** `--dur-trace`: what an action leaves behind (a sweep, a ripple, a label flying off). */
  trace: 480,
} as const;

/** `ms`, or no wait at all for a reader who asked for less motion. */
export function motionMs(ms: number): number {
  return prefersReducedMotion() ? 0 : ms;
}

/**
 * `--ease` and `--ease-spring` (shared/ui/styles/tokens.scss) for a move made
 * from script: Web Animations cannot read a custom property. The control
 * points are kept as numbers for the few places that step a curve themselves.
 */
export const MOTION_EASE_POINTS = [0.32, 0.72, 0, 1] as const;
export const MOTION_EASE = `cubic-bezier(${MOTION_EASE_POINTS.join(", ")})`;
export const MOTION_SPRING = "cubic-bezier(0.2, 1.05, 0.35, 1)";

/**
 * Play `frames` on `element` for `ms` (one of `MOTION_MS`) on the app's curve.
 *
 * For the moves no rule can name, because their two ends are measured on the
 * page: a button whose label changed width, a field that lost its lines, a
 * thing sent to another place. The animation sits over the element's own style
 * while it runs and leaves nothing behind, so whoever measures that element
 * meanwhile cancels the move first. Null when there is nothing to play: the
 * reader asked for less motion, or the engine has no Web Animations.
 */
export function playMove(element: Element, frames: Keyframe[], ms: number, options: KeyframeAnimationOptions = {}): Animation | null {
  const duration = motionMs(ms);
  if (!duration || typeof element.animate !== "function") return null;
  const animation = element.animate(frames, { duration, easing: MOTION_EASE, ...options });
  // A move is often cancelled when the element is measured or unmounted, and
  // the engine rejects its finished promise. Nobody awaits a move, so handle
  // that rejection here instead of leaving it unhandled.
  void animation.finished?.catch(() => undefined);
  return animation;
}
