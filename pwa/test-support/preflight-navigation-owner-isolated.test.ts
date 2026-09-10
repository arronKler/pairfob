// Runs in its OWN bun test process (spawned from src/app/preflight-navigation-owner.test.tsx).
// This file intentionally lives in test-support/ so it is never collected by the
// default `bun test src` suite: it stubs the shared-ESM full-terminal loader with
// mock.module, which is process-global in bun. A module mock cannot be undone by
// mock.restore and must not share a process with any real-loader control, so the
// full fixture is executed only inside this isolated child process.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { happy, resetBoardTestDOM } from "./dom";
import { closeTestDialogs } from "./close-dialogs";
import { batch } from "../src/shared/model/domain-store";
import { appRoot } from "../src/app/dom-root";
import { appHost, commitView } from "../src/app/host";
import { isAppMounted, mountApp, unmountApp } from "../src/app/mount";
import { registerSessionOwnerPreparer } from "../src/app/frame";
import { registerSessionView } from "../src/features/session/register";
import { resetTransitionState } from "../src/app/transition";

class TestTerminal {
  cols = 80;
  rows = 24;
  modes = { applicationCursorKeysMode: false };
  options: {
    fontSize?: number;
    lineHeight?: number;
    letterSpacing?: number;
  };
  _core = { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } };
  private root: HTMLElement | null = null;

  constructor(options: {
    fontSize?: number;
    lineHeight?: number;
    letterSpacing?: number;
  }) {
    this.options = { ...options };
  }

  loadAddon(_addon: object): void { }
  open(mount: HTMLElement): void {
    this.root = document.createElement("div");
    this.root.className = "xterm";
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    screen.append(document.createElement("canvas"));
    const input = document.createElement("textarea");
    input.className = "xterm-helper-textarea";
    this.root.append(screen, input);
    mount.append(this.root);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  registerLinkProvider(_provider: object): void { }
  onData(_listener: (value: string) => void): void { }
  onBinary(_listener: (value: string) => void): void { }
  onResize(_listener: () => void): void { }
  input(_value: string): void { }
  focus(): void { }
  reset(): void { }
  write(_data: Uint8Array, done?: () => void): void { done?.(); }
  dispose(): void { this.root?.remove(); }
}
class TestFitAddon {
  fit(): void { }
}
class TestWebglAddon {
  onContextLoss(_listener: () => void): void { }
}

// Stub the loader at its REAL feature path (features/session/full-terminal/
// full-terminal-loader.ts). The old ui-react fixture mocked a stale shim that
// the feature module does not import, so the genuine full-terminal create never
// reached the live stage.
mock.module("../src/features/session/full-terminal/full-terminal-loader", () => ({
  fullTerminalSupported: () => true,
  terminalWebglSupported: () => true,
  loadFullTerminalXterm: async () => ({
    Terminal: TestTerminal,
    FitAddon: TestFitAddon,
    WebglAddon: TestWebglAddon,
  }),
  preloadFullTerminalXterm: () => { },
}));

// Direct real owners; no root/state/full-terminal compatibility shims. The mocks
// are registered above before any of these modules (which transitively import
// the loader) load.
const { closePane, createSelectedTab } = await import("../src/features/operations/controller");
const { disposeFullTerminal, leaveFullTerminal } = await import("../src/features/session/full-terminal/full-terminal");
const { resetComposeDrafts, bumpViewIncarnation, adoptScreen, switchComposeView } = await import("../src/features/session/drafts/compose-drafts");
const { setLang, t } = await import("../src/lib/i18n");
const { submitAgentPrompt } = await import("../src/features/session/chat/agent-chat-controller");
const { NO_OPERATION_CAPABILITIES } = await import("../src/lib/operations");
type LiveSession = import("../src/lib/protocol/session-types").LiveSession;
const { setPhase, setNetworkOnline } = await import("../src/features/connection/connection-store");
const { setScreen, currentScreen } = await import("../src/app/navigation-store");
const { applyCapabilities, operationBusy, setOperationBusy } = await import("../src/features/operations/capabilities-store");
const { attachLiveSession, liveSession, setCredential } = await import("../src/features/computers/catalog-store");
const { replaceAgentsFromSnapshot } = await import("../src/features/dashboard/catalog-store");
const { selectPane, resetPaneView, setAgentChat, setFullTerminal, setTermSelect, openPaneId, applyPaneRead } = await import("../src/features/session/session-store");
const { setComposeLive, setComposeDraft } = await import("../src/features/session/compose-store");
const { applyTrace, clearPendingTurn, setTraceLoadState } = await import("../src/features/session/chat/trace-store");
const { chatStore } = await import("../src/features/session/chat/trace-store");
const { setDefaultTermMode, setPaneTermMode } = await import("../src/features/settings/preferences-store");
const { setBoardReturn } = await import("../src/features/board/layout-store");
const { visibleNotice } = await import("../src/app/notices-store");

