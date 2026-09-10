import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { act } from "react";
import { beginPublicationTransaction, endPublicationTransaction, batch } from "../../shared/model/domain-store";
import { domainStores } from "../../app/domain-publication";
import { registerAppHost, releaseAppHost, appHost, type CommitOptions } from "../../app/host";
import { mountApp, unmountApp, isAppMounted } from "../../app/mount";
import { appRoot } from "../../app/dom-root";
import { registerSessionOwnerPreparer } from "../../app/frame";
import { registerSessionView } from "../session/register";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import { attachLiveSession, setCredential } from "../computers/catalog-store";
import { applyCapabilities } from "../operations/capabilities-store";
import { setNetworkOnline, setPhase, setSessionTransport } from "./connection-store";
import {
  applySnapshot,
  dashboardStore,
} from "../dashboard/catalog-store";
import { setDefaultComposeLive, setPaneComposeLive, setPaneTermMode } from "../settings/preferences-store";
import { setComposeDraft, setComposeFocused, setComposeIME, setComposeLive, composeLive, composeFocused } from "../session/compose-store";
import { setScreen } from "../../app/navigation-store";
import {
  isFullTerminal,
  noteSnapshotAt,
  resetObservationLifecycle,
  resetPaneView,
  selectPane,
  sessionStore,
} from "../session/session-store";
import { resetGenerationsForTests } from "./generations";
import { openPane, refreshPaneRead, stopPolling } from "./controller";

let renders = 0;

/**
 * Publish the staged/dirty domains the real commit pipeline would, so domain
 * `store.get()` stays coherent while the countingHost fixture counts the
 * commitView boundary instead of the retired render loop. `requestCommit`
 * flushes synchronously (a headless composition has no frame to wait for), so a
 * navigation action's staged write is immediately observable like the
 * controlled publication a real App commit would perform.
 */
function flushPublication(): void {
  beginPublicationTransaction();
  try {
    batch(() => {
      for (const store of domainStores) {
        if (store.isDirty() || store.isCompositionPending()) store.publish();
      }
    });
  } finally {
    endPublicationTransaction();
  }
}

const countingHost = {
  commit: () => { renders += 1; flushPublication(); },
  requestCommit: () => flushPublication(),
  unmount: () => undefined,
};

function resetPaneReadFixture(): void {
  attachLiveSession(null);
  setCredential(null);
  setPhase("pick");
  setScreen("home");
  selectPane("");
  resetPaneView();
  resetObservationLifecycle();
  applySnapshot({ panes: [] });
  setComposeLive(false);
  setDefaultComposeLive(false);
  setPaneComposeLive("p1", false);
  setPaneComposeLive("p2", false);
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, []);
  setNetworkOnline(true);
  setSessionTransport("relay");
}

function bootDeskPane(status: "idle" | "done"): void {
  setPhase("live");
  setScreen("pane");
  selectPane("p1");
  setNetworkOnline(true);
  noteSnapshotAt(Date.now());
  setComposeDraft("");
  setComposeFocused(false);
  setComposeIME(false);
  applySnapshot({
    workspaces: [{ workspace_id: "demo", label: "demo" }],
    panes: [{ pane_id: "p1", workspace_id: "demo", tab_id: "t1", cwd: "/tmp/demo", agent: "codex", agent_status: status }],
  });
  attachLiveSession({
    isConnected: () => true,
    paneRead: async () => ({ text: "hello", hash: "a".repeat(64) }),
  });
}

/**
 * The pane-read poll fires every 1.5s while a pane is open. On desk, an
 * unchanged screen used to trigger a full remount whenever the compose field
 * was not focused, which wiped an in-progress terminal text selection and
 * stole focus. The fix gates the repaint: only a fresh completion
 * acknowledgment may repaint, and only when the user is not composing. These
 * cases mount the real App and assert the repaint boundary through the
 * installed host's own `commit`, against real completion evidence
 * (`completionSeen`) and a stable compose-field DOM identity (quiet).
 *
 * Desk mounts focus the compose field (`finishSessionPaint` focuses it on
 * desk), so the default state is "composing": a fresh completion is
 * acknowledged without a repaint (the pane is preserved). Blurring compose
 * (the user tapped the terminal) returns to "not composing", where a fresh
 * completion owes exactly one repaint and then goes quiet.
 */
let commits = 0;
let originalCommit: ((options?: CommitOptions) => void) | null = null;

/**
 * Count `commitView` boundary calls through the installed host's own `commit`.
 * The mount owns one reusable `AppHost` object, so the spy must restore the
 * original `commit` between tests or successive wraps stack and inflate the
 * counter. `originalCommit` is captured once (the real `commitApp` binding)
 * and re-installed in `afterEach` before unmount.
 */
