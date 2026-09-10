import { happy, resetTestDOM } from "./boot-dom";

/** Board gestures need a visible document and pointer/geometry APIs each test. */
export async function resetBoardTestDOM(): Promise<void> {
  await resetTestDOM();
  Object.assign(globalThis, {
    Element: happy.Element,
    MouseEvent: happy.MouseEvent,
    PointerEvent: happy.PointerEvent,
    WheelEvent: happy.WheelEvent,
    KeyboardEvent: happy.KeyboardEvent,
    TouchEvent: happy.TouchEvent,
    CompositionEvent: happy.CompositionEvent,
    ResizeObserver: happy.ResizeObserver,
    MutationObserver: happy.MutationObserver,
    DOMParser: happy.DOMParser,
    visualViewport: happy.visualViewport,
    history: happy.history,
    getComputedStyle: happy.getComputedStyle.bind(happy),
    requestAnimationFrame: happy.requestAnimationFrame.bind(happy),
    cancelAnimationFrame: happy.cancelAnimationFrame.bind(happy),
  });
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
}

export { happy };