type ProbeCard = Omit<import("../src/lib/dashboard").AgentCard, "status"> & { status: "idle" };
const card: ProbeCard = { paneId: "p1", agent: "codex", status: "idle", hasAgent: true, workspaceLabel: "review", cwd: "/review", workspaceId: "w1", tabId: "t1" };
type ProbeSession = LiveSession & { calls: string[] };
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function session(): ProbeSession {
  const calls: string[] = [];
  return {
    calls,
    isConnected: () => true,
    snapshot: async () => { calls.push("snapshot"); return { panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "t1", agent: "codex" }, { pane_id: "p2", workspace_id: "w1", tab_id: "t2", agent: "codex" }] }; },
    paneRead: async (id: string) => { calls.push("read:" + id); return { text: "ready", hash: "1".repeat(64) }; },
    terminalOpen: async (paneId: string, cols: number, rows: number) => ({ operationId: "op_AAECAwQFBgcICQoL", terminalId: "term_11111111111111111111111111111111", paneId, cols, rows, encoding: "ansi" as const }),
    terminalClose: async (_id: string) => { calls.push("terminal-close"); },
    terminalInput: async () => { }, terminalResize: async () => { }, terminalScroll: async () => { },
    closePane: async (id: string) => { calls.push("close:" + id); },
    createTab: async (_input: unknown) => { calls.push("create"); return { pane_id: "p2" } as { pane_id?: string }; },
    promptAgent: async () => ({ outcome: "applied" } as const), agentTrace: async () => ({ items: [], nextCursor: null, truncated: false }),
    sendText: async () => { }, sendKeys: async () => { }, onEvent: () => () => { }, reconnectNow: () => { }, close: () => { },
  } as unknown as ProbeSession;
}

function boot(live: ProbeSession = session(), full = true): ProbeSession {
  act(() => {
    // Retire any PREVIOUS scene's terminal inside this act boundary: teardown
    // publishes the terminal view (resetFullTerminalView -> publishFullTerminalView)
    // and must not land outside act.
    disposeFullTerminal();
    batch(() => {
      setPhase("live"); setScreen("pane"); selectPane("p1"); resetPaneView();
      setFullTerminal(full); setAgentChat(false); setComposeLive(false); setTermSelect(false);
      setNetworkOnline(true); setCredential(null);
      setOperationBusy(false);
      setDefaultTermMode("guided"); setBoardReturn(false);
      applyCapabilities({ ...NO_OPERATION_CAPABILITIES, create_tab: true }, []);
      attachLiveSession(live);
      replaceAgentsFromSnapshot({
        focused: { workspace_id: "w1", tab_id: "t1", pane_id: "p1" },
        workspaces: [{ workspace_id: "w1", label: "review", cwd: "/review" }],
        tabs: [{ tab_id: "t1", workspace_id: "w1", label: "r" }],
        panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "t1", cwd: "/review", agent: "codex", agent_status: "working" }],
      });
      applyPaneRead("ready", "1".repeat(64));
      setPaneTermMode("p1", full ? "full" : "guided");
    });
    bumpViewIncarnation();
    commitView();
  });
  return live;
}