function spyHostCommits(): void {
  const host = appHost();
  if (!host) throw new Error("no installed App host to spy");
  if (!originalCommit) originalCommit = host.commit.bind(host);
  const real = originalCommit;
  host.commit = (options?: CommitOptions) => {
    commits += 1;
    return real(options);
  };
}

function restoreHostCommit(): void {
  if (!originalCommit) return;
  const host = appHost();
  if (host) host.commit = originalCommit;
}

function composeField(): HTMLTextAreaElement | null {
  return appRoot().querySelector('textarea[name="pairfob-compose"], .agent-dock textarea') as HTMLTextAreaElement | null;
}

function flipToDone(): void {
  applySnapshot({
    workspaces: [{ workspace_id: "demo", label: "demo" }],
    panes: [{ pane_id: "p1", workspace_id: "demo", tab_id: "t1", cwd: "/tmp/demo", agent: "codex", agent_status: "done" }],
  });
}

describe("desk pane reads repaint the installed App once", () => {
  beforeEach(async () => {
    await resetBoardTestDOM();
    happy.happyDOM.setWindowSize({ width: 1280, height: 800 });
    resetGenerationsForTests();
    registerSessionOwnerPreparer(registerSessionView);
  });

  test("an unchanged screen no longer remounts the pane", async () => {
    bootDeskPane("idle");
    act(() => { mountApp(); });
    spyHostCommits();

    await act(async () => { await refreshPaneRead(); });
    expect(sessionStore.get().paneText).toBe("hello");

    const before = composeField();
    expect(before).not.toBeNull();
    commits = 0;
    await act(async () => { await refreshPaneRead(); });
    expect(commits).toBe(0);
    expect(composeField()).toBe(before);
    expect(sessionStore.get().paneText).toBe("hello");
  });

  test("a fresh completion is acknowledged without repainting while composing", async () => {
    bootDeskPane("idle");
    act(() => { mountApp(); });
    spyHostCommits();
    // Desk mounts focus compose; the user is composing, so the pane is preserved.
    expect(composeFocused()).toBe(true);

    await act(async () => { await refreshPaneRead(); });
    expect(sessionStore.get().paneText).toBe("hello");

    act(() => { flipToDone(); });
    const before = composeField();
    expect(before).not.toBeNull();

    commits = 0;
    await act(async () => { await refreshPaneRead(); });
    expect(dashboardStore.get().completionSeen).toEqual({ p1: true });
    expect(commits).toBe(0);
    expect(composeField()).toBe(before);
  });

  test("a fresh completion repaints exactly once when not composing, then goes quiet", async () => {
    bootDeskPane("idle");
    act(() => { mountApp(); });
    spyHostCommits();
    // The user tapped the terminal: compose is no longer focused, so a fresh
    // completion owes the desk rail exactly one repaint.
    act(() => { setComposeFocused(false); });

    await act(async () => { await refreshPaneRead(); });
    expect(sessionStore.get().paneText).toBe("hello");

    act(() => { flipToDone(); });
    const before = composeField();
    expect(before).not.toBeNull();

    commits = 0;
    await act(async () => { await refreshPaneRead(); });
    expect(commits).toBe(1);
    expect(dashboardStore.get().completionSeen).toEqual({ p1: true });
    expect(composeField()).toBe(before);

    commits = 0;
    await act(async () => { await refreshPaneRead(); });
    expect(commits).toBe(0);
    expect(composeField()).toBe(before);
  });

  afterEach(async () => {
    await act(async () => {
      restoreHostCommit();
      stopPolling();
      unmountApp();
      registerSessionOwnerPreparer(null);
    });
    resetPaneReadFixture();
    commits = 0;
    expect(appHost() === null).toBeTrue();
    expect(isAppMounted()).toBeFalse();
  });
});

