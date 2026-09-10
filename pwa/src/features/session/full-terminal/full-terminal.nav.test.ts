import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { lang, setLang } from "../../../lib/i18n";
import type { LiveSession } from "../../../lib/protocol/client";

let visibility: DocumentVisibilityState = "visible";
let baselineLang: ReturnType<typeof lang> = "zh";

class TestTerminal {
  cols = 80;
  rows = 24;
  modes = { applicationCursorKeysMode: false };
  options: { fontSize?: number; lineHeight?: number; letterSpacing?: number };
  _core = { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } };
  private root: HTMLElement | null = null;

  constructor(options: { fontSize?: number; lineHeight?: number; letterSpacing?: number }) {
    this.options = { ...options };
  }

  loadAddon(_addon: object): void {}

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

  registerLinkProvider(_provider: object): void {}
  onData(_listener: (value: string) => void): void {}
  onBinary(_listener: (value: string) => void): void {}
  onResize(_listener: () => void): void {}
  input(_value: string): void {}
  focus(): void {}
  reset(): void {}
  write(_data: Uint8Array, done?: () => void): void { done?.(); }
  dispose(): void { this.root?.remove(); }
}

class TestFitAddon {
  fit(): void {}
}

class TestWebglAddon {
  onContextLoss(_listener: () => void): void {}
}

mock.module("./full-terminal-loader", () => ({
  fullTerminalSupported: () => true,
  terminalWebglSupported: () => true,
  loadFullTerminalXterm: async () => ({
    Terminal: TestTerminal,
    FitAddon: TestFitAddon,
    WebglAddon: TestWebglAddon,
  }),
  preloadFullTerminalXterm: () => {},
}));

const { appRoot } = await import("../../../app/dom-root.ts");
const app = appRoot();
const { batch } = await import("../../../shared/model/domain-store.ts");
const { appHost, commitView } = await import("../../../app/host.ts");
const { isAppMounted, mountApp, unmountApp } = await import("../../../app/mount.tsx");
const { registerSessionOwnerPreparer } = await import("../../../app/frame.ts");
const { registerSessionView } = await import("../../../features/session/register.ts");
const { resetTransitionState } = await import("../../../app/transition.ts");
const { setPhase, setNetworkOnline } = await import("../../connection/connection-store.ts");
const { currentScreen, setScreen } = await import("../../../app/navigation-store.ts");
const {
  applyPaneRead, isFullTerminal, openPaneId, resetPaneView, selectPane, setAgentChat, setFullTerminal,
} = await import("../session-store.ts");
const { composeDraft, composeLive, setComposeDraft, setComposeLive } =
  await import("../compose-store.ts");
const { attachLiveSession } = await import("../../computers/catalog-store.ts");
const { applySnapshot } = await import("../../dashboard/catalog-store.ts");
const {
  keysExpanded, paneComposeLive, paneTermMode, setKeysExpanded, setPaneTermMode, termCols,
} = await import("../../settings/preferences-store.ts");
const { openPane } = await import("../../../features/connection/controller.ts");
const { goBackFromPane } = await import("../pane-actions.ts");
const {
  disposeFullTerminal,
  enterFullTerminal,
  handleFullTerminalEvent,
  handleFullTerminalVisibility,
  leaveFullTerminal,
  setFullTerminalComposeLive,
  setTermFit,
} = await import("./full-terminal.ts");
const { resetComposeDrafts } = await import("../drafts/compose-drafts.ts");

const DRAFT = "keep-draft";

function live(): LiveSession {
  return {
    terminalOpen: (_paneId: string, _cols: number, _rows: number) => new Promise(() => undefined),
    terminalClose: async () => undefined,
    terminalInput: async () => undefined,
    terminalResize: async () => undefined,
    terminalScroll: async () => undefined,
    sendText: async () => undefined,
    sendKeys: async () => undefined,
    isConnected: () => true,
    onEvent: () => () => undefined,
    reconnectNow: () => undefined,
    close: () => undefined,
  } as unknown as LiveSession;
}

const DEMO_WORKSPACES = [{ workspace_id: "w1", label: "demo", cwd: "/tmp/demo" }] as const;

function paneCard(paneId: string, status = "idle") {
  return { pane_id: paneId, workspace_id: "w1", agent: "herdr", agent_status: status };
}

