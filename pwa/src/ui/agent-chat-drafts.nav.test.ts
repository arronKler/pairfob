import { Window } from "happy-dom";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { ProtocolError } from "../lib/protocol/errors";

const happy = new Window({ url: "https://pairfob.com/pair", width: 390, height: 844 });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLTextAreaElement",
  "HTMLDetailsElement",
  "HTMLDialogElement",
  "Node",
  "DocumentFragment",
  "ResizeObserver",
  "MutationObserver",
  "DOMParser",
  "localStorage",
  "sessionStorage",
] as const) {
  g[key] = (happy as unknown as Record<string, unknown>)[key];
}
g.location = happy.location;
g.history = happy.history;
g.getComputedStyle = happy.getComputedStyle.bind(happy);
g.matchMedia = happy.matchMedia.bind(happy);
g.requestAnimationFrame = happy.requestAnimationFrame.bind(happy);
g.cancelAnimationFrame = happy.cancelAnimationFrame.bind(happy);
g.visualViewport = happy.visualViewport;
happy.document.body.innerHTML = '<main id="app"></main>';

const { app, messageOf, setPaneTermMode, state, visibleNotice } = await import("../state.ts");
const { bumpViewIncarnation, resetComposeDrafts } = await import("../compose-drafts.ts");
const { readStoredDraft } = await import("../state-drafts.ts");
const { clearAgentTraceCache } = await import("../lib/agent-trace-cache.ts");
const { setRenderer } = await import("../paint.ts");
const { renderPane } = await import("./pane.ts");
const { enterAgentChat, leaveAgentChat } = await import("./agent-chat.ts");
const { clearLiveConnection, closeComputerSession, establish, openPane } = await import("../live.ts");

function agent(paneId: string) {
  return {
    paneId,
    agent: "codex",
    hasAgent: true,
    status: "working" as const,
    workspaceLabel: "demo",
    cwd: "/tmp/demo",
    historyAvailable: true,
  };
}

function credential(daemonId: string) {
  return {
    daemonId,
    deviceId: `phone_${daemonId}`,
    psk: new Uint8Array(32),
    daemonPk: new Uint8Array(32),
    relayOrigin: "https://pairfob.com",
    fp: `fp_${daemonId}`,
    label: "test",
    createdAt: 1,
  };
}

function live(promptAgent?: () => Promise<unknown>) {
  return {
    agentTrace: async () => ({ items: [], nextCursor: null, truncated: false }),
    promptAgent: promptAgent ?? (async () => ({ outcome: "applied" })),
    sendKeys: async () => undefined,
    sendText: async () => undefined,
    snapshot: async () => ({
      panes: [
        { pane_id: "p1", workspace_id: "w1", agent: "codex", agent_status: "working", cwd: "/tmp/demo", history_available: true },
        { pane_id: "p2", workspace_id: "w1", agent: "codex", agent_status: "working", cwd: "/tmp/demo", history_available: true },
      ],
    }),
    getConfig: async () => ({}),
    setNetworkAvailable: () => undefined,
    switchTransport: async () => undefined,
    isConnected: () => true,
    onEvent: () => () => undefined,
    reconnectNow: () => undefined,
    close: () => undefined,
  };
}

function boot(): void {
  state.phase = "live";
  state.screen = "pane";
  state.paneId = "p1";
  state.credential = credential("daemon-a");
  state.composeDraft = "";
  state.operationBusy = false;
  state.notice = null;
  state.agentTraceNote = "";
  state.operationCapabilities = { ...state.operationCapabilities, prompt_agent: true, history: true };
  state.agents = [agent("p1"), agent("p2")];
  state.live = live() as typeof state.live;
  state.fullTerminal = false;
  state.agentChat = true;
  state.agentTraceLoadState = "ready";
  state.agentTraceItems = [];
  state.agentTracePending = "";
  state.agentTracePendingBase = [];
  state.agentTraceFollow = true;
  setPaneTermMode("p1", "agent");
  setPaneTermMode("p2", "agent");
  setRenderer(() => renderPane());
  renderPane();
}

