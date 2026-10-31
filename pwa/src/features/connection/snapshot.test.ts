import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import "../../../test-support/boot-dom";
import type { LiveSession } from "../../lib/protocol/session-types";
import type { PairResult } from "../../lib/protocol/client";
import { attachLiveSession, liveSession, setCredential } from "../computers/catalog-store";
import { setScreen } from "../../app/navigation-store";
import { noteRelayRtt, setSessionTransport } from "./connection-store";
import { applySnapshot, dashboardStore, refreshBusy, resetDashboard, setRefreshBusy, subscribeRefreshBusy } from "../dashboard/catalog-store";
import { boardStore, resetBoardCatalog } from "../board/layout-store";
import { adoptDaemonPreferences, preferencesStore } from "../settings/preferences-store";
import { batch } from "../../shared/model/domain-store";
import {
  queueSnapshot,
  resetObservationLifecycle,
  selectPane,
  setAgentChat,
  sessionStore,
  snapshotIsPending,
  takeQueuedSnapshot,
} from "../session/session-store";
import { bumpLiveView, liveView } from "./generations";
import { refreshSnapshot, type SnapshotPorts } from "./snapshot";
import { applyTrace, chatSnapshot } from "../session/chat/trace-store";
import { refreshAgentTrace } from "../session/chat/agent-chat-controller";
import { loadToolDetail, toolDetailView } from "../session/chat/agent-chat-detail";
import { cacheAgentTrace, cachedAgentTrace } from "../../lib/agent-trace-cache";
import { composeDraft, setComposeDraft } from "../session/compose-store";

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
  resetBoardCatalog();
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
    stops.push(subscribeRefreshBusy(() => {
      if (replaced || !refreshBusy()) return;
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
    expect(refreshBusy()).toBe(false);
    calls = [];
    await refreshSnapshot(snapshotPorts);
    expect(reads).toBe(2);
    expect(calls).toEqual([]);
  });

  test("an unchanged poll on a desk pane patches chrome without re-preparing the composition", async () => {
    setScreen("pane");
    selectPane("old-A");
    const desk: SnapshotPorts = { ...snapshotPorts, isDesk: () => true };
    await refreshSnapshot(desk);
    expect(dashboardStore.get().agents.map((agent) => agent.paneId)).toEqual(["old-A"]);
    expect(calls).toEqual(["chrome", "commitView"]);
    calls = [];
    let boardPublishes = 0;
    stops.push(boardStore.subscribe(() => { boardPublishes += 1; }));
    await refreshSnapshot(desk);
    expect(reads).toBe(2);
    expect(calls).toEqual(["chrome"]);
    // The board is projected on every poll and this one says what it already says.
    expect(boardPublishes).toBe(0);
    // A herd that moved still re-prepares the composition.
    (session as unknown as { snapshot: () => Promise<unknown> }).snapshot = async () => ({
      panes: [
        { pane_id: "old-A", workspace_id: "w", tab_id: "t", agent: "codex", agent_status: "idle" },
        { pane_id: "extra-B", workspace_id: "w", tab_id: "t", agent: "codex", agent_status: "idle" },
      ],
    });
    calls = [];
    await refreshSnapshot(desk);
    expect(calls).toEqual(["chrome", "commitView"]);
  });

  test("production snapshot invalidates active and background occupant caches without losing the draft", async () => {
    const observed = (a: string, b: string) => ({
      session: "named",
      panes: [
        { pane_id: "p1", workspace_id: "w", agent: "codex", agent_status: "idle", agent_instance_id: a },
        { pane_id: "p2", workspace_id: "w", agent: "codex", agent_status: "idle", agent_instance_id: b },
      ],
    });
    applySnapshot(observed("a1", "b1"));
    selectPane("p1");
    setAgentChat(true);
    setComposeDraft("keep this draft");
    applyTrace({ agentTraceItems: [{ type: "assistant", text: "old" }], agentTraceLoadState: "ready" });
    const cached = { items: [{ type: "assistant" as const, text: "cached" }], nextCursor: null, note: "", truncated: false, signature: "cached", tail: 1 };
    cacheAgentTrace("p1", cached);
    cacheAgentTrace("p2", cached);
    let finishTrace!: (page: { items: Array<{ type: "assistant"; text: string }>; nextCursor: null; truncated: false }) => void;
    const finishDetails: Array<(detail: { title: string; body: string }) => void> = [];
    session.agentTrace = () => new Promise((resolve) => { finishTrace = resolve; });
    session.agentTraceDetail = () => new Promise((resolve) => { finishDetails.push(resolve); });
    session.snapshot = async () => observed("a2", "b2");
    void refreshAgentTrace();
    loadToolDetail("p2", "detail", () => undefined);
    await Promise.resolve();

    await refreshSnapshot(snapshotPorts);
    expect(cachedAgentTrace("p1")).toBeNull();
    expect(cachedAgentTrace("p2")).toBeNull();
    expect(chatSnapshot().agentTraceItems).toEqual([]);
    expect(composeDraft()).toBe("keep this draft");
    loadToolDetail("p2", "detail", () => undefined);
    expect(toolDetailView("p2", "detail").status).toBe("loading");
    finishTrace({ items: [{ type: "assistant", text: "stale" }], nextCursor: null, truncated: false });
    finishDetails[0]({ title: "stale", body: "stale" });
    await Promise.resolve();
    await Promise.resolve();
    expect(chatSnapshot().agentTraceItems).toEqual([]);
    expect(toolDetailView("p2", "detail").status).toBe("loading");
    finishDetails[1]({ title: "fresh", body: "fresh" });
    await Promise.resolve();
    expect(toolDetailView("p2", "detail")).toMatchObject({ status: "ready", detail: { title: "fresh" } });
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