// The actual stable App owns composition: typed domain actions publish through
// the installed host's synchronous commitView port. No paint host, no facade
// writes, no manual flush.
function publishDemoPanes(panes: ReadonlyArray<ReturnType<typeof paneCard>>): void {
  applySnapshot({ focused: { pane_id: panes[0]?.pane_id }, workspaces: DEMO_WORKSPACES, panes });
}

function bootFullTerminal(session: LiveSession = live()): void {
  act(() => {
    disposeFullTerminal();
    batch(() => {
      setPhase("live");
      setScreen("pane");
      selectPane("p1");
      resetPaneView();
      applyPaneRead("ready", "h-ready");
      setComposeDraft(DRAFT);
      setComposeLive(false);
      setFullTerminal(true);
      setAgentChat(false);
      setNetworkOnline(true);
      attachLiveSession(session);
      publishDemoPanes([paneCard("p1")]);
      setPaneTermMode("p1", "full");
    });
    commitView();
  });
}

function click(selector: string): void {
  const el = app.querySelector(selector);
  if (!(el instanceof HTMLButtonElement)) throw new Error(`missing ${selector}: ${app.innerHTML.slice(0, 200)}`);
  act(() => el.click());
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 10)); });
  }
  throw new Error(`timed out waiting for ${label}`);
}

beforeEach(async () => {
  await resetBoardTestDOM();
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  resetTransitionState();
  resetComposeDrafts();
  baselineLang = lang();
  setLang("zh");
  registerSessionOwnerPreparer(registerSessionView);
  // The stable declarative App commits through the host; no legacy renderer.
  act(() => mountApp());
});

afterEach(async () => {
  await act(async () => {
    visibility = "visible";
    await leaveFullTerminal({ rememberGuided: false, paint: false });
    disposeFullTerminal();
    resetComposeDrafts();
    unmountApp();
    setLang(baselineLang);
    registerSessionOwnerPreparer(null);
    attachLiveSession(null);
    resetTransitionState();
    await happy.happyDOM.abort();
  });
  expect(appHost()).toBeNull();
  expect(isAppMounted()).toBeFalse();
});

