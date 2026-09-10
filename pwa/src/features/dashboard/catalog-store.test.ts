import { afterEach, describe, expect, test } from "bun:test";
import "../../../test-support/boot-dom";
import type { SnapshotWire } from "../../lib/dashboard";

const { acknowledgePaneCompletion, applySnapshot, dashboardStore, liveAgents, markPaneSubmitted, replaceAgentsFromSnapshot, resetDashboard,
  selectedAgent, setRefreshBusy } = await import("./catalog-store");
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

  test("a manual refresh flag belongs to the herd list, and a reset fails closed", () => {
    setRefreshBusy(true);
    expect(dashboardStore.get().refreshBusy).toBeTrue();
    setRefreshBusy(true);
    expect(dashboardStore.get().refreshBusy).toBeTrue();

    resetDashboard();
    expect(dashboardStore.get()).toEqual({
      agents: [], runtimeAgentStatuses: {}, completionSeen: {}, lastHerdSig: "", refreshBusy: false,
    });
    // The board catalog is another domain's data: resetting the herd list keeps it.
    expect(boardStore.get().workspaceList.map((space) => space.id)).toEqual(["w1"]);
    resetBoardCatalog();
    expect(boardStore.get().workspaceList).toEqual([]);
    expect(boardStore.get().boardTabId).toBe("");
  });
});
