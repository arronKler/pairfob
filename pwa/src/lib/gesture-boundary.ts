const APPLICATION_GESTURE_SURFACE = ".full-terminal-host, .board-canvas";
const LEGACY_GESTURE_EVENTS = ["gesturestart", "gesturechange"] as const;

function applicationOwnsGesture(document: Document, target: EventTarget | null): boolean {
  const ElementType = document.defaultView?.Element;
  return Boolean(ElementType && target instanceof ElementType && target.closest(APPLICATION_GESTURE_SURFACE));
}

/**
 * Preserve native page zoom except on canvases that implement their own pinch
 * gesture. Legacy iOS gesture events are not covered reliably by touch-action.
 */
export function bindLegacyGestureBoundary(document: Document): () => void {
  const preventOwnedGesture = (event: Event) => {
    if (applicationOwnsGesture(document, event.target)) event.preventDefault();
  };
  for (const type of LEGACY_GESTURE_EVENTS) {
    document.addEventListener(type, preventOwnedGesture, { passive: false });
  }
  return () => {
    for (const type of LEGACY_GESTURE_EVENTS) document.removeEventListener(type, preventOwnedGesture);
  };
}
