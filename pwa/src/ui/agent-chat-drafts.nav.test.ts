import { happy, resetChatDOM } from "../../test-support/chat-dom";
import { beforeEach, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { ProtocolError } from "../lib/protocol/errors";

const { app, messageOf, setPaneTermMode, state, visibleNotice } = await import("../state.ts");
const { bumpViewIncarnation, currentViewIncarnation, promptRequestIsLive, resetComposeDrafts } = await import("../compose-drafts.ts");
const { readStoredDraft } = await import("../state-drafts.ts");
const { clearAgentTraceCache } = await import("../lib/agent-trace-cache.ts");
const { setRenderer } = await import("../paint.ts");
const { renderPane } = await import("./pane.ts");
const { renderApp } = await import("./react/app-screen");
const { leaveReactScreen } = await import("./react/root");
beforeEach(resetChatDOM);
const { enterAgentChat, leaveAgentChat } = await import("./agent-chat.ts");
const { clearLiveConnection, closeComputerSession, establish, openPane } = await import("../live.ts");
const { openSettings } = await import("../live-settings.ts");
const { openComputers } = await import("../computers.ts");

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
    listDevices: async () => ({ devices: [] }),
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
  setRenderer(paintLive);
  paintLive();
}

function paintLive(): void {
  renderApp();
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
  setRenderer(paintLive);
});

afterEach(async () => await act(async () => {
  closeComputerSession("draft-nav-a");
  closeComputerSession("draft-nav-b");
  leaveAgentChat({ rememberGuided: false, paint: false });
  resetComposeDrafts();
  state.operationBusy = false;
  state.composeDraft = "";
  state.composeIME = false;
  state.agentTraceNote = "";
  state.notice = null;
  state.live = null;
  state.credential = null;
  state.paneTermModes = {};
  clearAgentTraceCache();
  leaveReactScreen();
  app.replaceChildren();
}));

describe("navigation keeps unsent drafts", () => {
  test("A then B then A restores each pane's unsent chat draft", async () => await act(async () => {
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
  }));

  test("leaving chat and returning keeps the chat draft off the guided composer", async () => await act(async () => {
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
  }));
});