describe("complete-terminal remembers its mode per pane", () => {
  test("‹ returns to the session list and keeps complete-terminal as the pane mode", async () => {
    bootFullTerminal();
    expect(app.querySelector(".full-terminal-root")).toBeTruthy();
    expect((app.querySelector(".dock")) === null).toBeTrue();
    expect(app.querySelector(".full-terminal-pad")).toBeTruthy();
    expect(app.querySelector('.full-terminal-pad [aria-label="上箭头"]')).toBeTruthy();
    click(".full-terminal-chrome .back");
    await act(async () => { await leaveFullTerminal({ rememberGuided: false, paint: false }); });
    await act(async () => { await Promise.resolve(); });
    expect(isFullTerminal()).toBe(false);
    expect(currentScreen()).toBe("home");
    expect(paneTermMode("p1")).toBe("full");
    expect((app.querySelector(".full-terminal-root")) === null).toBeTrue();
  });

  test("reopening the pane restores complete-terminal", async () => {
    bootFullTerminal();
    click(".full-terminal-chrome .back");
    await act(async () => { await leaveFullTerminal({ rememberGuided: false, paint: false }); });
    await act(async () => { await Promise.resolve(); });
    expect(currentScreen()).toBe("home");
    await act(async () => { await openPane("p1"); });
    expect(isFullTerminal()).toBe(true);
    expect(app.querySelector(".full-terminal-root")).toBeTruthy();
    expect((app.querySelector(".dock")) === null).toBeTrue();
  });

  test("reopening the same pane remounts xterm after a paintless leave", async () => {
    const openedPanes: string[] = [];
    const session = live();
    session.terminalOpen = async (paneId, cols, rows) => {
      openedPanes.push(paneId);
      return {
        operationId: "op_AAECAwQFBgcICQoL",
        terminalId: `term_${String(openedPanes.length).padStart(32, "1")}`,
        paneId,
        cols,
        rows,
        encoding: "ansi" as const,
      };
    };
    bootFullTerminal(session);
    await waitUntil(() => openedPanes.length === 1, "first same-pane terminal open");

    await act(async () => { await openPane("p1"); });
    await waitUntil(() => openedPanes.length === 2, "second same-pane terminal open");

    expect(openedPanes).toEqual(["p1", "p1"]);
    expect(app.querySelector(".full-terminal-root .xterm")).toBeTruthy();
  });

  test("switching between full-terminal panes mounts the new pane without a paused error", async () => {
    const openedPanes: string[] = [];
    let closeCalls = 0;
    let closeRequested = false;
    let resolveClose = () => {};
    const session = live();
    session.terminalOpen = async (paneId, cols, rows) => {
      openedPanes.push(paneId);
      return {
        operationId: "op_AAECAwQFBgcICQoL",
        terminalId: `term_${String(openedPanes.length).padStart(32, "1")}`,
        paneId,
        cols,
        rows,
        encoding: "ansi" as const,
      };
    };
    session.terminalClose = () => {
      closeCalls++;
      closeRequested = true;
      if (closeCalls > 1) return Promise.resolve();
      return new Promise<void>((resolve) => { resolveClose = resolve; });
    };
    bootFullTerminal(session);
    act(() => {
      publishDemoPanes([paneCard("p1"), paneCard("p2")]);
      setPaneTermMode("p2", "full");
    });
    await waitUntil(() => openedPanes.length === 1, "first pane terminal open");

    let switching!: Promise<void>;
    act(() => { switching = openPane("p2"); });
    await waitUntil(() => closeRequested, "first pane terminal close");
    await act(async () => {
      resolveClose();
      // Inspect the original one-microtask handoff before act drains the new mount.
      await Promise.resolve();
      const closingStatus = app.querySelector<HTMLElement>(".full-terminal-state");
      expect(closingStatus?.dataset.stage).toBe("live");
      expect(closingStatus?.textContent).not.toContain("终端连接已暂停");
      await switching;
    });
    await waitUntil(() => openedPanes.length === 2, "second pane terminal open");

    expect(openedPanes).toEqual(["p1", "p2"]);
    expect(openPaneId()).toBe("p2");
    expect(app.querySelector<HTMLElement>(".full-terminal-root")?.dataset.paneId).toBe("p2");
    const status = app.querySelector<HTMLElement>(".full-terminal-state");
    expect(status?.hidden).toBeTrue();
    expect(status?.textContent).not.toContain("终端连接已暂停");
  });

  test("leaving the terminal mode from the menu returns to guided", async () => {
    bootFullTerminal();
    expect(app.querySelector('button[aria-label="会话操作"]')).toBeTruthy();
    expect((app.querySelector(".full-terminal-exit")) === null).toBeTrue();
    await act(async () => { await leaveFullTerminal(); });
    expect(isFullTerminal()).toBe(false);
    expect(currentScreen()).toBe("pane");
    expect(paneTermMode("p1")).toBe("guided");
    expect(composeDraft()).toBe("");
    expect(app.querySelector(".dock")).toBeTruthy();
    expect(app.querySelector('button[aria-label="会话操作"]')).toBeTruthy();
    act(() => enterFullTerminal());
    expect(isFullTerminal()).toBe(true);
    expect(composeDraft()).toBe(DRAFT);
  });

  test("swipe-back from complete-terminal returns to the list", async () => {
    bootFullTerminal();
    act(() => goBackFromPane());
    await act(async () => { await leaveFullTerminal({ rememberGuided: false, paint: false }); });
    await act(async () => { await Promise.resolve(); });
    expect(currentScreen()).toBe("home");
    expect(paneTermMode("p1")).toBe("full");
  });

  test("the host keeps a side-pan canvas for the selected PTY width", () => {
    bootFullTerminal();
    const host = app.querySelector(".full-terminal-host");
    expect(host?.classList.contains("is-pan")).toBe(true);
    expect(host?.querySelector(".full-terminal-pan")).toBeTruthy();
    expect(host?.querySelector(".full-terminal-canvas")).toBeTruthy();
    expect(host?.querySelector(".full-terminal-scroll")).toBeTruthy();
    act(() => setTermFit("fit"));
    expect(app.querySelector(".full-terminal-host")?.classList.contains("is-pan")).toBe(false);
    act(() => setTermFit("pan"));
    expect(app.querySelector(".full-terminal-host")?.classList.contains("is-pan")).toBe(true);
    act(() => setTermFit("pan", 120));
    expect(termCols()).toBe(120);
    expect(localStorage.getItem("pairfob:termCols")).toBe("120");
  });

  test("the shell keeps scroll controls owned by the host while the pad expands below it", () => {
    act(() => setKeysExpanded(false));
    bootFullTerminal();
    const root = app.querySelector<HTMLElement>(".full-terminal-root")!;
    const chrome = root.querySelector<HTMLElement>(".full-terminal-chrome")!;
    const host = root.querySelector<HTMLElement>(".full-terminal-host")!;
    const rail = root.querySelector<HTMLElement>(".full-terminal-scroll")!;
    const pad = root.querySelector<HTMLElement>(".full-terminal-pad")!;
    expect([...root.children]).toEqual([chrome, host, pad]);
    expect(host.contains(rail)).toBeTrue();
    expect(pad.contains(rail)).toBeFalse();
    expect(rail.querySelectorAll(".full-terminal-scroll-btn")).toHaveLength(4);

    click('.full-terminal-pad [aria-label="更多按键"]');
    const expandedPad = root.querySelector<HTMLElement>(".full-terminal-pad")!;
    expect(keysExpanded()).toBeTrue();
    expect([...root.children]).toEqual([chrome, host, expandedPad]);
    expect(host.contains(rail)).toBeTrue();
    expect(expandedPad.querySelectorAll(".keys")).toHaveLength(3);

    click('.full-terminal-pad [aria-label="更多按键"]');
    const collapsedPad = root.querySelector<HTMLElement>(".full-terminal-pad")!;
    expect(keysExpanded()).toBeFalse();
    expect([...root.children]).toEqual([chrome, host, collapsedPad]);
    expect(collapsedPad.querySelectorAll(".keys")).toHaveLength(1);
  });

  test("compose and live input switch in place without losing an unsent draft", () => {
    bootFullTerminal();
    expect(app.querySelector(".full-terminal-compose-input")).toBeTruthy();
    expect((app.querySelector(".full-terminal-kb")) === null).toBeTrue();
    act(() => setFullTerminalComposeLive(true));
    expect(composeLive()).toBe(true);
    expect(paneComposeLive("p1")).toBe(true);
    expect(composeDraft()).toBe(DRAFT);
    expect((app.querySelector(".full-terminal-compose-input")) === null).toBeTrue();
    expect(app.querySelector(".full-terminal-kb")).toBeTruthy();
    act(() => setFullTerminalComposeLive(false));
    expect(composeLive()).toBe(false);
    expect(paneComposeLive("p1")).toBe(false);
    expect((app.querySelector(".full-terminal-compose-input") as HTMLTextAreaElement).value).toBe(DRAFT);
  });

  test("list-back lives on the guided chrome after leaving", async () => {
    bootFullTerminal();
    await act(async () => { await leaveFullTerminal(); });
    click(".chrome .back");
    await act(async () => { await Promise.resolve(); });
    expect(currentScreen()).toBe("home");
    expect(composeDraft()).toBe("");
    expect(paneTermMode("p1")).toBe("guided");
  });

  test("a stale open failure cannot replace the reconnecting state", async () => {
    let rejectOpen: ((reason?: unknown) => void) | undefined;
    const session = live();
    session.terminalOpen = () => new Promise((_resolve, reject) => { rejectOpen = reject; });
    bootFullTerminal(session);

    await waitUntil(() => rejectOpen !== undefined, "pending terminal open");
    expect(rejectOpen).toBeDefined();
    act(() => handleFullTerminalEvent({ type: "disconnected" }));
    act(() => { rejectOpen?.(new Error("old transport closed")); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    const status = app.querySelector<HTMLElement>(".full-terminal-state");
    expect(status?.dataset.stage).toBe("waiting");
    expect(status?.textContent).toContain("正在恢复连接");
    expect(status?.textContent).not.toContain("old transport closed");
  });

  test("an initially disconnected pane opens once after the connection recovers", async () => {
    let connected = false;
    let opens = 0;
    const session = live();
    session.isConnected = () => connected;
    session.terminalOpen = async (paneId, cols, rows) => {
      opens++;
      return {
        operationId: "op_AAECAwQFBgcICQoL",
        terminalId: "term_11111111111111111111111111111111",
        paneId,
        cols,
        rows,
        encoding: "ansi" as const,
      };
    };
    bootFullTerminal(session);
    await waitUntil(() => app.querySelector(".xterm") !== null, "terminal renderer");

    act(() => handleFullTerminalEvent({ type: "reconnecting" }));
    await act(async () => { await Promise.resolve(); });
    expect(opens).toBe(0);
    expect(app.querySelector<HTMLElement>(".full-terminal-state")?.dataset.stage).toBe("waiting");

    connected = true;
    act(() => handleFullTerminalEvent({ type: "connected" }));
    await waitUntil(() => opens === 1, "recovered terminal open");
    expect(opens).toBe(1);
    expect(app.querySelector<HTMLElement>(".full-terminal-state")?.hidden).toBe(true);

    act(() => handleFullTerminalEvent({ type: "connected" }));
    await act(async () => { await Promise.resolve(); });
    expect(opens).toBe(1);
  });

  test("connected waits for the renderer instead of opening a bridge early", async () => {
    let opens = 0;
    const session = live();
    session.terminalOpen = async (paneId, cols, rows) => {
      opens++;
      return {
        operationId: "op_AAECAwQFBgcICQoL",
        terminalId: "term_11111111111111111111111111111111",
        paneId,
        cols,
        rows,
        encoding: "ansi" as const,
      };
    };
    bootFullTerminal(session);

    act(() => handleFullTerminalEvent({ type: "connected" }));
    expect(opens).toBe(0);
    expect((app.querySelector(".xterm")) === null).toBeTrue();
    await waitUntil(() => opens === 1, "renderer-backed terminal open");
    expect(app.querySelector(".xterm")).toBeTruthy();
  });

  test("connected queues a replacement after a pending open becomes stale", async () => {
    let opens = 0;
    let finishFirst = () => {};
    const closed: string[] = [];
    const session = live();
    session.terminalOpen = (paneId, cols, rows) => {
      const terminalId = `term_${String(++opens).padStart(32, "1")}`;
      const opened = {
        operationId: "op_AAECAwQFBgcICQoL",
        terminalId,
        paneId,
        cols,
        rows,
        encoding: "ansi" as const,
      };
      if (opens > 1) return Promise.resolve(opened);
      return new Promise((resolve) => { finishFirst = () => resolve(opened); });
    };
    session.terminalClose = async (terminalId) => { closed.push(terminalId); };
    bootFullTerminal(session);
    await waitUntil(() => opens === 1, "pending reconnect open");

    act(() => handleFullTerminalEvent({ type: "reconnecting" }));
    act(() => handleFullTerminalEvent({ type: "connected" }));
    act(() => { finishFirst(); });
    await waitUntil(() => opens === 2, "replacement reconnect open");

    expect(closed).toEqual(["term_11111111111111111111111111111111"]);
  });

  test("visible queues a replacement after a hidden pending open becomes stale", async () => {
    let opens = 0;
    let finishFirst = () => {};
    const closed: string[] = [];
    const session = live();
    session.terminalOpen = (paneId, cols, rows) => {
      const terminalId = `term_${String(++opens).padStart(32, "1")}`;
      const opened = {
        operationId: "op_AAECAwQFBgcICQoL",
        terminalId,
        paneId,
        cols,
        rows,
        encoding: "ansi" as const,
      };
      if (opens > 1) return Promise.resolve(opened);
      return new Promise((resolve) => { finishFirst = () => resolve(opened); });
    };
    session.terminalClose = async (terminalId) => { closed.push(terminalId); };
    bootFullTerminal(session);
    await waitUntil(() => opens === 1, "pending hidden open");

    visibility = "hidden";
    act(() => handleFullTerminalVisibility(true));
    visibility = "visible";
    act(() => handleFullTerminalVisibility(false));
    act(() => { finishFirst(); });
    await waitUntil(() => opens === 2, "replacement visible open");

    expect(closed).toEqual(["term_11111111111111111111111111111111"]);
  });

  test("a full frame can resync while stale frames are ignored and a forward delta gap closes", async () => {
    let closes = 0;
    let opens = 0;
    const terminalId = "term_11111111111111111111111111111111";
    const session = live();
    session.terminalOpen = async (paneId, cols, rows) => {
      opens++;
      return {
        operationId: "op_AAECAwQFBgcICQoL",
        terminalId,
        paneId,
        cols,
        rows,
        encoding: "ansi" as const,
      };
    };
    session.terminalClose = async () => { closes++; };
    bootFullTerminal(session);
    await waitUntil(() => opens === 1, "terminal open");

    const terminalFrame = (sequence: string, full: boolean) => ({
      type: "terminal_frame" as const,
      terminalId,
      terminalFrame: {
        terminalId,
        sequence,
        width: 80,
        height: 24,
        full,
        index: 0,
        count: 1,
        data: new Uint8Array([65]),
      },
    });
    act(() => handleFullTerminalEvent(terminalFrame("1", true)));
    act(() => handleFullTerminalEvent(terminalFrame("1", false)));
    act(() => handleFullTerminalEvent(terminalFrame("3", true)));
    act(() => handleFullTerminalEvent(terminalFrame("4", false)));
    act(() => handleFullTerminalEvent(terminalFrame("2", false)));
    await act(async () => { await Promise.resolve(); });
    expect(closes).toBe(0);

    act(() => handleFullTerminalEvent(terminalFrame("6", false)));
    await act(async () => { await Promise.resolve(); });
    expect(closes).toBe(1);
  });

  test("retry remains available while hidden and reopens when visible", async () => {
    let opens = 0;
    const terminalId = "term_11111111111111111111111111111111";
    const session = live();
    session.terminalOpen = async (paneId, cols, rows) => {
      opens++;
      return {
        operationId: "op_AAECAwQFBgcICQoL",
        terminalId,
        paneId,
        cols,
        rows,
        encoding: "ansi" as const,
      };
    };
    bootFullTerminal(session);
    await waitUntil(() => opens === 1, "initial terminal open");
    act(() => handleFullTerminalEvent({ type: "terminal_closed", terminalId, reason: "frame gap" }));

    visibility = "hidden";
    click(".full-terminal-state-retry");
    const status = app.querySelector<HTMLElement>(".full-terminal-state");
    expect(opens).toBe(1);
    expect(status?.dataset.stage).toBe("error");
    expect(status?.querySelector<HTMLButtonElement>(".full-terminal-state-retry")?.hidden).toBeFalse();

    visibility = "visible";
    act(() => handleFullTerminalVisibility(false));
    await waitUntil(() => opens === 2, "visible terminal reopen");
    expect(status?.hidden).toBeTrue();
    expect(status?.dataset.stage).toBe("live");
    expect(app.querySelector(".xterm")).toBeTruthy();
  });

  test("a late close cannot replace a newer successful open", async () => {
    let resolveClose = () => {};
    const oldClose = new Promise<void>((resolve) => { resolveClose = resolve; });
    let opens = 0;
    const session = live();
    session.terminalOpen = async (paneId, cols, rows) => ({
      operationId: "op_AAECAwQFBgcICQoL",
      terminalId: `term_${String(++opens).padStart(32, "1")}`,
      paneId,
      cols,
      rows,
      encoding: "ansi" as const,
    });
    session.terminalClose = () => oldClose;
    bootFullTerminal(session);
    await waitUntil(() => opens === 1, "initial terminal open");

    visibility = "hidden";
    act(() => handleFullTerminalVisibility(true));
    visibility = "visible";
    act(() => handleFullTerminalVisibility(false));
    await waitUntil(() => opens === 2, "newer terminal open");
    const status = app.querySelector<HTMLElement>(".full-terminal-state");
    expect(opens).toBe(2);
    expect(status?.hidden).toBeTrue();

    act(() => { resolveClose(); });
    await act(async () => { await Promise.resolve(); });
    expect(status?.hidden).toBeTrue();
    expect(status?.dataset.stage).toBe("live");
  });

  test("a late close cannot replace a newer open failure", async () => {
    let resolveClose = () => {};
    const oldClose = new Promise<void>((resolve) => { resolveClose = resolve; });
    let opens = 0;
    const session = live();
    session.terminalOpen = async (paneId, cols, rows) => {
      opens++;
      if (opens > 1) throw new Error("new open failed");
      return {
        operationId: "op_AAECAwQFBgcICQoL",
        terminalId: "term_11111111111111111111111111111111",
        paneId,
        cols,
        rows,
        encoding: "ansi" as const,
      };
    };
    session.terminalClose = () => oldClose;
    bootFullTerminal(session);
    await waitUntil(() => opens === 1, "initial terminal open");

    visibility = "hidden";
    act(() => handleFullTerminalVisibility(true));
    visibility = "visible";
    act(() => handleFullTerminalVisibility(false));
    await waitUntil(
      () => app.querySelector<HTMLElement>(".full-terminal-state")?.dataset.stage === "error",
      "newer terminal open failure",
    );
    const status = app.querySelector<HTMLElement>(".full-terminal-state");
    const failureText = status?.textContent;
    expect(status?.dataset.stage).toBe("error");
    expect(status?.querySelector<HTMLButtonElement>(".full-terminal-state-retry")?.hidden).toBeFalse();

    act(() => { resolveClose(); });
    await act(async () => { await Promise.resolve(); });
    expect(status?.textContent).toBe(failureText);
    expect(status?.textContent).not.toContain("终端连接已暂停");
    expect(status?.querySelector<HTMLButtonElement>(".full-terminal-state-retry")?.hidden).toBeFalse();
  });
});
