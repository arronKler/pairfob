import { afterEach, describe, expect, test } from "bun:test";
import "../../../test-support/boot-dom";
import type { SnapshotWire } from "../../lib/dashboard";

const { acknowledgeAllCompletions, acknowledgePaneCompletion, applySnapshot, dashboardStore, liveAgents, markPaneSubmitted, replaceAgentsFromSnapshot, resetDashboard,
  reloadCompletionSeen, loadCompletionSeen, restoreCompletions, selectedAgent, setRefreshBusy } = await import("./catalog-store");
const { boardStore, resetBoardCatalog } = await import("../board/layout-store");
const { preferencesStore, setPaneTermMode } = await import("../settings/preferences-store");
const { selectPane, sessionStore, openPaneId } = await import("../session/session-store");
const { credential, setCredential } = await import("../computers/catalog-store");
const { adoptDaemonPreferences } = await import("../settings/preferences-store");

function snapshot(panes: string[]): SnapshotWire {
  return {
    focused: { pane_id: panes[0], workspace_id: "w1", tab_id: "t1" },
    workspaces: [{ workspace_id: "w1", label: "alpha", cwd: "/tmp/a" }],
    tabs: [{ tab_id: "t1", workspace_id: "w1", label: "main" }],
    panes: panes.map((paneId, index) => ({
      pane_id: paneId,
      workspace_id: "w1",
      tab_id: "t1",
      cwd: "/tmp/a",
      agent: index === 0 ? "claude" : undefined,
      agent_status: index === 0 ? "working" : undefined,
      label: `pane ${paneId}`,
    })),
  };
}

const restore = { paneId: openPaneId(), credential: credential() };

/** A daemon of this test's own, so no other suite's per-pane choices are in scope. */
function useTestDaemon(): void {
  setCredential({ daemonId: "d_dashboardtest00000", deviceId: "dev_test" } as never);
  adoptDaemonPreferences();
}

afterEach(() => {
  resetDashboard();
  selectPane(restore.paneId);
  setCredential(restore.credential);
  adoptDaemonPreferences();
});