describe("desk pane-read scheduling", () => {
  beforeEach(async () => {
    await resetBoardTestDOM();
    happy.happyDOM.setWindowSize({ width: 1280, height: 800 });
    resetGenerationsForTests();
    registerAppHost(countingHost);
  });

  test("shares an in-flight fallback read instead of duplicating it", async () => {
    bootDeskPane("idle");
    let resolveRead!: (value: { text: string; hash: string }) => void;
    let calls = 0;
    attachLiveSession({
      isConnected: () => true,
      paneRead: async () => {
        calls += 1;
        return new Promise((resolve) => { resolveRead = resolve; });
      },
    });

    const first = refreshPaneRead();
    const shared = refreshPaneRead();
    expect(calls).toBe(1);
    resolveRead({ text: "hello", hash: "a".repeat(64) });
    await Promise.all([first, shared]);
    expect(calls).toBe(1);
  });

  test("queues one fresh read when a mutation acknowledgment is newer than the active read", async () => {
    bootDeskPane("idle");
    const resolvers: Array<(value: { text: string; hash: string }) => void> = [];
    let calls = 0;
    attachLiveSession({
      isConnected: () => true,
      paneRead: async () => {
        calls += 1;
        return new Promise((resolve) => { resolvers.push(resolve); });
      },
    });

    const fallback = refreshPaneRead();
    const notBefore = performance.now() + 1;
    const firstMutationRead = refreshPaneRead({ notBefore });
    const sharedMutationRead = refreshPaneRead({ notBefore });
    expect(calls).toBe(1);
    expect(sessionStore.get().paneReadPending).toBeTrue();

    resolvers.shift()!({ text: "hello", hash: "a".repeat(64) });
    await fallback;
    await Promise.resolve();
    expect(calls).toBe(2);
    resolvers.shift()!({ text: "after", hash: "b".repeat(64) });
    const observations = await Promise.all([firstMutationRead, sharedMutationRead]);
    expect(observations.every((observation) => observation?.hash === "b".repeat(64))).toBeTrue();
    expect(calls).toBe(2);
    expect(sessionStore.get().paneReadPending).toBeFalse();
  });

  afterEach(() => {
    releaseAppHost(countingHost);
    resetPaneReadFixture();
    renders = 0;
  });
});

describe("per-pane input mode", () => {
  beforeEach(async () => {
    await resetBoardTestDOM();
    happy.happyDOM.setWindowSize({ width: 1280, height: 800 });
    resetGenerationsForTests();
    registerAppHost(countingHost);
  });

  test("opening a completed pane acknowledges it in every display mode", async () => {
    for (const { mode, transport } of [
      { mode: "guided", transport: "relay" },
      { mode: "agent", transport: "relay" },
      { mode: "full", transport: "p2p" },
      { mode: "auto", transport: "p2p" },
    ] as const) {
      setPhase("live");
      setScreen("home");
      selectPane("");
      setNetworkOnline(true);
      setSessionTransport(transport);
      applyCapabilities({ ...NO_OPERATION_CAPABILITIES, history: true }, []);
      setPaneTermMode("p1", mode);
      applySnapshot({
        workspaces: [{ workspace_id: "demo", label: "demo" }],
        panes: [{
          pane_id: "p1",
          workspace_id: "demo",
          tab_id: "t1",
          cwd: "/tmp/demo",
          agent: "codex",
          agent_status: "done",
          history_available: true,
        }],
      });
      attachLiveSession({
        isConnected: () => true,
        paneRead: async () => ({ text: "done", hash: "hash-p1" }),
        agentTrace: async () => ({ items: [], nextCursor: null, truncated: false }),
      });

      await openPane("p1");

      expect(dashboardStore.get().completionSeen).toEqual({ p1: true });
      expect(dashboardStore.get().agents[0].status).toBe("idle");
    }
  });

  test("switching panes restores each input choice without changing the display mode", async () => {
    setPhase("live");
    setScreen("home");
    selectPane("");
    setNetworkOnline(true);
    setDefaultComposeLive(false);
    setPaneComposeLive("p1", true);
    setPaneComposeLive("p2", false);
    applySnapshot({
      workspaces: [{ workspace_id: "a", label: "one" }, { workspace_id: "b", label: "two" }],
      panes: [
        { pane_id: "p1", workspace_id: "a", tab_id: "t1", cwd: "/tmp/one", agent: "codex", agent_status: "idle" },
        { pane_id: "p2", workspace_id: "b", tab_id: "t2", cwd: "/tmp/two", agent: "codex", agent_status: "idle" },
      ],
    });
    attachLiveSession({
      isConnected: () => true,
      paneRead: async (paneId: string) => ({ text: paneId, hash: `hash-${paneId}` }),
    });

    await openPane("p1");
    expect(composeLive()).toBeTrue();
    expect(isFullTerminal()).toBeFalse();

    await openPane("p2");
    expect(composeLive()).toBeFalse();
    expect(isFullTerminal()).toBeFalse();

    await openPane("p1");
    expect(composeLive()).toBeTrue();
    expect(isFullTerminal()).toBeFalse();
  });

  afterEach(() => {
    releaseAppHost(countingHost);
    resetPaneReadFixture();
    renders = 0;
  });
});