function field(): HTMLTextAreaElement {
  const input = app.querySelector(".agent-dock textarea");
  if (!(input instanceof HTMLTextAreaElement)) throw new Error("missing compose");
  return input;
}

function typeDraft(text: string): void {
  const input = field();
  input.value = text;
  input.dispatchEvent(new happy.Event("input", { bubbles: true }));
}

function clickSend(): void {
  const send = app.querySelector(".agent-dock .send-btn");
  if (!(send instanceof HTMLButtonElement)) throw new Error("missing send");
  send.click();
}

beforeAll(() => {
  setRenderer(() => renderPane());
});

afterEach(() => {
  closeComputerSession("draft-nav-a");
  closeComputerSession("draft-nav-b");
  leaveAgentChat({ rememberGuided: false, paint: false });
  resetComposeDrafts();
  state.operationBusy = false;
  state.composeDraft = "";
  state.agentTraceNote = "";
  state.notice = null;
  state.live = null;
  state.credential = null;
  state.paneTermModes = {};
  clearAgentTraceCache();
  app.replaceChildren();
});

describe("navigation keeps unsent drafts", () => {
  test("A then B then A restores each pane's unsent chat draft", async () => {
    boot();
    typeDraft("draft for A");
    await openPane("p2");
    expect(state.paneId).toBe("p2");
    expect(field().value).toBe("");
    typeDraft("draft for B");
    await openPane("p1");
    expect(state.paneId).toBe("p1");
    expect(state.composeDraft).toBe("draft for A");
    expect(field().value).toBe("draft for A");
    await openPane("p2");
    expect(state.composeDraft).toBe("draft for B");
    expect(field().value).toBe("draft for B");
  });

  test("leaving chat and returning keeps the chat draft off the guided composer", () => {
    boot();
    typeDraft("only in chat");
    leaveAgentChat();
    expect(state.agentChat).toBe(false);
    expect(state.composeDraft).toBe("");
    const guided = app.querySelector(".dock-form textarea");
    if (guided instanceof HTMLTextAreaElement) expect(guided.value).toBe("");
    enterAgentChat();
    expect(state.agentChat).toBe(true);
    expect(field().value).toBe("only in chat");
  });
});

