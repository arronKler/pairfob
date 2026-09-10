import { herdSignature, mapSnapshotAgents, type DashboardAgentCard, type SnapshotWire } from "../../lib/dashboard";
import {
  applySeenCompletions,
  markCompletionSeen,
  parseSeenCompletions,
  projectAgentSubmission,
  projectCompletionAttention,
  type RuntimeAgentStatuses,
  type SeenCompletions,
} from "../../lib/completion-attention";
import { noteCompletionAcknowledged } from "../../lib/herd-attention";
import { batch, createDomain, detach } from "../../shared/model/domain-store";
import { projectSnapshot } from "../board/layout-store";
import { currentDaemonId, currentDeviceId } from "../computers/catalog-store";
import { prunePanePins, prunePanePreferences } from "../settings/preferences-store";
import { openPaneId } from "../session/session-store";

/**
 * Dashboard domain: the herd list. Agent cards projected from the daemon
 * snapshot, the runtime statuses and completion acknowledgements that decide
 * attention, and the refresh flag of the manual pull.
 *
 * Board catalog/camera lives in `board.ts`; per-pane choices in `preferences.ts`.
 */
export const COMPLETION_SEEN_KEY = "pairfob:completionSeen";

export type DashboardRecord = {
  agents: DashboardAgentCard[];
  runtimeAgentStatuses: RuntimeAgentStatuses;
  completionSeen: SeenCompletions;
  lastHerdSig: string;
  refreshBusy: boolean;
};

function loadCompletionSeen(): SeenCompletions {
  try {
    return parseSeenCompletions(localStorage.getItem(completionSeenKey()));
  } catch {
    return {};
  }
}

const dashboardDomain = createDomain<DashboardRecord>("dashboard", {
  agents: [],
  runtimeAgentStatuses: {},
  completionSeen: {},
  lastHerdSig: "",
  refreshBusy: false,
});
export const dashboardStore = dashboardDomain.store;
const { read, write, writeIf } = dashboardDomain.controller;


/** Per daemon and device: a completion acknowledged on one phone stays noted there. */
function completionSeenKey(): string {
  return `${COMPLETION_SEEN_KEY}:${currentDaemonId() || "anon"}:${currentDeviceId() || "anon"}`;
}

export function saveCompletionSeen(): void {
  try {
    localStorage.setItem(completionSeenKey(), JSON.stringify(read().completionSeen));
  } catch {
    /* storage blocked; completion attention remains correct for this page */
  }
}

export { loadCompletionSeen };

export function setRefreshBusy(busy: boolean): void {
  if (read().refreshBusy === busy) return;
  write((record) => {
    record.refreshBusy = busy;
  });
}

/**
 * The card of the open pane, detached: a caller gets a view it can hold and read,
 * never the domain's own card to edit behind its back.
 */
export function selectedAgent(): DashboardAgentCard | undefined {
  const paneId = openPaneId();
  const card = read().agents.find((agent) => agent.paneId === paneId);
  return card ? detach({ ...card }) : undefined;
}

/**
 * Detached live cards. Action-time: a write is visible here immediately, not
 * only on the published snapshot. The caller cannot edit canonical identity.
 */
export function liveAgents(): readonly DashboardAgentCard[] {
  return detach(read().agents);
}

/**
 * Fold a daemon snapshot into the herd list: cards, runtime statuses, completion
 * attention, the board catalog, and pruning of per-pane choices for panes that
 * are gone. Returns the previous cards so a caller can diff attention.
 */
export function replaceAgentsFromSnapshot(snapshot: SnapshotWire): DashboardAgentCard[] {
  const projected = projectCompletionAttention(
    mapSnapshotAgents(snapshot),
    read().runtimeAgentStatuses,
    read().completionSeen,
  );
  const seenChanged = projected.seen !== read().completionSeen;
  // The cards being replaced are read inside the owner mutation, so the caller
  // gets the very array the previous paint projected.
  let previous: DashboardAgentCard[] = [];
  batch(() => {
    write((record) => {
      // Detached: the caller diffs the previous cards, it does not inherit them.
      previous = detach(record.agents);
      record.agents = projected.agents;
      record.runtimeAgentStatuses = projected.runtimeStatuses;
      record.completionSeen = projected.seen;
      record.lastHerdSig = herdSignature(projected.agents);
    });
    projectSnapshot(snapshot, projected.agents);
    const paneIds = projected.agents.map((agent) => agent.paneId);
    prunePanePreferences(paneIds);
    prunePanePins(paneIds);
    // Persistence stays inside the batch: the storage key is derived from the
    // connected computer, and no subscriber may run before it is written.
    if (seenChanged) saveCompletionSeen();
  });
  return previous;
}

