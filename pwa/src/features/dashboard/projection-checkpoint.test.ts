import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestDOM } from "../../../test-support/boot-dom";
import { attachLiveSession, liveSession } from "../computers/catalog-store";
import { captureDashboardProjection, dashboardStore, replaceAgentsFromSnapshot, resetDashboard } from "./catalog-store";
import { WorkspaceSnapshotRestorer } from "../../../test-support/workspace-snapshot-restore";

const seedRestorer = new WorkspaceSnapshotRestorer();
let previousLive: ReturnType<typeof liveSession>;
await resetTestDOM();

const seedP1 = {
  focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "p1" },
  workspaces: [{ workspace_id: "w1", label: "w1" }],
  tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
  panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/work/p1", agent: "codex", agent_status: "idle" }],
};
const seedForeign = {
  focused: { workspace_id: "w9", tab_id: "w9:t9", pane_id: "foreign:p9" },
  workspaces: [{ workspace_id: "w9", label: "w9" }],
  tabs: [{ tab_id: "w9:t9", workspace_id: "w9", label: "main" }],
  panes: [{ pane_id: "foreign:p9", workspace_id: "w9", tab_id: "w9:t9", cwd: "/work/p9", agent: "codex", agent_status: "working" }],
};

beforeEach(() => {
  // Capture the whole external projection/prefs/raw preimage BEFORE the own
  // reset, so a foreign completionSeen/refresh/pin/pref installed by a control
  // survives this fixture's own replaceAgentsFromSnapshot lifecycle.
  previousLive = liveSession();
  seedRestorer.capture();
  attachLiveSession({ isConnected: () => true } as never);
  resetDashboard();
});
afterEach(() => {
  resetDashboard();
  attachLiveSession(previousLive);
  seedRestorer.restore();
});

describe("captureDashboardProjection restores the snapshot-affected fields", () => {
  test("rolls a real snapshot seed back to its pre-seed projection", () => {
    replaceAgentsFromSnapshot(seedP1);
    const restore = captureDashboardProjection();
    replaceAgentsFromSnapshot(seedForeign);
    expect(dashboardStore.get().agents.map((a) => a.paneId)).toEqual(["foreign:p9"]);
    restore();
    expect(dashboardStore.get().agents.map((a) => a.paneId)).toEqual(["p1"]);
    expect(dashboardStore.get().runtimeAgentStatuses["p1"]).toBeTruthy();
  });

  test("restores the exact pre-seed empty cards baseline", () => {
    const restore = captureDashboardProjection();
    replaceAgentsFromSnapshot(seedP1);
    expect(dashboardStore.get().agents.some((a) => a.paneId === "p1")).toBeTrue();
    restore();
    expect(dashboardStore.get().agents).toEqual([]);
    expect(dashboardStore.get().runtimeAgentStatuses).toEqual({});
  });

  test("preserves foreign runtime statuses after its own seed rolls back", () => {
    replaceAgentsFromSnapshot(seedForeign);
    const restore = captureDashboardProjection();
    replaceAgentsFromSnapshot(seedP1);
    expect(dashboardStore.get().agents.map((a) => a.paneId)).toEqual(["p1"]);
    restore();
    expect(dashboardStore.get().agents.map((a) => a.paneId)).toEqual(["foreign:p9"]);
    expect(dashboardStore.get().agents[0]?.status).toBe("working");
    expect(dashboardStore.get().runtimeAgentStatuses["foreign:p9"]).toBeTruthy();
  });

  test("is one-shot and subscribers stay attached", () => {
    const restore = captureDashboardProjection();
    let notices = 0;
    const stop = dashboardStore.subscribe(() => { notices += 1; });
    try {
      replaceAgentsFromSnapshot(seedP1);
      const before = notices;
      restore();
      expect(dashboardStore.get().agents).toEqual([]);
      expect(notices).toBeGreaterThan(before);
      const after = notices;
      restore();
      expect(notices).toBe(after);
    } finally {
      stop();
    }
  });
});
