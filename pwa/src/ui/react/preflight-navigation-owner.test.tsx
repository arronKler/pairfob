import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { resetBoardTestDOM } from "../../../test-support/dom";
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
mock.module("../full-terminal-loader", () => ({
    fullTerminalSupported: () => true, terminalWebglSupported: () => true,
    loadFullTerminalXterm: async () => ({ Terminal: TestTerminal, FitAddon: TestFitAddon, WebglAddon: TestWebglAddon }),
    preloadFullTerminalXterm: () => { },
}));
const { app, state, setPaneTermMode } = await import("../../state");
const { setRenderer } = await import("../../paint");
const { closePane, createSelectedTab } = await import("../../live-operations");
const { renderApp } = await import("./app-screen");
const { leaveReactScreen } = await import("./root");
const { disposeFullTerminal, leaveFullTerminal } = await import("../full-terminal");
const { closeTestDialogs } = await import("../../../test-support/close-dialogs");
const { resetComposeDrafts, bumpViewIncarnation, adoptScreen, switchComposeView } = await import("../../compose-drafts");
const { setLang, t } = await import("../../lib/i18n");
const { submitAgentPrompt } = await import("../agent-chat-controller");
const card = { paneId: "p1", agent: "codex", status: "idle", hasAgent: true, workspaceLabel: "review", cwd: "/review", workspaceId: "w1", tabId: "t1" };
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; }
function session() {
    const calls: string[] = [];
    return { calls, isConnected: () => true,
        snapshot: async () => { calls.push("snapshot"); return { panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "t1", agent: "codex" }, { pane_id: "p2", workspace_id: "w1", tab_id: "t2", agent: "codex" }] }; },
        paneRead: async (id: string) => { calls.push("read:" + id); return { text: "ready", hash: "1".repeat(64) }; },
        terminalOpen: async (paneId: string, cols: number, rows: number) => ({ operationId: "op_AAECAwQFBgcICQoL", terminalId: "term_11111111111111111111111111111111", paneId, cols, rows, encoding: "ansi" as const }),
        terminalClose: async (_id: string) => { calls.push("terminal-close"); },
        terminalInput: async () => { }, terminalResize: async () => { }, terminalScroll: async () => { },
        closePane: async (id: string) => { calls.push("close:" + id); },
        createTab: async (_input: unknown) => { calls.push("create"); return { pane_id: "p2" } as {
            pane_id?: string;
        }; },
        promptAgent: async () => ({ outcome: "applied" }), agentTrace: async () => ({ items: [], nextCursor: null, truncated: false }),
        sendText: async () => { }, sendKeys: async () => { }, onEvent: () => () => { }, reconnectNow: () => { }, close: () => { },
    };
}
function boot(live = session(), full = true) {
    disposeFullTerminal();
    Object.assign(state, { phase: "live", screen: "pane", paneId: "p1", live, agents: [{ ...card }], paneText: "ready", paneHash: "1".repeat(64), fullTerminal: full, agentChat: false, composeLive: false, composeDraft: "", termSelect: false, networkOnline: true, operationBusy: false, refreshBusy: false, defaultTermMode: "guided", boardReturn: false });
    state.operationCapabilities = { ...state.operationCapabilities, create_tab: true };
    state.paneTermModes = {};
    setPaneTermMode("p1", full ? "full" : "guided");
    bumpViewIncarnation();
    renderApp();
    return live;
}
async function settle(update?: () => void) { await act(async () => { update?.(); await new Promise<void>(r => window.setTimeout(r, 0)); }); }
async function until(p: () => boolean) { for (let i = 0; i < 50; i++) {
    if (p())
        return;
    await settle();
} throw new Error("fixture did not settle"); }
async function startCreate() {
    let task!: Promise<void>;
    act(() => { task = createSelectedTab(card); });
    await settle(() => { document.querySelector<HTMLFormElement>("dialog.operation-modal form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
    return { task };
}
beforeEach(async () => { await resetBoardTestDOM(); setLang("zh"); resetComposeDrafts(); state.credential = null; state.composeIME = false; state.composeFocused = false; setRenderer(renderApp); });
afterEach(async () => { await act(async () => { closeTestDialogs(); disposeFullTerminal(); leaveReactScreen(); await Promise.resolve(); }); state.live = null; state.paneId = ""; state.screen = "home"; state.operationBusy = false; setRenderer(() => { }); });
test("create result waiting for old full-terminal leave cannot navigate a replacement session", async () => {
    const gate = deferred<void>();
    const old = session();
    old.terminalClose = async () => { old.calls.push("terminal-close"); await gate.promise; };
    act(() => boot(old));
    await until(() => app.querySelector('.full-terminal-state[data-stage="live"]') !== null);
    const { task } = await startCreate();
    await until(() => old.calls.includes("terminal-close"));
    const newer = session();
    act(() => boot(newer, false));
    await act(async () => { gate.resolve(); await task; });
    expect(state.live === newer).toBeTrue();
    expect({ paneId: state.paneId, calls: newer.calls }).toEqual({ paneId: "p1", calls: [] });
});
test("create result waiting for terminal leave cannot replace later same-computer settings navigation", async () => {
    const gate = deferred<void>();
    const live = session();
    live.terminalClose = async () => { live.calls.push("terminal-close"); await gate.promise; };
    act(() => boot(live));
    await until(() => app.querySelector('.full-terminal-state[data-stage="live"]') !== null);
    const { task } = await startCreate();
    await until(() => live.calls.includes("terminal-close"));
    act(() => { adoptScreen("settings"); renderApp(); });
    await act(async () => { gate.resolve(); await task; });
    expect(state.screen).toBe("settings");
});
test("normal full-terminal create transfers ownership and keeps its success notice", async () => {
    const live = session();
    act(() => boot(live));
    await until(() => app.querySelector('.full-terminal-state[data-stage="live"]') !== null);
    const { task } = await startCreate();
    await act(async () => { await task; });
    expect(state.paneId).toBe("p2");
    expect(state.notice?.text).toBe(t("op.createdTab"));
    expect(state.operationBusy).toBeFalse();
});
async function confirmDanger() { await settle(() => { document.querySelector<HTMLButtonElement>("dialog[data-react-modal] .btn-danger")!.click(); }); }
function enterChat(text: string) { switchComposeView(() => { state.agentChat = true; state.fullTerminal = false; }); state.composeDraft = text; state.agentTraceItems = []; state.agentTracePending = ""; state.agentTracePendingBase = []; state.agentTraceLoadState = "ready"; state.operationCapabilities = { ...state.operationCapabilities, prompt_agent: true, history: true }; renderApp(); }
test("normal full close stays busy through terminal retirement and the pane RPC", async () => {
    const terminal = deferred<void>();
    const pane = deferred<void>();
    const live = session();
    live.terminalClose = async () => { live.calls.push("terminal-close"); await terminal.promise; };
    live.closePane = async () => { live.calls.push("close:p1"); await pane.promise; };
    act(() => boot(live));
    await until(() => app.querySelector('.full-terminal-state[data-stage="live"]') !== null);
    let task!: Promise<void>;
    act(() => { task = closePane(card); });
    await confirmDanger();
    expect(live.calls.filter(x => x.startsWith("close"))).toEqual([]);
    expect(state.operationBusy).toBeTrue();
    await settle(() => terminal.resolve());
    await until(() => live.calls.includes("close:p1"));
    expect(state.operationBusy).toBeTrue();
    await act(async () => { pane.resolve(); await task; });
    expect(state.operationBusy).toBeFalse();
    expect(state.screen).toBe("home");
    expect(state.notice?.text).toBe(t("op.closedPane"));
});
test("retired chat prompt cannot release the newer create lane busy lock", async () => {
    const prompt = deferred<void>();
    const create = deferred<void>();
    const live = session();
    live.promptAgent = async () => { live.calls.push("prompt"); await prompt.promise; return { outcome: "applied" }; };
    live.agentTrace = async () => ({ items: [], nextCursor: null, truncated: false });
    live.createTab = async () => { live.calls.push("create"); await create.promise; return {}; };
    act(() => { boot(live, false); enterChat("old prompt"); });
    let sending!: Promise<void>;
    act(() => { sending = submitAgentPrompt(); });
    expect(state.operationBusy).toBeTrue();
    expect(live.calls).toContain("prompt");
    act(() => { switchComposeView(() => { state.agentChat = false; }); renderApp(); });
    const { task } = await startCreate();
    expect(state.operationBusy).toBeTrue();
    const pending = state.notice;
    await act(async () => { prompt.resolve(); await sending; });
    expect(state.operationBusy).toBeTrue();
    expect(state.notice === pending).toBeTrue();
    await act(async () => { create.resolve(); await task; });
    expect(state.operationBusy).toBeFalse();
});
test("retired create lane cannot release the newer chat prompt busy lock", async () => {
    const prompt = deferred<void>();
    const create = deferred<void>();
    const live = session();
    live.promptAgent = async () => { live.calls.push("prompt"); await prompt.promise; return { outcome: "applied" }; };
    live.agentTrace = async () => ({ items: [], nextCursor: null, truncated: false });
    live.createTab = async () => { live.calls.push("create"); await create.promise; return {}; };
    act(() => boot(live, false));
    const { task } = await startCreate();
    expect(state.operationBusy).toBeTrue();
    act(() => enterChat("new prompt"));
    let sending!: Promise<void>;
    act(() => { sending = submitAgentPrompt(); });
    expect(state.operationBusy).toBeTrue();
    await act(async () => { create.resolve(); await task; });
    expect(state.operationBusy).toBeTrue();
    expect(state.agentTracePending).toBe("new prompt");
    await act(async () => { prompt.resolve(); await sending; });
    expect(state.operationBusy).toBeFalse();
});
