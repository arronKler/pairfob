export const SNAPSHOT_FALLBACK_MS = 15_000;
export const PANE_READ_FALLBACK_MS = 1_500;
export const AGENT_TRACE_IDLE_MS = 10_000;

export function panePollDelayMs(agentChat: boolean, agentWorking: boolean): number {
  return agentChat && !agentWorking ? AGENT_TRACE_IDLE_MS : PANE_READ_FALLBACK_MS;
}

/**
 * Agent status only rides the Snapshot, so on the pane screen the header would
 * trail the buffer by up to a full fallback period: you answer a prompt, the
 * terminal shows the agent working, and the dot and the interrupt button stay
 * idle. A buffer change is the evidence that something happened, so it pulls the
 * next Snapshot forward — throttled, because a streaming agent changes the
 * buffer on every read.
 */
export const PANE_STATUS_FLOOR_MS = 4_000;

export function shouldPullStatus(changed: boolean, now: number, lastSnapshotAt: number): boolean {
  return changed && now - lastSnapshotAt >= PANE_STATUS_FLOOR_MS;
}

export type PokeRefreshKind = "runtime" | "snapshot" | "paneread" | "ignore";

/**
 * Visible-screen poke routing. Hidden callers must not invoke this for work —
 * they stop both fallback loops instead. Open-pane cards still use the 15s Snapshot
 * fallback; a mismatched pane poke never triggers Snapshot.
 */
export function pokeRefreshAction(
  screen: "home" | "pane" | "workspace" | "settings" | "computers",
  openPaneId: string,
  pokePaneId?: string,
  reason?: string,
): PokeRefreshKind {
  if (reason === "herdr_offline" || reason === "herdr_online") return "runtime";
  if (screen === "pane" && openPaneId) {
    return pokePaneId === openPaneId ? "paneread" : "ignore";
  }
  return "snapshot";
}
