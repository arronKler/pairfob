import { happy, resetChatDOM } from "../../../../test-support/chat-dom";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { ProtocolError } from "../../../lib/protocol/errors";
import type { LiveSession, PairResult } from "../../../lib/protocol/client";

const { applyTrace, chatSnapshot } = await import("./trace-store.ts");
const { appRoot } = await import("../../../app/dom-root.ts");
const { commitView } = await import("../../../app/host.ts");
const { mountApp, unmountApp } = await import("../../../app/mount.tsx");
const { registerSessionOwnerPreparer } = await import("../../../app/frame.ts");
const { registerSessionView } = await import("../register.ts");
const { resetTransitionState } = await import("../../../app/transition.ts");
const { resetComposeDrafts, bumpViewIncarnation, currentViewIncarnation, promptRequestIsLive } = await import("../drafts/compose-drafts.ts");
const { readStoredDraft } = await import("../drafts/state-drafts.ts");
const { clearAgentTraceCache } = await import("../../../lib/agent-trace-cache.ts");
const { messageOf } = await import("../../../lib/notices.ts");
const { visibleNotice, clearNotice } = await import("../../../app/notices-store.ts");
const { setPhase, setNetworkOnline } = await import("../../connection/connection-store.ts");
const { currentScreen, setScreen } = await import("../../../app/navigation-store.ts");
const { openPaneId, isAgentChat, setAgentChat, setFullTerminal, resetPaneView, selectPane } = await import("../session-store.ts");
const { operationBusy, setOperationBusy, applyCapabilities } = await import("../../operations/capabilities-store.ts");
const { attachLiveSession, liveSession, setCredential } = await import("../../computers/catalog-store.ts");
const { applySnapshot, liveAgents, dashboardStore, reloadCompletionSeen } = await import("../../dashboard/catalog-store.ts");
const { applyRuntimeIdentity } = await import("../../connection/runtime-store.ts");
const { paneTermMode, setPaneTermMode, resetPreferences } = await import("../../settings/preferences-store.ts");
const { composeDraft, composeIME, setComposeDraft } = await import("../compose-store.ts");
const { setLang } = await import("../../../lib/i18n.ts");
const { enterAgentChat, leaveAgentChat } = await import("./agent-chat-controller.ts");
const { clearLiveConnection, closeComputerSession, establish, openPane } = await import("../../../features/connection/controller.ts");
const { openSettings } = await import("../../../features/settings/actions.ts");
const { openComputers } = await import("../../../features/computers/actions.ts");
import { happy as happyDom } from "../../../../test-support/dom";

const app = appRoot();
const trace = () => chatSnapshot();
const setTrace = (patch: Parameters<typeof applyTrace>[0]): void => { applyTrace(patch); };

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

function credential(daemonId: string): PairResult {
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

function live(promptAgent?: () => Promise<unknown>): LiveSession {
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
  } as unknown as LiveSession;
}

function boot(): void {
  act(() => {
    setLang("zh");
    setPhase("live");
    setScreen("pane");
    setNetworkOnline(true);
    selectPane("p1");
    resetPaneView();
    setFullTerminal(false);
    setAgentChat(true);
    applyCapabilities({ history: true, prompt_agent: true }, []);
    setOperationBusy(false);
    applyRuntimeIdentity({ herdHost: "", runtimeKind: "herdr" });
    setTrace({ agentTraceLoadState: "ready", agentTraceItems: [], agentTracePending: "",
      agentTracePendingBase: [], agentTraceFollow: true });
    attachLiveSession(live() as LiveSession);
    applySnapshot({
      workspaces: [{ workspace_id: "w1", label: "demo", cwd: "/tmp/demo" }],
      panes: [
        { pane_id: "p1", workspace_id: "w1", agent: "codex", agent_status: "working", cwd: "/tmp/demo", history_available: true },
        { pane_id: "p2", workspace_id: "w1", agent: "codex", agent_status: "working", cwd: "/tmp/demo", history_available: true },
      ],
    });
    // credential is adopted directly for the boot identity.
    setCredential(credential("daemon-a"));
    setPaneTermMode("p1", "agent");
    setPaneTermMode("p2", "agent");
    commitView();
  });
}