async function settle(update?: () => void): Promise<void> {
  await act(async () => { update?.(); await new Promise<void>((r) => window.setTimeout(r, 0)); });
}
async function until(p: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (p()) return;
    await settle();
  }
  throw new Error("fixture did not settle");
}
async function startCreate(): Promise<{ task: Promise<void> }> {
  let task!: Promise<void>;
  act(() => { task = createSelectedTab(card); });
  await settle(() => {
    document.querySelector<HTMLFormElement>("dialog.operation-modal form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });
  return { task };
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  resetComposeDrafts();
  resetTransitionState();
  // Production binds the session feature's owner adoption on the frame seam
  // before the first mount; the real App prepares pane ownership through it.
  registerSessionOwnerPreparer(registerSessionView);
  act(() => mountApp());
});
afterEach(async () => {
  await act(async () => {
    closeTestDialogs();
    disposeFullTerminal();
    attachLiveSession(null);
    await leaveFullTerminal({ rememberGuided: false, paint: false }).catch(() => undefined);
    unmountApp();
    registerSessionOwnerPreparer(null);
    resetTransitionState();
    setScreen("home");
    setOperationBusy(false);
    await happy.happyDOM.abort();
  });
  expect(appHost()).toBeNull();
  expect(isAppMounted()).toBeFalse();
});

test("create result waiting for old full-terminal leave cannot navigate a replacement session", async () => {
  const gate = deferred<void>();
  const old = session();
  old.terminalClose = async () => { old.calls.push("terminal-close"); await gate.promise; };
  boot(old);
  await until(() => appRoot().querySelector('.full-terminal-state[data-stage="live"]') !== null);
  const { task } = await startCreate();
  await until(() => old.calls.includes("terminal-close"));
  const newer = session();
  boot(newer, false);
  await act(async () => { gate.resolve(); await task; });
  expect(liveSession() === newer).toBeTrue();
  expect({ paneId: openPaneId(), calls: newer.calls }).toEqual({ paneId: "p1", calls: [] });
});
test("create result waiting for terminal leave cannot replace later same-computer settings navigation", async () => {
  const gate = deferred<void>();
  const live = session();
  live.terminalClose = async () => { live.calls.push("terminal-close"); await gate.promise; };
  boot(live);
  await until(() => appRoot().querySelector('.full-terminal-state[data-stage="live"]') !== null);
  const { task } = await startCreate();
  await until(() => live.calls.includes("terminal-close"));
  act(() => { adoptScreen("settings"); commitView(); });
  await act(async () => { gate.resolve(); await task; });
  expect(currentScreen()).toBe("settings");
});
test("normal full-terminal create transfers ownership and keeps its success notice", async () => {
  const live = session();
  boot(live);
  await until(() => appRoot().querySelector('.full-terminal-state[data-stage="live"]') !== null);
  const { task } = await startCreate();
  await act(async () => { await task; });
  expect(openPaneId()).toBe("p2");
  expect(visibleNotice()?.text).toBe(t("op.createdTab"));
  expect(operationBusy()).toBeFalse();
});
async function confirmDanger(): Promise<void> {
  await settle(() => { document.querySelector<HTMLButtonElement>("dialog[data-react-modal] .btn-danger")!.click(); });
}
function enterChat(text: string): void {
  switchComposeView(() => { setAgentChat(true); setFullTerminal(false); });
  setComposeDraft(text);
  applyTrace({ agentTraceItems: [], agentTraceTail: 0 });
  clearPendingTurn();
  setTraceLoadState("ready");
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, create_tab: true, prompt_agent: true, history: true }, []);
  commitView();
}
test("normal full close stays busy through terminal retirement and the pane RPC", async () => {
  const terminal = deferred<void>();
  const pane = deferred<void>();
  const live = session();
  live.terminalClose = async () => { live.calls.push("terminal-close"); await terminal.promise; };
  live.closePane = async () => { live.calls.push("close:p1"); await pane.promise; };
  boot(live);
  await until(() => appRoot().querySelector('.full-terminal-state[data-stage="live"]') !== null);
  let task!: Promise<void>;
  act(() => { task = closePane(card); });
  await confirmDanger();
  expect(live.calls.filter((x) => x.startsWith("close"))).toEqual([]);
  expect(operationBusy()).toBeTrue();
  await settle(() => terminal.resolve());
  await until(() => live.calls.includes("close:p1"));
  expect(operationBusy()).toBeTrue();
  await act(async () => { pane.resolve(); await task; });
  expect(operationBusy()).toBeFalse();
  expect(currentScreen()).toBe("home");
  expect(visibleNotice()?.text).toBe(t("op.closedPane"));
});
test("retired chat prompt cannot release the newer create lane busy lock", async () => {
  const prompt = deferred<void>();
  const create = deferred<void>();
  const live = session();
  live.promptAgent = async () => { live.calls.push("prompt"); await prompt.promise; return { outcome: "applied" }; };
  live.agentTrace = async () => ({ items: [], nextCursor: null, truncated: false });
  live.createTab = async () => { live.calls.push("create"); await create.promise; return {}; };
  boot(live, false);
  act(() => { enterChat("old prompt"); });
  let sending!: Promise<void>;
  act(() => { sending = submitAgentPrompt(); });
  expect(operationBusy()).toBeTrue();
  expect(live.calls).toContain("prompt");
  act(() => { switchComposeView(() => { setAgentChat(false); }); commitView(); });
  const { task } = await startCreate();
  expect(operationBusy()).toBeTrue();
  const pending = visibleNotice();
  await act(async () => { prompt.resolve(); await sending; });
  expect(operationBusy()).toBeTrue();
  expect(visibleNotice() === pending).toBeTrue();
  await act(async () => { create.resolve(); await task; });
  expect(operationBusy()).toBeFalse();
});
test("retired create lane cannot release the newer chat prompt busy lock", async () => {
  const prompt = deferred<void>();
  const create = deferred<void>();
  const live = session();
  live.promptAgent = async () => { live.calls.push("prompt"); await prompt.promise; return { outcome: "applied" }; };
  live.agentTrace = async () => ({ items: [], nextCursor: null, truncated: false });
  live.createTab = async () => { live.calls.push("create"); await create.promise; return {}; };
  boot(live, false);
  const { task } = await startCreate();
  expect(operationBusy()).toBeTrue();
  act(() => enterChat("new prompt"));
  let sending!: Promise<void>;
  act(() => { sending = submitAgentPrompt(); });
  expect(operationBusy()).toBeTrue();
  await act(async () => { create.resolve(); await task; });
  expect(operationBusy()).toBeTrue();
  expect(chatStore.get().agentTracePending).toBe("new prompt");
  await act(async () => { prompt.resolve(); await sending; });
  expect(operationBusy()).toBeFalse();
});

// The stable mount host is observed indirectly through the live-stage and
// navigation assertions (no re-root across session replacement).