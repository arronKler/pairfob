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
  const { app } = await import("../src/state");
  if (app.ownerDocument !== document || !app.isConnected) document.body.append(app);
}
