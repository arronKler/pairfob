import { happy, resetTestDOM } from "./boot-dom";

/** Board gestures need a visible document; the rest of the realm is what resetTestDOM installs. */
export async function resetBoardTestDOM(): Promise<void> {
  await resetTestDOM();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
}

export { happy };
