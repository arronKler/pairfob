import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import "../../../test-support/boot-dom";
import type { LiveSession } from "../../lib/protocol/session-types";
import type { PairResult } from "../../lib/protocol/client";
import { attachLiveSession, liveSession, setCredential } from "../computers/catalog-store";
import { setScreen } from "../../app/navigation-store";
import { noteRelayRtt, setSessionTransport } from "./connection-store";
import { applySnapshot, dashboardStore, resetDashboard, setRefreshBusy } from "../dashboard/catalog-store";
import { adoptDaemonPreferences, preferencesStore } from "../settings/preferences-store";
import { batch } from "../../shared/model/domain-store";
import {
  queueSnapshot,
  resetObservationLifecycle,
  selectPane,
  sessionStore,
  snapshotIsPending,
  takeQueuedSnapshot,
} from "../session/session-store";
import { bumpLiveView, liveView } from "./generations";
import { refreshSnapshot, type SnapshotPorts } from "./snapshot";

const snap = (id: string) => ({
  panes: [{ pane_id: id, workspace_id: "w", tab_id: "t", agent: "codex", agent_status: "idle" }],
});

const pair: PairResult = { daemonId: "A", deviceId: "dev", fp: "f" } as unknown as PairResult;

let stops: Array<() => void> = [];
let reads = 0;
let calls: string[] = [];
let session: LiveSession;

const snapshotPorts: SnapshotPorts = {
  currentLive: liveSession,
  networkOnline: () => true,
  documentVisible: () => true,
  isDesk: () => false,
  openPendingNotification: async () => false,
  openPane: async () => undefined,
  abandonOpenPane: () => calls.push("abandon"),
  syncFullTerminalChrome: () => calls.push("full"),
  patchAgentChat: () => true,
  patchChromeTitle: () => calls.push("chrome"),
  showError: () => calls.push("error"),
  messageOf: String,
  commitView: () => calls.push("commitView"),
  now: () => 12345,
};

beforeEach(() => {
  stops = [];
  reads = 0;
  calls = [];
  resetDashboard();
  resetObservationLifecycle();
  selectPane("");
  setScreen("home");
  session = {
    isConnected: () => true,
    snapshot: async () => {
      reads += 1;
      return snap("old-A");
    },
    onEvent: () => () => undefined,
    close() {},
  } as unknown as LiveSession;
  batch(() => {
    setCredential(pair);
    noteRelayRtt(null);
    setSessionTransport("relay");
  });
  attachLiveSession(session);
});

afterEach(() => {
  for (const stop of stops) stop();
  attachLiveSession(null);
  resetDashboard();
  resetObservationLifecycle();
});

function replaceOwner(): void {
  attachLiveSession({ isConnected: () => true } as unknown as LiveSession);
  bumpLiveView();
  applySnapshot(snap("new-B"));
}

describe("snapshot observation ownership", () => {
  test("an in-flight Snapshot queues a follow-up instead of overlapping", () => {
    setRefreshBusy(true);
    queueSnapshot();
    expect(snapshotIsPending()).toBe(true);
    expect(takeQueuedSnapshot()).toBe(true);
    expect(snapshotIsPending()).toBe(false);
  });

  test("applySnapshot records lastHerdSig so a later identical herd is unchanged", () => {
    const snapshot = {
      workspaces: [{ workspace_id: "w1", label: "alpha" }],
      tabs: [{ tab_id: "t1", workspace_id: "w1", label: "main" }],
      panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "t1", cwd: "/tmp", agent: "codex", agent_status: "idle" }],
    };
    const first = applySnapshot(snapshot);
    expect(first.unchanged).toBe(false);
    expect(dashboardStore.get().lastHerdSig).not.toBe("");
    expect(applySnapshot(snapshot).unchanged).toBe(true);
  });

  test("a live-view bump leaves a stale Snapshot owner behind", () => {
    const started = liveView();
    bumpLiveView();
    expect(liveView()).not.toBe(started);
  });

  test("the timestamp publication cannot let the old response overwrite a replacement owner", async () => {
    let replaced = false;
    stops.push(sessionStore.subscribe(() => {
      if (replaced || sessionStore.get().snapshotAt !== 12345) return;
      replaced = true;
      replaceOwner();
    }));
    await refreshSnapshot(snapshotPorts);
    expect(replaced).toBe(true);
    expect(reads).toBe(1);
    expect(dashboardStore.get().agents.map((agent) => agent.paneId)).toEqual(["new-B"]);
  });

  test("the initial busy publication retiring the owner prevents the old RPC", async () => {
    let replaced = false;
    stops.push(dashboardStore.subscribe(() => {
      if (replaced || !dashboardStore.get().refreshBusy) return;
      replaced = true;
      replaceOwner();
    }));
    await refreshSnapshot(snapshotPorts);
    expect(replaced).toBe(true);
    expect(reads).toBe(0);
  });

  test("an ordinary current Snapshot applies once and a repeat unchanged herd does not paint", async () => {
    await refreshSnapshot(snapshotPorts);
    expect(reads).toBe(1);
    expect(dashboardStore.get().agents.map((agent) => agent.paneId)).toEqual(["old-A"]);
    expect(dashboardStore.get().refreshBusy).toBe(false);
    calls = [];
    await refreshSnapshot(snapshotPorts);
    expect(reads).toBe(2);
    expect(calls).toEqual([]);
  });

  test("a catalog-publication owner retirement cannot persist a false status touch under the replacement daemon", async () => {
    const shared = (status: string) => ({
      panes: [{ pane_id: "shared", workspace_id: "w", tab_id: "t", agent: "codex", agent_status: status }],
    });
    applySnapshot(shared("idle"));
    session.snapshot = async () => {
      reads += 1;
      return shared("working");
    };
    localStorage.setItem("pairfob:paneTouched:B", JSON.stringify({ shared: 777 }));
    let replaced = false;
    stops.push(dashboardStore.subscribe(() => {
      if (replaced || dashboardStore.get().agents[0]?.status !== "working") return;
      replaced = true;
      batch(() => {
        setCredential({ ...pair, daemonId: "B" });
        attachLiveSession({ isConnected: () => true } as unknown as LiveSession);
        bumpLiveView();
        applySnapshot(shared("done"));
        adoptDaemonPreferences();
      });
    }));
    await refreshSnapshot(snapshotPorts);
    expect(replaced).toBe(true);
    expect(reads).toBe(1);
    // The old owner retired during the dashboard publication; its continuation
    // must not fold A's previous status into B's preferences.
    expect(preferencesStore.get().paneTouched.shared).toBe(777);
    expect(JSON.parse(localStorage.getItem("pairfob:paneTouched:B")!)).toEqual({ shared: 777 });
  });
});
