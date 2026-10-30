import { herdSignature, mapSnapshotAgents, type DashboardAgentCard, type SnapshotWire } from "../../lib/dashboard";
import {
  applySeenCompletions,
  forgetCompletionsSeen,
  markAllCompletionsSeen,
  markCompletionSeen,
  parseSeenCompletions,
  projectAgentSubmission,
  projectCompletionAttention,
  restoreUnseenCompletions,
  type RuntimeAgentStatuses,
  type SeenCompletions,
} from "../../lib/completion-attention";
import { noteCompletionAcknowledged } from "../../lib/herd-attention";
import { batch, createDomain, detach } from "../../shared/model/domain-store";
import { projectSnapshot } from "../board/layout-store";
import { currentDaemonId, currentDeviceId, currentHerdSession } from "../computers/catalog-store";
import { herdSessionScope } from "../../lib/protocol/herd-sessions";
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
  /**
   * A snapshot has been read for this session. Until then an empty `agents`
   * means "not read yet" (the list shows placeholder rows), not "no sessions".
   */
  snapshotLoaded: boolean;
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
  snapshotLoaded: false,
});
export const dashboardStore = dashboardDomain.store;
const { read, write, writeIf } = dashboardDomain.controller;


/** Per daemon, Herdr session and device; the default retains its original key. */
function completionSeenKey(): string {
  return `${COMPLETION_SEEN_KEY}:${herdSessionScope(currentDaemonId() || "anon", currentHerdSession())}:${currentDeviceId() || "anon"}`;
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
 * What a screen that draws the rows renders from this domain, as a scalar:
 * which rows, not which record carries them. The domain publishes for the
 * refresh flag and for a snapshot that reported the same list; neither changes
 * a row, and `lastHerdSig` is the list's own signature, written with every
 * write that does.
 */
export function herdAgentsKey(snapshot: object): string {
  const record = snapshot as { snapshotLoaded: boolean; lastHerdSig: string };
  return `${record.snapshotLoaded ? 1 : 0}\u0000${record.lastHerdSig}`;
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

/** The same statuses keyed by pane, as a value: a fold reporting them again changes nothing. */
function sameStatuses(left: RuntimeAgentStatuses, right: RuntimeAgentStatuses): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

/**
 * Fold a daemon snapshot into the herd list: cards, runtime statuses, completion
 * attention, the board catalog, and pruning of per-pane choices for panes that
 * are gone. Returns the previous cards so a caller can diff attention.
 *
 * A snapshot that reports the list already shown — the ordinary poll — writes
 * nothing: publishing it would re-render every row's view for no visible
 * change. `previous` is still the cards the last paint projected, so callers
 * diffing attention find nothing to mark.
 */
export function replaceAgentsFromSnapshot(snapshot: SnapshotWire): DashboardAgentCard[] {
  const projected = projectCompletionAttention(
    mapSnapshotAgents(snapshot),
    read().runtimeAgentStatuses,
    read().completionSeen,
  );
  const seenChanged = projected.seen !== read().completionSeen;
  const signature = herdSignature(projected.agents);
  // The cards being replaced are read inside the owner mutation, so the caller
  // gets the very array the previous paint projected.
  let previous: DashboardAgentCard[] = [];
  batch(() => {
    writeIf((record) => {
      // Detached: the caller diffs the previous cards, it does not inherit them.
      previous = detach(record.agents);
      if (record.snapshotLoaded && !seenChanged && record.lastHerdSig === signature
        && sameStatuses(record.runtimeAgentStatuses, projected.runtimeStatuses)) return false;
      record.agents = projected.agents;
      record.runtimeAgentStatuses = projected.runtimeStatuses;
      record.completionSeen = projected.seen;
      record.lastHerdSig = signature;
      record.snapshotLoaded = true;
      return true;
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
    read().agents,
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

/**
 * Mark every unread completion read at once. Returns what an undo needs (the
 * acknowledgements this call added), or null when nothing was unread.
 */
export function acknowledgeAllCompletions(): { count: number; added: SeenCompletions } | null {
  const { seen, added } = markAllCompletionsSeen(read().completionSeen, read().runtimeAgentStatuses, read().agents);
  const paneIds = Object.keys(added);
  if (!paneIds.length) return null;
  for (const paneId of paneIds) noteCompletionAcknowledged(paneId);
  batch(() => {
    write((record) => {
      record.completionSeen = seen;
      record.agents = applySeenCompletions(record.agents, seen);
      record.lastHerdSig = herdSignature(record.agents);
    });
    saveCompletionSeen();
  });
  return { count: paneIds.length, added };
}

/** Undo `acknowledgeAllCompletions`; a completion read again since stays read. */
export function restoreCompletions(added: SeenCompletions): void {
  writeIf((record) => {
    const seen = forgetCompletionsSeen(record.completionSeen, added);
    if (seen === record.completionSeen) return false;
    record.completionSeen = seen;
    record.agents = restoreUnseenCompletions(record.agents, record.runtimeAgentStatuses, seen);
    record.lastHerdSig = herdSignature(record.agents);
    saveCompletionSeen();
    return true;
  });
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
    record.snapshotLoaded = false;
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
    snapshotLoaded: read().snapshotLoaded,
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
      record.snapshotLoaded = captured.snapshotLoaded;
    });
  };
}

/** The fields a snapshot fold writes that decide which rows the list paints. */
export type DashboardProjection = Pick<DashboardRecord, "agents" | "runtimeAgentStatuses" | "lastHerdSig" | "snapshotLoaded">;

/** Detached copy of the painted projection, for a page-local kept view. */
export function dashboardProjection(): DashboardProjection {
  return {
    // The spread re-derives the mutable element type the record holds; the
    // published view's own cards are readonly.
    agents: detach(read().agents.map((agent) => ({ ...agent }))),
    runtimeAgentStatuses: detach(read().runtimeAgentStatuses),
    lastHerdSig: read().lastHerdSig,
    snapshotLoaded: read().snapshotLoaded,
  };
}

/** Adopt a kept projection. completionSeen / refreshBusy are never adopted. */
export function adoptDashboardProjection(projection: DashboardProjection): void {
  write((record) => {
    record.agents = detach(projection.agents);
    record.runtimeAgentStatuses = detach(projection.runtimeAgentStatuses);
    record.lastHerdSig = projection.lastHerdSig;
    record.snapshotLoaded = projection.snapshotLoaded;
  });
}