describe("async prompt results stay on the originating request", () => {
  test("a delayed failure after A→B does not inject A's text or error into B", async () => {
    boot();
    let reject!: (error: Error) => void;
    let postedPane = "";
    state.live = {
      ...live(),
      promptAgent: async (params: { pane_id: string }) => {
        postedPane = params.pane_id;
        return await new Promise((_, fail) => {
          reject = fail;
        });
      },
    } as typeof state.live;
    typeDraft("Prompt intended for pane A");
    renderPane();
    clickSend();
    await Promise.resolve();
    expect(state.operationBusy).toBe(true);
    expect(postedPane).toBe("p1");

    await openPane("p2");
    expect(state.operationBusy).toBe(false);
    state.composeDraft = "Draft belonging to pane B";
    renderPane();
    const focusedBefore = document.activeElement;
    const failed = new ProtocolError("timeout", "audit delayed response for pane A");
    reject(failed);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(postedPane).toBe("p1");
    expect(state.paneId).toBe("p2");
    expect(state.composeDraft).toBe("Draft belonging to pane B");
    expect(field().value).toBe("Draft belonging to pane B");
    expect(state.agentTraceNote).not.toContain("delayed response for pane A");
    expect(visibleNotice()).toBeNull();
    expect(state.operationBusy).toBe(false);
    expect(document.activeElement).toBe(focusedBefore);
    expect(readStoredDraft({ daemonId: "daemon-a", paneId: "p1", mode: "agent" }).text).toBe(
      "Prompt intended for pane A",
    );

    await openPane("p1");
    expect(state.composeDraft).toBe("Prompt intended for pane A");
    expect(field().value).toBe("Prompt intended for pane A");
    expect(readStoredDraft({ daemonId: "daemon-a", paneId: "p1", mode: "agent" }).error).toBe(messageOf(failed));
    expect(visibleNotice()).toBeNull();
  });

  test("a delayed success after A→B does not paint or focus B", async () => {
    boot();
    let resolvePrompt!: () => void;
    state.live = {
      ...live(),
      promptAgent: async (params: { pane_id: string }) => {
        expect(params.pane_id).toBe("p1");
        await new Promise<void>((resolve) => {
          resolvePrompt = resolve;
        });
        return { outcome: "applied" };
      },
    } as typeof state.live;
    typeDraft("A submitted");
    clickSend();
    await Promise.resolve();
    await openPane("p2");
    expect(state.operationBusy).toBe(false);
    state.composeDraft = "B draft";
    renderPane();
    resolvePrompt();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(state.paneId).toBe("p2");
    expect(state.composeDraft).toBe("B draft");
    expect(field().value).toBe("B draft");
    expect(state.agentTracePending).toBe("");
    expect(state.operationBusy).toBe(false);
  });

  test("unknown_outcome after a pane switch does not restore the prompt for replay", async () => {
    boot();
    let reject!: (error: Error) => void;
    let promptCalls = 0;
    state.live = {
      ...live(),
      promptAgent: async () => {
        promptCalls += 1;
        return await new Promise((_, fail) => {
          reject = fail;
        });
      },
    } as typeof state.live;
    typeDraft("do not replay");
    clickSend();
    await Promise.resolve();
    await openPane("p2");
    state.composeDraft = "B stays";
    renderPane();
    const unknown = new ProtocolError("unknown_outcome", "refresh before retry");
    reject(unknown);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(promptCalls).toBe(1);
    expect(state.composeDraft).toBe("B stays");
    expect(readStoredDraft({ daemonId: "daemon-a", paneId: "p1", mode: "agent" }).text).toBe("");
    expect(visibleNotice()).toBeNull();
    await openPane("p1");
    expect(state.composeDraft).toBe("");
    expect(field().value).toBe("");
    expect(readStoredDraft({ daemonId: "daemon-a", paneId: "p1", mode: "agent" }).error).toBe(messageOf(unknown));
    expect(visibleNotice()).toBeNull();
  });

  test("A→B→A while the request is in flight still owns the original pane", async () => {
    boot();
    let reject!: (error: Error) => void;
    state.live = {
      ...live(),
      promptAgent: async () =>
        await new Promise((_, fail) => {
          reject = fail;
        }),
    } as typeof state.live;
    typeDraft("still A's prompt");
    clickSend();
    await Promise.resolve();
    await openPane("p2");
    expect(state.operationBusy).toBe(false);
    await openPane("p1");
    expect(state.composeDraft).toBe("");
    expect(state.operationBusy).toBe(false);
    reject(new ProtocolError("timeout", "late A failure"));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(state.paneId).toBe("p1");
    expect(state.composeDraft).toBe("still A's prompt");
    expect(field().value).toBe("still A's prompt");
    expect(visibleNotice()).toBeNull();
    expect(state.operationBusy).toBe(false);
  });

  test("the same pane id on another computer does not take the original result", async () => {
    boot();
    let reject!: (error: Error) => void;
    const sessionA = state.live;
    state.live = {
      ...live(),
      promptAgent: async () =>
        await new Promise((_, fail) => {
          reject = fail;
        }),
    } as typeof state.live;
    typeDraft("computer A prompt");
    clickSend();
    await Promise.resolve();

    bumpViewIncarnation();
    state.operationBusy = false;
    state.credential = credential("daemon-b");
    state.live = { ...live(), promptAgent: async () => ({ outcome: "applied" }) } as typeof state.live;
    state.composeDraft = "computer B draft";
    renderPane();

    reject(new ProtocolError("timeout", "computer A failed"));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(state.composeDraft).toBe("computer B draft");
    expect(field().value).toBe("computer B draft");
    expect(state.agentTraceNote).not.toContain("computer A failed");
    expect(readStoredDraft({ daemonId: "daemon-a", paneId: "p1", mode: "agent" }).text).toBe("computer A prompt");
    expect(sessionA).not.toBe(state.live);
  });

  test("agent→guided→agent while pending does not treat the new chat as live", async () => {
    boot();
    let reject!: (error: Error) => void;
    state.live = {
      ...live(),
      promptAgent: async () =>
        await new Promise((_, fail) => {
          reject = fail;
        }),
    } as typeof state.live;
    typeDraft("mode switch prompt");
    clickSend();
    await Promise.resolve();
    leaveAgentChat();
    expect(state.agentChat).toBe(false);
    expect(state.operationBusy).toBe(false);
    enterAgentChat();
    expect(state.agentChat).toBe(true);
    const failed = new ProtocolError("timeout", "stale mode failure");
    reject(failed);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(visibleNotice()).toBeNull();
    expect(field().value).toBe("mode switch prompt");
    expect(readStoredDraft({ daemonId: "daemon-a", paneId: "p1", mode: "agent" }).error).toBe(messageOf(failed));
  });

  test("an older success does not erase a newer draft typed after A→B→A", async () => {
    boot();
    let resolvePrompt!: () => void;
    state.live = {
      ...live(),
      promptAgent: async () => {
        await new Promise<void>((resolve) => {
          resolvePrompt = resolve;
        });
        return { outcome: "applied" };
      },
    } as typeof state.live;
    typeDraft("first send");
    clickSend();
    await Promise.resolve();
    await openPane("p2");
    await openPane("p1");
    typeDraft("newer attempt");
    resolvePrompt();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(field().value).toBe("newer attempt");
    expect(readStoredDraft({ daemonId: "daemon-a", paneId: "p1", mode: "agent" }).text).toBe("newer attempt");
  });

  test("success after switching computers does not mark the new computer's same pane id", async () => {
    boot();
    state.agents = [
      { ...agent("p1"), status: "idle" },
      { ...agent("p2"), status: "idle" },
    ];
    state.runtimeAgentStatuses = { p1: "idle", p2: "idle" };
    state.completionSeen = { p1: true };
    let resolvePrompt!: () => void;
    const sessionA = {
      ...live(),
      promptAgent: async () => {
        await new Promise<void>((resolve) => {
          resolvePrompt = resolve;
        });
        return { outcome: "applied" };
      },
    };
    state.live = sessionA as typeof state.live;
    typeDraft("submit on A");
    clickSend();
    await Promise.resolve();

    state.credential = credential("daemon-b");
    state.live = live() as typeof state.live;
    state.agents = [
      { ...agent("p1"), status: "idle" },
      { ...agent("p2"), status: "idle" },
    ];
    state.runtimeAgentStatuses = { p1: "idle", p2: "idle" };
    state.completionSeen = { p1: true };
    bumpViewIncarnation();

    resolvePrompt();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(state.agents[0]?.status).toBe("idle");
    expect(state.completionSeen).toEqual({ p1: true });
  });

  test("establish parks the original computer's draft before changing identity", async () => {
    boot();
    state.credential = credential("draft-nav-a");
    typeDraft("keep on computer A");
    const connect = async () => live() as never;
    await establish(credential("draft-nav-b") as never, connect);
    expect(readStoredDraft({ daemonId: "draft-nav-a", paneId: "p1", mode: "agent" }).text).toBe("keep on computer A");
    expect(readStoredDraft({ daemonId: "draft-nav-b", paneId: "p1", mode: "agent" }).text).toBe("");
  });

  test("clearLiveConnection parks a full-terminal draft before disposing the mode", () => {
    boot();
    state.agentChat = false;
    state.fullTerminal = true;
    state.composeDraft = "full draft stays with full";
    clearLiveConnection();
    expect(readStoredDraft({ daemonId: "daemon-a", paneId: "p1", mode: "full" }).text).toBe("full draft stays with full");
    expect(readStoredDraft({ daemonId: "daemon-a", paneId: "p1", mode: "guided" }).text).toBe("");
  });
});