describe("dashboard domain", () => {
  test("a snapshot projects cards, the board catalog and prunes dead pane choices", () => {
    resetDashboard();
    useTestDaemon();
    setPaneTermMode("gone", "full");
    setPaneTermMode("p1", "agent");
    const counts = { dashboard: 0, board: 0, preferences: 0 };
    const releases = [
      dashboardStore.subscribe(() => { counts.dashboard += 1; }),
      boardStore.subscribe(() => { counts.board += 1; }),
      preferencesStore.subscribe(() => { counts.preferences += 1; }),
    ];

    const previous = replaceAgentsFromSnapshot(snapshot(["p1", "p2"]));
    expect(previous).toEqual([]);

    const cards = dashboardStore.get().agents;
    expect(cards.map((card) => card.paneId)).toEqual(["p1", "p2"]);
    expect(cards[0]?.hasAgent).toBeTrue();
    expect(cards[0]?.status).toBe("working");
    expect(cards[1]?.hasAgent).toBeFalse();
    expect(boardStore.get().workspaceList.map((space) => space.id)).toEqual(["w1"]);
    expect(boardStore.get().tabList.map((tab) => tab.id)).toEqual(["t1"]);
    expect(boardStore.get().boardTabId).toBe("t1");
    expect(preferencesStore.get().paneTermModes).toEqual({ p1: "agent" });

    // One snapshot is one publish per domain it touched, not one per field.
    expect(counts).toEqual({ dashboard: 1, board: 1, preferences: 1 });
    for (const release of releases) release();

    const second = replaceAgentsFromSnapshot(snapshot(["p1"]));
    expect(second.map((card) => card.paneId)).toEqual(["p1", "p2"]);
    expect(dashboardStore.get().agents.map((card) => card.paneId)).toEqual(["p1"]);
  });

  test("new liveAgents read cannot change canonical card identity without an action", () => {
    replaceAgentsFromSnapshot({
      workspaces: [{ workspace_id: "w1", label: "H" }],
      tabs: [{ tab_id: "t1", workspace_id: "w1", label: "one" }],
      panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "t1", label: "first" }],
    });
    const agents = liveAgents();
    expect(agents.length).toBe(1);
    let notifications = 0;
    const stop = dashboardStore.subscribe(() => { notifications += 1; });
    try {
      agents[0]!.paneId = "external";
      expect(dashboardStore.get().agents[0]!.paneId).toBe("p1");
      expect(notifications).toBe(0);
      expect(liveAgents()[0]!.paneId).toBe("p1");
    } finally {
      stop();
      replaceAgentsFromSnapshot({ workspaces: [], tabs: [], panes: [] });
    }
  });

  test("applySnapshot owns lastHerdSig so a repeat snapshot is unchanged", () => {
    resetDashboard();
    const first = applySnapshot(snapshot(["p1", "p2"]));
    expect(first.unchanged).toBe(false);
    expect(dashboardStore.get().lastHerdSig).not.toBe("");
    const second = applySnapshot(snapshot(["p1", "p2"]));
    expect(second.unchanged).toBe(true);
    expect(second.previous.map((card) => card.paneId)).toEqual(["p1", "p2"]);
    const third = applySnapshot(snapshot(["p1"]));
    expect(third.unchanged).toBe(false);
  });

  test("a poll that reports the list already shown publishes nothing", () => {
    resetDashboard();
    applySnapshot(snapshot(["p1", "p2"]));
    let publishes = 0;
    const stop = dashboardStore.subscribe(() => { publishes += 1; });
    try {
      const repeat = applySnapshot(snapshot(["p1", "p2"]));
      expect(repeat.unchanged).toBe(true);
      expect(publishes).toBe(0);
      // The cards the last paint projected are still what a caller diffs against.
      expect(repeat.previous.map((card) => card.paneId)).toEqual(["p1", "p2"]);
      // A real change still publishes, whatever the refresh flag does.
      applySnapshot(snapshot(["p1", "p2", "p3"]));
      expect(publishes).toBe(1);
    } finally {
      stop();
    }
  });

  test("the selected agent follows the open pane", () => {
    replaceAgentsFromSnapshot(snapshot(["p1", "p2"]));
    selectPane("p2");
    expect(selectedAgent()?.paneId).toBe("p2");
    expect(sessionStore.get().paneId).toBe("p2");
    selectPane("missing");
    expect(selectedAgent()).toBeUndefined();
  });

  test("completion acknowledgement only publishes when something became seen", () => {
    replaceAgentsFromSnapshot(snapshot(["p1"]));
    let publishes = 0;
    const release = dashboardStore.subscribe(() => { publishes += 1; });

    expect(acknowledgePaneCompletion("p1")).toBeFalse();
    expect(publishes).toBe(0);

    // A pane that is not on the list has nothing to acknowledge or to submit.
    expect(acknowledgePaneCompletion("missing")).toBeFalse();
    const cards = dashboardStore.get().agents;
    markPaneSubmitted("missing");
    expect(dashboardStore.get().agents).toEqual(cards);
    expect(publishes).toBe(0);
    release();
  });

  test("mark all read acknowledges every unread completion and its undo brings them back", () => {
    useTestDaemon();
    const finished: SnapshotWire = {
      workspaces: [{ workspace_id: "w1", label: "alpha" }],
      tabs: [{ tab_id: "t1", workspace_id: "w1", label: "main" }],
      panes: ["p1", "p2", "p3"].map((paneId, index) => ({
        pane_id: paneId, workspace_id: "w1", tab_id: "t1", cwd: "/tmp/a", agent: "claude",
        agent_status: index === 2 ? "blocked" : "done", label: paneId,
      })),
    };
    replaceAgentsFromSnapshot(finished);
    expect(acknowledgePaneCompletion("p2")).toBeTrue();
    const status = () => dashboardStore.get().agents.map((card) => card.status);
    expect(status()).toEqual(["done", "idle", "blocked"]);

    let publishes = 0;
    const release = dashboardStore.subscribe(() => { publishes += 1; });
    const receipt = acknowledgeAllCompletions();
    expect(receipt?.count).toBe(1);
    expect(status()).toEqual(["idle", "idle", "blocked"]);
    expect(publishes).toBe(1);
    expect(acknowledgeAllCompletions()).toBeNull();
    // Acknowledgements survive the next snapshot of the same completions.
    replaceAgentsFromSnapshot(finished);
    expect(status()).toEqual(["idle", "idle", "blocked"]);

    restoreCompletions(receipt!.added);
    // Only the bulk read is undone: the pane read on its own stays read.
    expect(status()).toEqual(["done", "idle", "blocked"]);
    expect(dashboardStore.get().completionSeen).toEqual({ p2: true });
    const count = publishes;
    restoreCompletions(receipt!.added);
    expect(publishes).toBe(count);
    release();
  });

  test("a manual refresh flag belongs to the herd list, and a reset fails closed", () => {
    setRefreshBusy(true);
    expect(dashboardStore.get().refreshBusy).toBeTrue();
    setRefreshBusy(true);
    expect(dashboardStore.get().refreshBusy).toBeTrue();

    resetDashboard();
    expect(dashboardStore.get()).toEqual({
      agents: [], runtimeAgentStatuses: {}, completionSeen: {}, lastHerdSig: "", refreshBusy: false, snapshotLoaded: false,
    });
    // The board catalog is another domain's data: resetting the herd list keeps it.
    expect(boardStore.get().workspaceList.map((space) => space.id)).toEqual(["w1"]);
    resetBoardCatalog();
    expect(boardStore.get().workspaceList).toEqual([]);
    expect(boardStore.get().boardTabId).toBe("");
  });

  test("read completions survive unknown recovery snapshots and a subsequent reconnect", () => {
    useTestDaemon();
    const finished: SnapshotWire = {
      panes: ["p1", "p2", "p3"].map(paneId => ({
        pane_id: paneId, workspace_id: "w1", agent: "codex", agent_status: "done",
        terminal_id: `terminal-${paneId}`, agent_instance_id: `instance-${paneId}`, state_change_seq: 7,
      })),
    };
    replaceAgentsFromSnapshot(finished);
    acknowledgeAllCompletions();
    const seen = loadCompletionSeen();
    expect(Object.keys(seen)).toHaveLength(3);

    resetDashboard();
    reloadCompletionSeen();
    replaceAgentsFromSnapshot({ ...finished, panes: finished.panes!.map(pane => ({ ...pane, agent_status: "unknown" })) });
    expect(dashboardStore.get().agents.map(a => a.status)).toEqual(["unknown", "unknown", "unknown"]);
    expect(loadCompletionSeen()).toEqual(seen);
    // A second reconnect must also reload the original receipts from storage.
    resetDashboard();
    reloadCompletionSeen();
    replaceAgentsFromSnapshot(finished);
    expect(dashboardStore.get().agents.map(a => a.status)).toEqual(["idle", "idle", "idle"]);
    replaceAgentsFromSnapshot({ ...finished, panes: finished.panes!.map((pane, i) => ({ ...pane, state_change_seq: i === 1 ? 8 : 7 })) });
    expect(dashboardStore.get().agents.map(a => a.status)).toEqual(["idle", "done", "idle"]);
    replaceAgentsFromSnapshot({ panes: [] });
    expect(loadCompletionSeen()).toEqual({});
  });

  test("bulk read receipts survive persisted runtime churn; only fresh task evidence rearms", () => {
    useTestDaemon();
    const finished: SnapshotWire = {
      panes: ["p1", "p2", "p3"].map((paneId, index) => ({
        pane_id: paneId, workspace_id: "w1", agent: "codex", agent_status: "done",
        terminal_id: `terminal-${paneId}`, agent_instance_id: `instance-${paneId}`, state_change_seq: 7,
        completion_id: String(index + 1).repeat(64),
      })),
    };
    replaceAgentsFromSnapshot(finished);
    expect(acknowledgeAllCompletions()?.count).toBe(3);
    const seen = loadCompletionSeen();
    for (const status of ["idle", "working", "unknown", "done"]) {
      replaceAgentsFromSnapshot({ panes: finished.panes!.map(p => ({ ...p, agent_status: status, state_change_seq: 11, completion_id: undefined })) });
      expect(loadCompletionSeen()).toEqual(seen);
    }
    resetDashboard();
    reloadCompletionSeen();
    replaceAgentsFromSnapshot({ panes: finished.panes!.map(p => ({ ...p, state_change_seq: 12 })) });
    expect(dashboardStore.get().agents.map(a => a.status)).toEqual(["idle", "idle", "idle"]);
    replaceAgentsFromSnapshot({ panes: finished.panes!.map((p, index) => ({ ...p, state_change_seq: 12, completion_id: index === 1 ? "f".repeat(64) : p.completion_id })) });
    expect(dashboardStore.get().agents.map(a => a.status)).toEqual(["idle", "done", "idle"]);
    expect(loadCompletionSeen()).toEqual({ p1: seen.p1, p3: seen.p3 });
  });
});