export type AppliedSnapshot = {
  previous: DashboardAgentCard[];
  unchanged: boolean;
};

/**
 * Fold a daemon snapshot and refresh the herd signature the observation
 * controller uses to skip a no-op paint. `replaceAgentsFromSnapshot` is the
 * same write; this names the comparison the caller needs.
 */
export function applySnapshot(snapshot: SnapshotWire): AppliedSnapshot {
  const previousSig = read().lastHerdSig;
  const previous = replaceAgentsFromSnapshot(snapshot);
  return { previous, unchanged: read().lastHerdSig === previousSig };
}

export function reloadCompletionSeen(): void {
  write((record) => {
    record.completionSeen = loadCompletionSeen();
  });
}

/** A successful terminal read is the mobile equivalent of viewing the result. */
export function acknowledgePaneCompletion(paneId: string): boolean {
  const seen = markCompletionSeen(
    read().completionSeen,
    read().runtimeAgentStatuses,
    paneId,
  );
  if (seen === read().completionSeen) return false;
  noteCompletionAcknowledged(paneId);
  batch(() => {
    write((record) => {
      record.completionSeen = seen;
      record.agents = applySeenCompletions(record.agents, seen);
      record.lastHerdSig = herdSignature(record.agents);
    });
    saveCompletionSeen();
  });
  return true;
}

/** The reader submitted to this pane: its pending turn is no longer new output. */
export function markPaneSubmitted(paneId: string): void {
  // Decided and persisted inside the owner mutation: a projection that changes
  // nothing publishes nothing, and storage is written before any subscriber runs.
  writeIf((record) => {
    const projected = projectAgentSubmission(
      record.agents,
      record.runtimeAgentStatuses,
      record.completionSeen,
      paneId,
    );
    if (projected.agents === record.agents) return false;
    const seenChanged = projected.seen !== record.completionSeen;
    record.agents = projected.agents;
    record.runtimeAgentStatuses = projected.runtimeStatuses;
    record.completionSeen = projected.seen;
    record.lastHerdSig = herdSignature(record.agents);
    if (seenChanged) saveCompletionSeen();
    return true;
  });
}

/** Drop herd data when the daemon session goes away. */
export function resetDashboard(): void {
  write((record) => {
    record.agents = [];
    record.runtimeAgentStatuses = {};
    record.completionSeen = {};
    record.lastHerdSig = "";
    record.refreshBusy = false;
  });
}

/**
 * One-shot opaque checkpoint of the dashboard projection fields a snapshot
 * fold writes back. The caller captures immediately before its own snapshot
 * seed and invokes the closure once, after its assertions, to restore exactly
 * the captured detached values; subscriber registration/identity is untouched
 * (restore goes through the owner write). It never exposes the record, accepts
 * no arbitrary state and is one-call only.
 */
export function captureDashboardProjection(): () => void {
  const captured = {
    agents: detach(read().agents),
    runtimeAgentStatuses: detach(read().runtimeAgentStatuses),
    completionSeen: detach(read().completionSeen),
    lastHerdSig: read().lastHerdSig,
    refreshBusy: read().refreshBusy,
  };
  let used = false;
  return () => {
    if (used) return;
    used = true;
    write((record) => {
      // Owned mutable snapshot: detach yields a fresh deep plain copy, and the
      // spread re-derives the exact mutable element type so the restored value
      // can be handed back to the record without erasing readonly or weakening
      // DashboardRecord. The copy stays detached plain data.
      record.agents = detach(captured.agents.map((a) => ({ ...a })));
      record.runtimeAgentStatuses = detach(captured.runtimeAgentStatuses);
      record.completionSeen = detach(captured.completionSeen);
      record.lastHerdSig = captured.lastHerdSig;
      record.refreshBusy = captured.refreshBusy;
    });
  };
}
