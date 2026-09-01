import { Window } from "happy-dom";
import { afterEach, describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/", width: 1280, height: 800 });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLTextAreaElement",
  "Node",
  "DocumentFragment",
  "localStorage",
  "sessionStorage",
] as const) {
  g[key] = (happy as unknown as Record<string, unknown>)[key];
}
g.location = happy.location;
g.getComputedStyle = happy.getComputedStyle.bind(happy);
g.matchMedia = happy.matchMedia.bind(happy);
g.requestAnimationFrame = happy.requestAnimationFrame.bind(happy);
happy.document.body.innerHTML = '<main id="app"></main>';

const { setPaneComposeLive, state } = await import("./state.ts");
const { NO_OPERATION_CAPABILITIES } = await import("./lib/operations.ts");
const { setRenderer } = await import("./paint.ts");
const { openPane, refreshPaneRead } = await import("./live.ts");

let renders = 0;
setRenderer(() => {
  renders += 1;
});

function bootDeskPane(status: "idle" | "done"): void {
  state.phase = "live";
  state.screen = "pane";
  state.paneId = "p1";
  state.networkOnline = true;
  state.snapshotAt = Date.now();
  state.composeDraft = "";
  state.composeFocused = false;
  state.composeIME = false;
  state.agents = [
    { paneId: "p1", agent: "codex", hasAgent: true, status, workspaceLabel: "demo", cwd: "/tmp/demo" },
  ];
  state.runtimeAgentStatuses = { p1: status };
  state.completionSeen = {};
  state.live = {
    isConnected: () => true,
    paneRead: async () => ({ text: "hello", hash: "a".repeat(64) }),
  };
}

/**
 * The pane-read poll fires every 1.5s while a pane is open. On desk, an
 * unchanged screen used to trigger a full remount whenever the compose field
 * was not focused, which wiped an in-progress terminal text selection and
 * stole focus. Only a fresh completion acknowledgment may repaint now.
 */
describe("desk pane reads on an idle screen", () => {
  test("an unchanged screen no longer remounts the pane", async () => {
    bootDeskPane("idle");
    await refreshPaneRead();
    expect(state.paneText).toBe("hello");

    renders = 0;
    await refreshPaneRead();
    expect(renders).toBe(0);
  });

  test("a fresh completion repaints exactly once, then goes quiet", async () => {
    bootDeskPane("idle");
    await refreshPaneRead();

    renders = 0;
    state.agents[0].status = "done";
    state.runtimeAgentStatuses = { p1: "done" };
    await refreshPaneRead();
    expect(renders).toBe(1);

    renders = 0;
    await refreshPaneRead();
    expect(renders).toBe(0);
  });

  test("shares an in-flight fallback read instead of duplicating it", async () => {
    bootDeskPane("idle");
    let resolveRead!: (value: { text: string; hash: string }) => void;
    let calls = 0;
    state.live = {
      isConnected: () => true,
      paneRead: async () => {
        calls += 1;
        return new Promise((resolve) => { resolveRead = resolve; });
      },
    };

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
    state.live = {
      isConnected: () => true,
      paneRead: async () => {
        calls += 1;
        return new Promise((resolve) => { resolvers.push(resolve); });
      },
    };

    const fallback = refreshPaneRead();
    const notBefore = performance.now() + 1;
    const firstMutationRead = refreshPaneRead({ notBefore });
    const sharedMutationRead = refreshPaneRead({ notBefore });
    expect(calls).toBe(1);
    expect(state.paneReadPending).toBeTrue();

    resolvers.shift()!({ text: "hello", hash: "a".repeat(64) });
    await fallback;
    await Promise.resolve();
    expect(calls).toBe(2);
    resolvers.shift()!({ text: "after", hash: "b".repeat(64) });
    const observations = await Promise.all([firstMutationRead, sharedMutationRead]);
    expect(observations.every((observation) => observation?.hash === "b".repeat(64))).toBeTrue();
    expect(calls).toBe(2);
    expect(state.paneReadPending).toBeFalse();
  });
});

describe("per-pane input mode", () => {
  test("opening a completed pane acknowledges it in every display mode", async () => {
    for (const { mode, transport } of [
      { mode: "guided", transport: "relay" },
      { mode: "agent", transport: "relay" },
      { mode: "full", transport: "p2p" },
      { mode: "auto", transport: "p2p" },
    ] as const) {
      state.phase = "live";
      state.screen = "home";
      state.paneId = "";
      state.networkOnline = true;
      state.sessionTransport = transport;
      state.operationCapabilities = { ...NO_OPERATION_CAPABILITIES, history: true };
      state.paneTermModes = { p1: mode };
      state.agents = [{
        paneId: "p1",
        agent: "codex",
        hasAgent: true,
        status: "done",
        workspaceLabel: "demo",
        cwd: "/tmp/demo",
        historyAvailable: true,
      }];
      state.runtimeAgentStatuses = { p1: "done" };
      state.completionSeen = {};
      state.live = {
        isConnected: () => true,
        paneRead: async () => ({ text: "done", hash: "hash-p1" }),
        agentTrace: async () => ({ items: [], nextCursor: null, truncated: false }),
      };

      await openPane("p1");

      expect(state.completionSeen).toEqual({ p1: true });
      expect(state.agents[0].status).toBe("idle");
    }
  });

  test("switching panes restores each input choice without changing the display mode", async () => {
    state.phase = "live";
    state.screen = "home";
    state.paneId = "";
    state.networkOnline = true;
    state.defaultComposeLive = false;
    state.paneComposeLive = {};
    state.paneTermModes = {};
    state.agents = [
      { paneId: "p1", agent: "codex", hasAgent: true, status: "idle", workspaceLabel: "one", cwd: "/tmp/one" },
      { paneId: "p2", agent: "codex", hasAgent: true, status: "idle", workspaceLabel: "two", cwd: "/tmp/two" },
    ];
    state.live = {
      isConnected: () => true,
      paneRead: async (paneId: string) => ({ text: paneId, hash: `hash-${paneId}` }),
    };
    setPaneComposeLive("p1", true);
    setPaneComposeLive("p2", false);

    await openPane("p1");
    expect(state.composeLive).toBeTrue();
    expect(state.fullTerminal).toBeFalse();

    await openPane("p2");
    expect(state.composeLive).toBeFalse();
    expect(state.fullTerminal).toBeFalse();

    await openPane("p1");
    expect(state.composeLive).toBeTrue();
    expect(state.fullTerminal).toBeFalse();
  });
});

afterEach(() => {
  state.live = null;
  state.paneId = "";
  state.screen = "home";
  state.agents = [];
  state.runtimeAgentStatuses = {};
  state.completionSeen = {};
  state.paneText = "";
  state.paneHash = "";
  state.paneReadBusy = false;
  state.paneReadPending = false;
  state.composeLive = false;
  state.defaultComposeLive = false;
  state.paneComposeLive = {};
  state.paneTermModes = {};
  state.operationCapabilities = { ...NO_OPERATION_CAPABILITIES };
  state.sessionTransport = "relay";
  state.agentChat = false;
  state.fullTerminal = false;
  renders = 0;
});
