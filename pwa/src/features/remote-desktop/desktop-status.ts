import { useSyncExternalStore } from "react";
import { connectionPhaseOf } from "../../lib/connection-phase";
import { useConnection } from "../connection/hooks";
import { useLiveSession } from "../computers/hooks";
import { useCapabilities } from "../operations/hooks";

export type DesktopPip = "ready" | "relay" | "live" | "off";

export type DesktopStatus = {
  pip: DesktopPip;
  live: boolean;
  supported: boolean;
};

let desktopLive = false;
const liveListeners = new Set<() => void>();

/** Called by DesktopScreen when streaming starts/stops so navigation chrome adapts. */
export function setDesktopLive(live: boolean): void {
  if (desktopLive === live) return;
  desktopLive = live;
  for (const listener of [...liveListeners]) listener();
}

export function getDesktopLive(): boolean {
  return desktopLive;
}

function subscribeDesktopLive(listener: () => void): () => void {
  liveListeners.add(listener);
  return () => {
    liveListeners.delete(listener);
  };
}

/** Reactive remote desktop status for phone TabBar and desktop RailFoot pips. */
export function useDesktopStatus(): DesktopStatus {
  const live = useSyncExternalStore(subscribeDesktopLive, getDesktopLive, getDesktopLive);
  const capabilities = useCapabilities();
  const connection = useConnection();
  const session = useLiveSession();

  const supported = capabilities.operationCapabilities.view_desktop === true;
  const connected = connectionPhaseOf(session) === "connected";

  let pip: DesktopPip = "off";
  if (live) pip = "live";
  else if (connected && supported) pip = connection.sessionTransport === "p2p" ? "ready" : "relay";

  return { pip, live, supported };
}
