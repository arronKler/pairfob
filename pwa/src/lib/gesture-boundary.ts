const APPLICATION_GESTURE_SURFACE = ".full-terminal-host, .board-canvas";
const LEGACY_GESTURE_EVENTS = ["gesturestart", "gesturechange"] as const;

export function isPageZoomed(document: Document): boolean {
  return (document.defaultView?.visualViewport?.scale ?? 1) > 1;
}

function applicationOwnsGesture(document: Document, target: EventTarget | null): boolean {
  const ElementType = document.defaultView?.Element;
  if (!ElementType || !(target instanceof ElementType)) return false;
  const surface = target.closest(APPLICATION_GESTURE_SURFACE);
  return Boolean(surface && (surface.matches(".board-canvas") || !isPageZoomed(document)));
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
