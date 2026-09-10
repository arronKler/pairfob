import { Window } from "happy-dom";

const happy = new Window({ url: "https://pairfob.com/pair", width: 390, height: 844 });
export function installTestDOM(): void {
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const key of [
    "window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement",
    "HTMLFormElement", "HTMLButtonElement", "HTMLDialogElement", "HTMLProgressElement", "Node",
    "DocumentFragment", "FormData", "localStorage", "sessionStorage",
  ] as const) {
    globals[key] = (happy as unknown as Record<string, unknown>)[key];
  }
  globals.location = happy.location;
  globals.matchMedia = happy.matchMedia.bind(happy);
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(happy.document, "visibilityState", { value: "hidden", configurable: true });
}
installTestDOM();
happy.document.body.innerHTML = '<main id="app"></main>';

export { happy };

/** Every suite restores its realm even when another Happy DOM test ran first. */
export async function resetTestDOM(): Promise<void> {
  installTestDOM();
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
  // Restore the currently BOUND root through the DOM adapter alone (no state
  // facade). The bound node is the one the mounted React root lives on, so it is
  // the exact identity that must be restored: reconnect it whether a body reset
  // detached it (!isConnected) or it was adopted into a different realm (its
  // ownerDocument is foreign — appending it auto-adopts it back into THIS realm).
  // An existing replacement <main id=app> in the body does not steal the identity;
  // the bound node is reconnected beside it (no uniqueness requirement). When
  // nothing has ever been bound, the realm's own <main id=app> resolves fresh.
  const { boundAppRoot } = await import("../src/app/dom-root");
  const bound = boundAppRoot();
  if (bound && (bound.ownerDocument !== document || !bound.isConnected)) {
    document.body.append(bound);
  }
}
