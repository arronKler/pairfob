import { termFit } from "../../settings/preferences-store";
import { bindSessionOwnerFromLive } from "../bind-live";
import { fullTerminalHostIsPan } from "./model";

/**
 * Attach/detach boundary for the complete-terminal renderer.
 *
 * Owner token is pane + view incarnation + attach id. Cleanup retires only
 * that owner: it disposes the renderer it attached and never calls
 * `leaveFullTerminal` (route/session close stays the coordinator).
 *
 * Host class bits `is-pan`, `kb-on`, and `kb-off` are engine-owned. React
 * must not pass a changing `className` on `.full-terminal-host`.
 */
export type FullTerminalEngineHost = {
  scheduleMount: (host: HTMLElement) => void;
  disposeRenderer: () => void;
  rendererBusy: () => boolean;
  setShellActive: (active: boolean) => void;
};

let engine: FullTerminalEngineHost | null = null;
let attachSeq = 0;

export function fullTerminalOwnerKey(): string {
  return bindSessionOwnerFromLive().key;
}
let attached: {
  id: number;
  paneId: string;
  host: HTMLElement;
  incarnation: number;
  owner: string;
} | null = null;

export function connectFullTerminalEngine(next: FullTerminalEngineHost): void {
  engine = next;
}

export function attachedFullTerminalHost(): HTMLElement | null {
  return attached?.host ?? null;
}

function applyPanClass(host: HTMLElement): void {
  host.classList.add("full-terminal-host");
  host.classList.toggle("is-pan", fullTerminalHostIsPan(termFit()));
}

export function attachFullTerminalHost(_root: HTMLElement, host: HTMLElement): () => void {
  const id = ++attachSeq;
  const bound = bindSessionOwnerFromLive();
  const paneId = bound.paneId;
  const incarnation = bound.viewIncarnation;
  const owner = bound.key;
  const sameOwner =
    attached &&
    attached.host === host &&
    attached.paneId === paneId &&
    attached.owner === owner;

  if (attached && sameOwner && engine?.rendererBusy()) {
    attached.id = id;
    engine.setShellActive(true);
    return () => retireAttach(id);
  }

  if (attached && attached.host === host && attached.paneId !== paneId) {
    engine?.disposeRenderer();
  }

  applyPanClass(host);
  engine?.setShellActive(true);
  attached = { id, paneId, host, incarnation, owner };
  engine?.scheduleMount(host);
  return () => retireAttach(id);
}

function retireAttach(id: number): void {
  if (!attached || attached.id !== id) return;
  attached = null;
  engine?.disposeRenderer();
  engine?.setShellActive(false);
}

export function clearFullTerminalAttach(): void {
  attached = null;
}