// Seeded agent rows -> snapshot wire.
type SeedAgent = { paneId?: string; agent?: string; hasAgent?: boolean; status?: string; cwd?: string; historyAvailable?: boolean };
function setAgents(agents: ReadonlyArray<SeedAgent>, cwd = "/tmp/demo"): void {
  applySnapshot({
    workspaces: [{ workspace_id: "w1", label: "demo", cwd }],
    panes: agents.map((a) => ({
      pane_id: a.paneId ?? "p1",
      workspace_id: "w1",
      agent: a.hasAgent === false || a.agent === "" ? "" : (a.agent ?? "codex"),
      agent_status: a.status ?? "working",
      cwd: a.cwd ?? cwd,
      history_available: a.historyAvailable ?? true,
    })),
  });
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

function setLive(handle: LiveSession | null): void { attachLiveSession(handle); }

beforeEach(async () => {
  await resetChatDOM();
  resetTransitionState();
  clearAgentTraceCache();
  resetComposeDrafts();
  clearNotice();
  registerSessionOwnerPreparer(registerSessionView);
  act(() => mountApp());
});

afterEach(async () => await act(async () => {
  clearLiveConnection();
  closeComputerSession("draft-nav-a");
  closeComputerSession("draft-nav-b");
  leaveAgentChat({ rememberGuided: false, paint: false });
  resetComposeDrafts();
  setTrace({ agentTraceNote: "" } as Parameters<typeof applyTrace>[0]);
  clearNotice();
  setLive(null);
  setCredential(null);
  unmountApp();
  // Restore per-pane preference data baseline (the original afterEach reset
  // paneTermModes to {}); reset data only, subscriber registry stays intact.
  resetPreferences();
  registerSessionOwnerPreparer(null);
  resetTransitionState();
  await happyDom.happyDOM.abort();
}));
describe("navigation keeps unsent drafts", () => {
  test("A then B then A restores each pane's unsent chat draft", async () => await act(async () => {
    boot();
    typeDraft("draft for A");
    await openPane("p2");
    expect(openPaneId()).toBe("p2");
    expect(field().value).toBe("");
    typeDraft("draft for B");
    await openPane("p1");
    expect(openPaneId()).toBe("p1");
    expect(composeDraft()).toBe("draft for A");
    expect(field().value).toBe("draft for A");
    await openPane("p2");
    expect(composeDraft()).toBe("draft for B");
    expect(field().value).toBe("draft for B");
  }));

  test("leaving chat and returning keeps the chat draft off the guided composer", async () => await act(async () => {
    boot();
    typeDraft("only in chat");
    leaveAgentChat();
    expect(isAgentChat()).toBe(false);
    expect(composeDraft()).toBe("");
    const guided = app.querySelector(".dock-form textarea");
    if (guided instanceof HTMLTextAreaElement) expect(guided.value).toBe("");
    enterAgentChat();
    expect(isAgentChat()).toBe(true);
    expect(field().value).toBe("only in chat");
  }));
});

describe("async prompt results stay on the originating request", () => {
  test("stale reconciliation paints navigation when the current pane disappears", async () => await act(async () => {
    boot();
    let fail!: () => void;
    const session = live();
    setLive({
      ...session,
      promptAgent: () => new Promise((_, reject) => {
        fail = () => reject(new ProtocolError("unknown_outcome", "uncertain old request"));
      }),
      snapshot: async () => {
        const snapshot = await session.snapshot();
        return { ...snapshot, panes: snapshot.panes.filter((pane) => pane.pane_id !== "p2") };
      },
    });
    typeDraft("A request");
    clickSend();
    await openPane("p2");
    // On the mounted App the stale-reconciliation navigation renders the home
    // page through the App commit pipeline (the declarative path; no legacy
    // global renderer). Assert the navigation landed AND the home page is
    // actually composed, not just that the domain state changed.
    fail();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    expect(openPaneId()).toBe("");
    expect(currentScreen()).toBe("home");
    // The Home page is actually composed (reconcile removed p2, leaving p1's
    // herd card), and the agent chat unmounted.
    expect(app.querySelector(".page")).toBeTruthy();
    expect([...app.querySelectorAll(".herd-list .card-main")]).toHaveLength(1);
    expect([...app.querySelectorAll(".herd-list .card-name")].map((el) => el.textContent)).toEqual(["codex"]);
    expect(app.querySelector(".agent-chat-root")).toBeNull();
  }));

  for (const mode of ["agent", "guided"] as const) {
    for (const outcome of ["success", "conflict", "unknown_outcome"] as const) {
      test(`stale ${outcome} preserves the other pane's ${mode} composer`, async () => await act(async () => {
        boot();
        let finish!: () => void;
        let snapshots = 0;
        let sends = 0;
        const session = live();
        setLive({
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
        });
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
        expect(openPaneId()).toBe("p2");
        expect(operationBusy()).toBe(false);
        expect(composeIME()).toBe(true);
        expect(sends).toBe(1);
        expect(snapshots - priorReads).toBe(outcome === "unknown_outcome" ? 1 : 0);
      }));
    }
  }

  test("a delayed failure after A→B does not inject A's text or error into B", async () => await act(async () => {
    boot();
    let reject!: (error: Error) => void;
    let postedPane = "";
    setLive({
      ...live(),
      promptAgent: async (params: { pane_id: string }) => {
        postedPane = params.pane_id;
        return await new Promise((_, fail) => {
          reject = fail;
        });
      },
    });
    typeDraft("Prompt intended for pane A");
    commitView();
    clickSend();
    await Promise.resolve();
    expect(operationBusy()).toBe(true);
    expect(postedPane).toBe("p1");

    await openPane("p2");
    expect(operationBusy()).toBe(false);
    typeDraft("Draft belonging to pane B");
    const focusedBefore = document.activeElement;
    const failed = new ProtocolError("timeout", "audit delayed response for pane A");
    reject(failed);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(postedPane).toBe("p1");
    expect(openPaneId()).toBe("p2");
    expect(composeDraft()).toBe("Draft belonging to pane B");
    expect(field().value).toBe("Draft belonging to pane B");
    expect(trace().agentTraceNote).not.toContain("delayed response for pane A");
    expect(visibleNotice()).toBeNull();
    expect(operationBusy()).toBe(false);
    expect(document.activeElement).toBe(focusedBefore);
    expect(readStoredDraft({ daemonId: "daemon-a", paneId: "p1", mode: "agent" }).text).toBe(
      "Prompt intended for pane A",
    );

    await openPane("p1");
    expect(composeDraft()).toBe("Prompt intended for pane A");
    expect(field().value).toBe("Prompt intended for pane A");
    expect(readStoredDraft({ daemonId: "daemon-a", paneId: "p1", mode: "agent" }).error).toBe(messageOf(failed));
    expect(visibleNotice()).toBeNull();
  }));

  test("A pending then B IME input is not overwritten when A fails", async () => await act(async () => {
    boot();
    let reject!: (error: Error) => void;
    setLive({
      ...live(),
      promptAgent: async () =>
        await new Promise((_, fail) => {
          reject = fail;
        }),
    });
    typeDraft("Prompt intended for pane A");
    clickSend();
    await Promise.resolve();
    await openPane("p2");
    const input = field();
    input.focus();
    input.dispatchEvent(new happy.Event("compositionstart", { bubbles: true }));
    expect(composeIME()).toBe(true);
    input.value = "composed-on-B";
    input.setSelectionRange(4, 9);
    input.dispatchEvent(new happy.Event("input", { bubbles: true }));
    expect(composeDraft()).not.toBe("composed-on-B");
    const beforeValue = input.value;
    const beforeStart = input.selectionStart;
    const beforeEnd = input.selectionEnd;
    reject(new ProtocolError("timeout", "A failed during B composition"));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(openPaneId()).toBe("p2");
    expect(field()).toBe(input);
    expect(input.value).toBe(beforeValue);
    expect(input.selectionStart).toBe(beforeStart);
    expect(input.selectionEnd).toBe(beforeEnd);
    expect(composeIME()).toBe(true);
  }));

  test("a delayed success after A→B does not paint or focus B", async () => await act(async () => {
    boot();
    let resolvePrompt!: () => void;
    setLive({
      ...live(),
      promptAgent: async (params: { pane_id: string }) => {
        expect(params.pane_id).toBe("p1");
        await new Promise<void>((resolve) => {
          resolvePrompt = resolve;
        });
        return { outcome: "applied" };
      },
    });
    typeDraft("A submitted");
    clickSend();
    await Promise.resolve();
    await openPane("p2");
    expect(operationBusy()).toBe(false);
    typeDraft("B draft");
    resolvePrompt();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(openPaneId()).toBe("p2");
    expect(composeDraft()).toBe("B draft");
    expect(field().value).toBe("B draft");
    expect(trace().agentTracePending).toBe("");
    expect(operationBusy()).toBe(false);
  }));

  test("unknown_outcome after a pane switch does not restore the prompt for replay", async () => await act(async () => {
    boot();
    let reject!: (error: Error) => void;
    let promptCalls = 0;
    setLive({
      ...live(),
      promptAgent: async () => {
        promptCalls += 1;
        return await new Promise((_, fail) => {
          reject = fail;
        });
      },
    });
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
    expect(composeDraft()).toBe("B stays");
    expect(readStoredDraft({ daemonId: "daemon-a", paneId: "p1", mode: "agent" }).text).toBe("");
    expect(visibleNotice()).toBeNull();
    await openPane("p1");
    expect(composeDraft()).toBe("");
    expect(field().value).toBe("");
    expect(readStoredDraft({ daemonId: "daemon-a", paneId: "p1", mode: "agent" }).error).toBe(messageOf(unknown));
    expect(visibleNotice()).toBeNull();
  }));

  test("A→B→A while the request is in flight still owns the original pane", async () => await act(async () => {
    boot();
    let reject!: (error: Error) => void;
    setLive({
      ...live(),
      promptAgent: async () =>
        await new Promise((_, fail) => {
          reject = fail;
        }),
    });
    typeDraft("still A's prompt");
    clickSend();
    await Promise.resolve();
    await openPane("p2");
    expect(operationBusy()).toBe(false);
    await openPane("p1");
    expect(composeDraft()).toBe("");
    expect(operationBusy()).toBe(false);
    reject(new ProtocolError("timeout", "late A failure"));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(openPaneId()).toBe("p1");
    expect(composeDraft()).toBe("still A's prompt");
    expect(field().value).toBe("still A's prompt");
    expect(visibleNotice()).toBeNull();
    expect(operationBusy()).toBe(false);
  }));

  test("the same pane id on another computer does not take the original result", async () => await act(async () => {
    boot();
    let reject!: (error: Error) => void;
    const sessionA = liveSession();
    setLive({
      ...live(),
      promptAgent: async () =>
        await new Promise((_, fail) => {
          reject = fail;
        }),
    });
    typeDraft("computer A prompt");
    clickSend();
    await Promise.resolve();

    bumpViewIncarnation();
    setOperationBusy(false);
    setCredential(credential("daemon-b"));
    setLive({ ...live(), promptAgent: async () => ({ outcome: "applied" }) });
    setComposeDraft("computer B draft");
    commitView();

    reject(new ProtocolError("timeout", "computer A failed"));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(composeDraft()).toBe("computer B draft");
    expect(field().value).toBe("computer B draft");
    expect(trace().agentTraceNote).not.toContain("computer A failed");
    expect(readStoredDraft({ daemonId: "daemon-a", paneId: "p1", mode: "agent" }).text).toBe("computer A prompt");
    expect(sessionA).not.toBe(liveSession());
  }));

  test("agent→guided→agent while pending does not treat the new chat as live", async () => await act(async () => {
    boot();
    let reject!: (error: Error) => void;
    setLive({
      ...live(),
      promptAgent: async () =>
        await new Promise((_, fail) => {
          reject = fail;
        }),
    });
    typeDraft("mode switch prompt");
    clickSend();
    await Promise.resolve();
    leaveAgentChat();
    expect(isAgentChat()).toBe(false);
    expect(operationBusy()).toBe(false);
    enterAgentChat();
    expect(isAgentChat()).toBe(true);
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
    setLive({
      ...live(),
      promptAgent: async () => {
        await new Promise<void>((resolve) => {
          resolvePrompt = resolve;
        });
        return { outcome: "applied" };
      },
    });
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
    // Capture and restore both completion-seen keys so this case can never
    // overwrite a distinct legitimate value (or leave a seeded key behind).
    const keyA = `pairfob:completionSeen:daemon-a:phone_daemon-a`;
    const keyB = `pairfob:completionSeen:daemon-b:phone_daemon-b`;
    const priorA = localStorage.getItem(keyA);
    const priorB = localStorage.getItem(keyB);
    try {
    boot();
    setAgents([
      { paneId: "p1", agent: "codex", status: "idle" },
      { paneId: "p2", agent: "codex", status: "idle" },
    ]);
    // A has already acknowledged p1's completion before the in-flight submit.
    localStorage.setItem(keyA, JSON.stringify({ p1: true }));
    reloadCompletionSeen();
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
    setLive(sessionA);
    typeDraft("submit on A");
    clickSend();
    await Promise.resolve();

    setCredential(credential("daemon-b"));
    setLive(live());
    setAgents([
      { paneId: "p1", agent: "codex", status: "idle" },
      { paneId: "p2", agent: "codex", status: "idle" },
    ]);
    // B already acknowledged p1's completion before A's stale result resolves.
    localStorage.setItem(keyB, JSON.stringify({ p1: true }));
    reloadCompletionSeen();
    bumpViewIncarnation();

    resolvePrompt();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(liveAgents()[0]?.status).toBe("idle");
    expect(dashboardStore.get().completionSeen).toEqual({ p1: true });
    } finally {
      if (priorA === null) localStorage.removeItem(keyA); else localStorage.setItem(keyA, priorA);
      if (priorB === null) localStorage.removeItem(keyB); else localStorage.setItem(keyB, priorB);
    }
  }));

  test("establish parks the original computer's draft before changing identity", async () => await act(async () => {
    boot();
    setCredential(credential("draft-nav-a"));
    typeDraft("keep on computer A");
    const connect = async () => live() as never;
    await establish(credential("draft-nav-b") as never, connect);
    expect(readStoredDraft({ daemonId: "draft-nav-a", paneId: "p1", mode: "agent" }).text).toBe("keep on computer A");
    expect(readStoredDraft({ daemonId: "draft-nav-b", paneId: "p1", mode: "agent" }).text).toBe("");
  }));

  test("clearLiveConnection parks a full-terminal draft before disposing the mode", async () => await act(async () => {
    boot();
    setAgentChat(false);
    setFullTerminal(true);
    setComposeDraft("full draft stays with full");
    clearLiveConnection();
    expect(readStoredDraft({ daemonId: "daemon-a", paneId: "p1", mode: "full" }).text).toBe("full draft stays with full");
    expect(readStoredDraft({ daemonId: "daemon-a", paneId: "p1", mode: "guided" }).text).toBe("");
  }));

  test("openSettings then openComputers still parks the pane draft for establish", async () => await act(async () => {
    boot();
    typeDraft("keep through settings");
    openSettings();
    await Promise.resolve();
    expect(currentScreen()).toBe("settings");
    expect(readStoredDraft({ daemonId: "daemon-a", paneId: "p1", mode: "agent" }).text).toBe("keep through settings");
    openComputers();
    expect(currentScreen()).toBe("computers");
    const connect = async () => live() as never;
    await establish(credential("draft-nav-b") as never, connect);
    expect(readStoredDraft({ daemonId: "daemon-a", paneId: "p1", mode: "agent" }).text).toBe("keep through settings");
    expect(readStoredDraft({ daemonId: "draft-nav-b", paneId: "p1", mode: "agent" }).text).toBe("");
  }));

  test("returning from settings does not give a pending send DOM ownership", async () => await act(async () => {
    boot();
    happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
    let reject!: (error: Error) => void;
    setLive({
      ...live(),
      promptAgent: async () =>
        await new Promise((_, fail) => {
          reject = fail;
        }),
    });
    typeDraft("pending through settings");
    clickSend();
    await Promise.resolve();
    const incarnation = currentViewIncarnation();
    openSettings();
    await Promise.resolve();
    await Promise.resolve();
    expect(currentScreen()).toBe("settings");
    expect(operationBusy()).toBe(false);
    const back = app.querySelector(".back");
    if (!(back instanceof HTMLButtonElement)) throw new Error("missing settings back");
    back.click();
    expect(currentScreen()).toBe("pane");
    expect(currentViewIncarnation()).toBeGreaterThan(incarnation);
    const failed = new ProtocolError("timeout", "stale after settings");
    reject(failed);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(visibleNotice()).toBeNull();
    expect(promptRequestIsLive({
      session: liveSession()!,
      viewIncarnation: incarnation,
      lockId: 0,
      revision: 0,
      noticeScope: { phase: "live", screen: "pane", daemonId: "daemon-a", paneId: "p1" },
      draftScope: { daemonId: "daemon-a", paneId: "p1", mode: "agent" },
      text: "pending through settings",
    })).toBe(false);
  }));
});
