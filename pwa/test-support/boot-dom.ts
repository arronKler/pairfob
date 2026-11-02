import { Window } from "happy-dom";
import "./node-inspect";
import { isolateMediaQueryListeners } from "./media-query-listeners";

const happy = new Window({ url: "https://pairfob.com/pair", width: 390, height: 844 });
// The suite's copy baseline is Chinese; a host that reports English must not
// change what a boot-time language detection renders.
Object.defineProperty(happy.navigator, "language", { configurable: true, value: "zh-CN" });
Object.defineProperty(happy.navigator, "languages", { configurable: true, value: ["zh-CN", "zh"] });
isolateMediaQueryListeners(happy);
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
  // What the files screen remembers on this device (recently opened files, diffs
  // already seen, whether long lines wrap) is module state as well as storage: one case must not hand it
  // to the next.
  const { resetRecentFiles } = await import("../src/features/workspace/recent-files");
  const { resetReviewProgress } = await import("../src/features/workspace/review-progress");
  const { resetWorkspaceWrap, resetPreviewWidth } = await import("../src/features/workspace/prefs");
  const { resetTurnWrites } = await import("../src/features/workspace/turn-writes");
  resetRecentFiles();
  resetReviewProgress();
  resetWorkspaceWrap();
  resetPreviewWidth();
  resetTurnWrites();
  // Column widths the reader dragged: the list beside the open file, the inspector beside the session.
  const { resetWorkspaceListWidth } = await import("../src/features/workspace/prefs");
  const { resetInspectorWidth } = await import("../src/app/layout/inspector-width");
  resetWorkspaceListWidth();
  resetInspectorWidth();
  const { resetSplitChosen } = await import("../src/features/workspace/diff-layout");
  const { resetDiffMemory } = await import("../src/features/workspace/diff");
  resetSplitChosen();
  resetDiffMemory();
}