describe("async prompt results stay on the originating request", () => {
  test("stale reconciliation paints navigation when the current pane disappears", async () => await act(async () => {
    boot();
    let fail!: () => void;
    const session = live();
    state.live = {
      ...session,
      promptAgent: () => new Promise((_, reject) => {
        fail = () => reject(new ProtocolError("unknown_outcome", "uncertain old request"));
      }),
      snapshot: async () => {
        const snapshot = await session.snapshot();
        return { ...snapshot, panes: snapshot.panes.filter((pane) => pane.pane_id !== "p2") };
      },
    } as typeof state.live;
    typeDraft("A request");
    clickSend();
    await openPane("p2");
    let paintedScreen = "";
    setRenderer(() => { paintedScreen = state.screen; paintLive(); });
    fail();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(state.paneId).toBe("");
    expect(state.screen).toBe("home");
    expect(paintedScreen).toBe("home");
  }));

  for (const mode of ["agent", "guided"] as const) {
    for (const outcome of ["success", "conflict", "unknown_outcome"] as const) {
      test(`stale ${outcome} preserves the other pane's ${mode} composer`, async () => await act(async () => {
        boot();
        let finish!: () => void;
        let snapshots = 0;
        let sends = 0;
        const session = live();
        state.live = {
          ...session,
          snapshot: async () => { snapshots++; return session.snapshot(); },
          promptAgent: () => {
            sends++;
            return new Promise((resolve, reject) => {
              finish = () => outcome === "success"
                ? resolve({ outcome: "applied" })
                : reject(new ProtocolError(outcome, "delayed owner result"));
            });
          },
        } as typeof state.live;
        typeDraft("A request");
        clickSend();
        await openPane("p2");
        if (mode === "guided") leaveAgentChat();
        const input = app.querySelector("textarea");
        if (!(input instanceof HTMLTextAreaElement)) throw new Error("missing destination compose");
        input.focus();
        input.dispatchEvent(new happy.Event("compositionstart", { bubbles: true }));
        input.value = "B 中文输入中";
        input.setSelectionRange(2, 5);
        input.dispatchEvent(new happy.Event("input", { bubbles: true }));
        const priorReads = snapshots;
        finish();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(app.querySelector("textarea") === input).toBe(true);
        expect(input.value).toBe("B 中文输入中");
        expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5]);
        expect(input.ownerDocument.activeElement === input).toBe(true);
        expect(state.paneId).toBe("p2");
        expect(state.operationBusy).toBe(false);
        expect(state.composeIME).toBe(true);
        expect(sends).toBe(1);
        expect(snapshots - priorReads).toBe(outcome === "unknown_outcome" ? 1 : 0);
      }));
    }
  }

  test("a delayed failure after A→B does not inject A's text or error into B", async () => await act(async () => {
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
    typeDraft("Draft belonging to pane B");
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
  }));

  test("A pending then B IME input is not overwritten when A fails", async () => await act(async () => {
    boot();
    let reject!: (error: Error) => void;
    state.live = {
      ...live(),
      promptAgent: async () =>
        await new Promise((_, fail) => {
          reject = fail;
        }),
    } as typeof state.live;
    typeDraft("Prompt intended for pane A");
    clickSend();
    await Promise.resolve();
    await openPane("p2");
    const input = field();
    input.focus();
    input.dispatchEvent(new happy.Event("compositionstart", { bubbles: true }));
    expect(state.composeIME).toBe(true);
    input.value = "composed-on-B";
    input.setSelectionRange(4, 9);
    input.dispatchEvent(new happy.Event("input", { bubbles: true }));
    expect(state.composeDraft).not.toBe("composed-on-B");
    const beforeValue = input.value;
    const beforeStart = input.selectionStart;
    const beforeEnd = input.selectionEnd;
    reject(new ProtocolError("timeout", "A failed during B composition"));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(state.paneId).toBe("p2");
    expect(field()).toBe(input);
    expect(input.value).toBe(beforeValue);
    expect(input.selectionStart).toBe(beforeStart);
    expect(input.selectionEnd).toBe(beforeEnd);
    expect(state.composeIME).toBe(true);
  }));

  test("a delayed success after A→B does not paint or focus B", async () => await act(async () => {
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
    typeDraft("B draft");
    resolvePrompt();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(state.paneId).toBe("p2");
    expect(state.composeDraft).toBe("B draft");
    expect(field().value).toBe("B draft");
    expect(state.agentTracePending).toBe("");
    expect(state.operationBusy).toBe(false);
  }));

  test("unknown_outcome after a pane switch does not restore the prompt for replay", async () => await act(async () => {
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
    typeDraft("B stays");
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
  }));

  test("A→B→A while the request is in flight still owns the original pane", async () => await act(async () => {
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
  }));

  test("the same pane id on another computer does not take the original result", async () => await act(async () => {
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
  }));

  test("agent→guided→agent while pending does not treat the new chat as live", async () => await act(async () => {
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
  }));

  test("an older success does not erase a newer draft typed after A→B→A", async () => await act(async () => {
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
  }));

  test("success after switching computers does not mark the new computer's same pane id", async () => await act(async () => {
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
  }));

  test("establish parks the original computer's draft before changing identity", async () => await act(async () => {
    boot();
    state.credential = credential("draft-nav-a");
    typeDraft("keep on computer A");
    const connect = async () => live() as never;
    await establish(credential("draft-nav-b") as never, connect);
    expect(readStoredDraft({ daemonId: "draft-nav-a", paneId: "p1", mode: "agent" }).text).toBe("keep on computer A");
    expect(readStoredDraft({ daemonId: "draft-nav-b", paneId: "p1", mode: "agent" }).text).toBe("");
  }));

  test("clearLiveConnection parks a full-terminal draft before disposing the mode", async () => await act(async () => {
    boot();
    state.agentChat = false;
    state.fullTerminal = true;
    state.composeDraft = "full draft stays with full";
    clearLiveConnection();
    expect(readStoredDraft({ daemonId: "daemon-a", paneId: "p1", mode: "full" }).text).toBe("full draft stays with full");
    expect(readStoredDraft({ daemonId: "daemon-a", paneId: "p1", mode: "guided" }).text).toBe("");
  }));

  test("openSettings then openComputers still parks the pane draft for establish", async () => await act(async () => {
    boot();
    typeDraft("keep through settings");
    openSettings();
    await Promise.resolve();
    expect(state.screen).toBe("settings");
    expect(readStoredDraft({ daemonId: "daemon-a", paneId: "p1", mode: "agent" }).text).toBe("keep through settings");
    openComputers();
    expect(state.screen).toBe("computers");
    const connect = async () => live() as never;
    await establish(credential("draft-nav-b") as never, connect);
    expect(readStoredDraft({ daemonId: "daemon-a", paneId: "p1", mode: "agent" }).text).toBe("keep through settings");
    expect(readStoredDraft({ daemonId: "draft-nav-b", paneId: "p1", mode: "agent" }).text).toBe("");
  }));

  test("returning from settings does not give a pending send DOM ownership", async () => await act(async () => {
    boot();
    happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
    let reject!: (error: Error) => void;
    state.live = {
      ...live(),
      promptAgent: async () =>
        await new Promise((_, fail) => {
          reject = fail;
        }),
    } as typeof state.live;
    typeDraft("pending through settings");
    clickSend();
    await Promise.resolve();
    const incarnation = currentViewIncarnation();
    openSettings();
    await Promise.resolve();
    await Promise.resolve();
    expect(state.screen).toBe("settings");
    expect(state.operationBusy).toBe(false);
    const back = app.querySelector(".back");
    if (!(back instanceof HTMLButtonElement)) throw new Error("missing settings back");
    back.click();
    expect(state.screen).toBe("pane");
    expect(currentViewIncarnation()).toBeGreaterThan(incarnation);
    const failed = new ProtocolError("timeout", "stale after settings");
    reject(failed);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(visibleNotice()).toBeNull();
    expect(promptRequestIsLive({
      session: state.live!,
      viewIncarnation: incarnation,
      lockId: 0,
      revision: 0,
      noticeScope: { phase: "live", screen: "pane", daemonId: "daemon-a", paneId: "p1" },
      draftScope: { daemonId: "daemon-a", paneId: "p1", mode: "agent" },
      text: "pending through settings",
    })).toBe(false);
  }));
});
