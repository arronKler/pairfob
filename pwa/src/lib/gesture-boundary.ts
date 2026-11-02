/** The board and the media viewer always own a pinch; the terminal, a diff's lines and a conversation only while the page is not zoomed. */
const APPLICATION_GESTURE_SURFACE = ".full-terminal-host, .workspace-diff, .agent-stream, .board-canvas, .workspace-media-viewer";
const LEGACY_GESTURE_EVENTS = ["gesturestart", "gesturechange"] as const;

export function isPageZoomed(document: Document): boolean {
  return (document.defaultView?.visualViewport?.scale ?? 1) > 1;
}

/** How far apart the first two fingers are, for the pinches the application owns. */
export function touchSpread(touches: ArrayLike<{ clientX: number; clientY: number }>): number {
  const a = touches[0];
  const b = touches[1];
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

/** Fingers have to spread or close this much before a pinch takes a step. */
export const PINCH_IN = 0.8;
export const PINCH_OUT = 1.25;

/**
 * A two-finger pinch as a ratio of the fingers' distance to where it last took
 * a step. Each crossing takes one step and starts measuring again from there,
 * so a long spread walks through the sizes one at a time.
 */
export class PinchSteps {
  private base = 0;

  start(distance: number): void {
    this.base = distance > 0 ? distance : 0;
  }

  /** The step this distance asks for: 1 bigger, -1 smaller, 0 none yet. */
  move(distance: number): 1 | -1 | 0 {
    if (this.base <= 0 || distance <= 0) return 0;
    const ratio = distance / this.base;
    if (ratio >= PINCH_OUT) { this.base = distance; return 1; }
    if (ratio <= PINCH_IN) { this.base = distance; return -1; }
    return 0;
  }

  end(): void {
    this.base = 0;
  }

  get active(): boolean {
    return this.base > 0;
  }
}

function applicationOwnsGesture(document: Document, target: EventTarget | null): boolean {
  const ElementType = document.defaultView?.Element;
  if (!ElementType || !(target instanceof ElementType)) return false;
  const surface = target.closest(APPLICATION_GESTURE_SURFACE);
  return Boolean(surface && (surface.matches(".board-canvas, .workspace-media-viewer") || !isPageZoomed(document)));
}

/**
 * Preserve native page zoom except on canvases that implement their own pinch
 * gesture. Legacy iOS gesture events are not covered reliably by touch-action.
 */
export function bindLegacyGestureBoundary(document: Document): () => void {
  let owned = false;
  const preventOwnedGesture = (event: Event) => {
    // Keep the owner for the whole gesture, including its final scale=1 frame.
    if (event.type === "gesturestart") owned = applicationOwnsGesture(document, event.target);
    if (owned) event.preventDefault();
  };
  for (const type of LEGACY_GESTURE_EVENTS) {
    document.addEventListener(type, preventOwnedGesture, { passive: false });
  }
  return () => {
    for (const type of LEGACY_GESTURE_EVENTS) document.removeEventListener(type, preventOwnedGesture);
  };
}
