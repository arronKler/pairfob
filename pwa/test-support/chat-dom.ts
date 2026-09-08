import { happy, resetTestDOM } from "./boot-dom";
export { happy };
export async function resetChatDOM(): Promise<void> {
  await resetTestDOM();
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const key of ["HTMLDetailsElement", "ResizeObserver", "MutationObserver", "DOMParser"] as const) {
    globals[key] = (happy as unknown as Record<string, unknown>)[key];
  }
  globals.history = happy.history;
  globals.getComputedStyle = happy.getComputedStyle.bind(happy);
  globals.requestAnimationFrame = happy.requestAnimationFrame.bind(happy);
  globals.cancelAnimationFrame = happy.cancelAnimationFrame.bind(happy);
  globals.visualViewport = happy.visualViewport;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(happy.document, "visibilityState", { value: "visible", configurable: true });
}
await resetChatDOM();
