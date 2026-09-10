import { sameFullTerminalView } from "./model";
import type { FullTerminalStage } from "./full-terminal-state";

export type FullTerminalViewSnapshot = {
  owner: string;
  paneId: string;
  title: string;
  working: boolean;
  stage: FullTerminalStage;
  detail: string;
  retry: boolean;
  busy: boolean;
  composeLive: boolean;
  keyboardOpen: boolean;
};

const emptySnapshot: FullTerminalViewSnapshot = {
  owner: "",
  paneId: "",
  title: "",
  working: false,
  stage: "loading",
  detail: "",
  retry: false,
  busy: false,
  composeLive: false,
  keyboardOpen: false,
};

let snapshot: FullTerminalViewSnapshot = emptySnapshot;
let viewRevision = 0;
const viewListeners = new Set<() => void>();

export function fullTerminalViewRevision(): number {
  return viewRevision;
}

export function getFullTerminalView(): FullTerminalViewSnapshot {
  return snapshot;
}

export function subscribeFullTerminalView(listener: () => void): () => void {
  viewListeners.add(listener);
  return () => {
    viewListeners.delete(listener);
  };
}

/** Publish chrome/status/mode. Unchanged live frames are dropped. */
export function publishFullTerminalView(next: FullTerminalViewSnapshot): void {
  if (sameFullTerminalView(snapshot, next)) return;
  snapshot = next;
  viewRevision += 1;
  for (const listener of viewListeners) listener();
}

export function resetFullTerminalView(): void {
  publishFullTerminalView(emptySnapshot);
}
