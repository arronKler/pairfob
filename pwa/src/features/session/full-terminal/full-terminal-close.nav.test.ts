import { closeTestDialogs } from "../../../../test-support/close-dialogs";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { LiveSession } from "../../../lib/protocol/client";

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
const { isFullTerminal, openPaneId, resetPaneView, selectPane, setFullTerminal } =
  await import("../session-store.ts");
const { setComposeLive } = await import("../compose-store.ts");
const { attachLiveSession } = await import("../../computers/catalog-store.ts");
const { applySnapshot, liveAgents } = await import("../../dashboard/catalog-store.ts");
const { operationBusy, setOperationBusy } = await import("../../operations/capabilities-store.ts");
const { setPaneTermMode } = await import("../../settings/preferences-store.ts");
const { ProtocolError } = await import("../../../lib/protocol/client.ts");
const { openPane } = await import("../../../features/connection/controller.ts");
const { closePane } = await import("../../../features/operations/controller.ts");
const { disposeFullTerminal, leaveFullTerminal } = await import("./full-terminal.ts");
const { resetComposeDrafts } = await import("../drafts/compose-drafts.ts");

const DEMO_WORKSPACES = [{ workspace_id: "w1", label: "demo", cwd: "/tmp/demo" }] as const;

function paneCard(paneId: string) {
  return { pane_id: paneId, workspace_id: "w1", tab_id: "t1", agent: "herdr", agent_status: "idle" };
}

function publishPanes(paneIds: readonly string[]): void {
  applySnapshot({
    focused: { pane_id: paneIds[0] },
    workspaces: DEMO_WORKSPACES,
    panes: paneIds.map((paneId) => paneCard(paneId)),
  });
}

function live(): LiveSession {
  return {
    snapshot: async () => ({ panes: [] }),
    closePane: async () => undefined,
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

// The actual stable App owns composition: typed domain actions publish through
// the installed host's synchronous commitView port. No paint host, no facade
// writes, no manual flush.
function bootFullTerminal(session: LiveSession = live()): void {
  act(() => {
    disposeFullTerminal();
    batch(() => {
      setPhase("live");
      setScreen("pane");
      selectPane("p1");
      resetPaneView();
      setComposeLive(false);
      setFullTerminal(true);
      setNetworkOnline(true);
      setOperationBusy(false);
      attachLiveSession(session);
      publishPanes(["p1"]);
      setPaneTermMode("p1", "full");
    });
    commitView();
  });
}

async function confirmDanger(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
  const dialog = happy.document.querySelector("dialog.modal");
  const go = [...(dialog?.querySelectorAll("button") ?? [])]
    .find((button) => button.className.includes("btn-danger"));
  if (!(go instanceof happy.HTMLButtonElement)) throw new Error("missing danger confirmation");
  act(() => go.click());
  await act(async () => { await Promise.resolve(); });
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
  resetTransitionState();
  resetComposeDrafts();
  registerSessionOwnerPreparer(registerSessionView);
  act(() => mountApp());
});

afterEach(async () => {
  closeTestDialogs();
  await act(async () => {
    await leaveFullTerminal({ rememberGuided: false, paint: false });
    disposeFullTerminal();
    setOperationBusy(false);
    resetComposeDrafts();
    unmountApp();
    registerSessionOwnerPreparer(null);
    attachLiveSession(null);
    resetTransitionState();
    await happy.happyDOM.abort();
  });
  expect(appHost()).toBeNull();
  expect(isAppMounted()).toBeFalse();
});

describe("closing panes coordinates the active complete-terminal bridge", () => {
  test("closes the current terminal exactly once before closing its pane", async () => {
    const calls: string[] = [];
    const terminalId = "term_11111111111111111111111111111111";
    const session = live();
    session.terminalOpen = async (paneId, cols, rows) => ({
      operationId: "op_AAECAwQFBgcICQoL",
      terminalId,
      paneId,
      cols,
      rows,
      encoding: "ansi" as const,
    });
    session.terminalClose = async (id) => { calls.push(`terminal:${id}`); };
    session.closePane = async (paneId) => { calls.push(`pane:${paneId}`); };
    bootFullTerminal(session);
    await waitUntil(() => app.querySelector('.full-terminal-state[data-stage="live"]') !== null, "active terminal bridge");

    let closing!: Promise<void>;
    act(() => { closing = closePane(liveAgents()[0]); });
    await confirmDanger();
    await act(async () => { await closing; });

    expect(calls).toEqual([`terminal:${terminalId}`, "pane:p1"]);
    expect(isFullTerminal()).toBeFalse();
    expect(openPaneId()).toBe("");
    expect(currentScreen()).toBe("home");
  });

  test("waits for a pending terminal open to close before deleting its pane", async () => {
    const calls: string[] = [];
    const terminalId = "term_11111111111111111111111111111111";
    let finishOpen = () => {};
    const session = live();
    session.terminalOpen = (paneId, cols, rows) => {
      calls.push("open");
      return new Promise((resolve) => {
        finishOpen = () => resolve({
          operationId: "op_AAECAwQFBgcICQoL",
          terminalId,
          paneId,
          cols,
          rows,
          encoding: "ansi" as const,
        });
      });
    };
    session.terminalClose = async (id) => { calls.push(`terminal:${id}`); };
    session.closePane = async (paneId) => { calls.push(`pane:${paneId}`); };
    bootFullTerminal(session);
    await waitUntil(() => calls[0] === "open", "pending terminal open");

    let closing!: Promise<void>;
    act(() => { closing = closePane(liveAgents()[0]); });
    await confirmDanger();
    await act(async () => { await Promise.resolve(); });
    expect(calls).toEqual(["open"]);
    act(() => { finishOpen(); });
    await act(async () => { await closing; });

    expect(calls).toEqual(["open", `terminal:${terminalId}`, "pane:p1"]);
  });

  test("closing another pane leaves the current terminal bridge alone", async () => {
    const calls: string[] = [];
    const terminalId = "term_11111111111111111111111111111111";
    const session = live();
    session.terminalOpen = async (paneId, cols, rows) => ({
      operationId: "op_AAECAwQFBgcICQoL",
      terminalId,
      paneId,
      cols,
      rows,
      encoding: "ansi" as const,
    });
    session.terminalClose = async (id) => { calls.push(`terminal:${id}`); };
    session.closePane = async (paneId) => { calls.push(`pane:${paneId}`); };
    session.snapshot = async () => ({
      panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "t1", agent: "herdr" }],
    });
    bootFullTerminal(session);
    act(() => publishPanes(["p1", "p2"]));
    const other = liveAgents().find((agent) => agent.paneId === "p2");
    await waitUntil(() => app.querySelector('.full-terminal-state[data-stage="live"]') !== null, "active terminal bridge");

    let closing!: Promise<void>;
    act(() => { closing = closePane(other); });
    await confirmDanger();
    await act(async () => { await closing; });

    expect(calls).toEqual(["pane:p2"]);
    expect(isFullTerminal()).toBeTrue();
    expect(openPaneId()).toBe("p1");
  });

  test("a terminal-close failure still performs the pane mutation only once", async () => {
    const calls: string[] = [];
    const session = live();
    session.terminalOpen = async (paneId, cols, rows) => ({
      operationId: "op_AAECAwQFBgcICQoL",
      terminalId: "term_11111111111111111111111111111111",
      paneId,
      cols,
      rows,
      encoding: "ansi" as const,
    });
    session.terminalClose = async () => {
      calls.push("terminal");
      throw new Error("terminal close failed");
    };
    session.closePane = async (paneId) => { calls.push(`pane:${paneId}`); };
    bootFullTerminal(session);
    await waitUntil(() => app.querySelector('.full-terminal-state[data-stage="live"]') !== null, "active terminal bridge");

    let closing!: Promise<void>;
    act(() => { closing = closePane(liveAgents()[0]); });
    await confirmDanger();
    await act(async () => { await closing; });

    expect(calls).toEqual(["terminal", "pane:p1"]);
    expect(operationBusy()).toBeFalse();
    expect(isFullTerminal()).toBeFalse();
    expect(currentScreen()).toBe("home");
  });

  test("an unknown pane-close outcome reconciles once and leaves a usable guided pane", async () => {
    const calls: string[] = [];
    const session = live();
    session.terminalOpen = async (paneId, cols, rows) => ({
      operationId: "op_AAECAwQFBgcICQoL",
      terminalId: "term_11111111111111111111111111111111",
      paneId,
      cols,
      rows,
      encoding: "ansi" as const,
    });
    session.terminalClose = async () => { calls.push("terminal"); };
    session.closePane = async () => {
      calls.push("pane");
      throw new ProtocolError("unknown_outcome", "refresh before retry");
    };
    session.snapshot = async () => {
      calls.push("snapshot");
      return { panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "t1", agent: "herdr" }] };
    };
    bootFullTerminal(session);
    await waitUntil(() => app.querySelector('.full-terminal-state[data-stage="live"]') !== null, "active terminal bridge");

    let closing!: Promise<void>;
    act(() => { closing = closePane(liveAgents()[0]); });
    await confirmDanger();
    await act(async () => { await closing; });

    expect(calls).toEqual(["terminal", "pane", "snapshot"]);
    expect(operationBusy()).toBeFalse();
    expect(isFullTerminal()).toBeFalse();
    expect(openPaneId()).toBe("p1");
    expect(currentScreen()).toBe("pane");
    expect(app.querySelector(".dock")).toBeTruthy();
  });

  test("rapid duplicate close cannot race a switch to a newer terminal bridge", async () => {
    const calls: string[] = [];
    const openedPanes: string[] = [];
    let releaseTerminalClose = () => {};
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
    session.terminalClose = (terminalId) => {
      calls.push(`terminal:${terminalId}`);
      if (terminalId !== "term_11111111111111111111111111111111") return Promise.resolve();
      return new Promise<void>((resolve) => { releaseTerminalClose = resolve; });
    };
    session.closePane = async (paneId) => { calls.push(`pane:${paneId}`); };
    session.snapshot = async () => ({
      panes: [{ pane_id: "p2", workspace_id: "w1", tab_id: "t1", agent: "herdr" }],
    });
    bootFullTerminal(session);
    act(() => {
      publishPanes(["p1", "p2"]);
      setPaneTermMode("p2", "full");
    });
    await waitUntil(() => app.querySelector('.full-terminal-state[data-stage="live"]') !== null, "active terminal bridge");

    const firstCard = liveAgents().find((agent) => agent.paneId === "p1");
    let first!: Promise<void>;
    act(() => { first = closePane(firstCard); });
    let second!: Promise<void>;
    act(() => { second = closePane(firstCard); });
    await act(async () => { await Promise.resolve(); });
    const dialogs = [...happy.document.querySelectorAll("dialog.modal")];
    expect(dialogs).toHaveLength(2);
    for (const dialog of dialogs) {
      const go = [...dialog.querySelectorAll("button")]
        .find((button) => button.className.includes("btn-danger"));
      if (!(go instanceof happy.HTMLButtonElement)) throw new Error("missing duplicate close confirmation");
      act(() => go.click());
      await act(async () => { await Promise.resolve(); });
    }
    expect(calls).toEqual(["terminal:term_11111111111111111111111111111111"]);
    let switching!: Promise<void>;
    act(() => { switching = openPane("p2"); });
    await act(async () => { await Promise.resolve(); });
    expect(openedPanes).toEqual(["p1"]);
    act(() => { releaseTerminalClose(); });
    await act(async () => { await Promise.all([first, second, switching]); });
    await waitUntil(() => openedPanes.length === 2, "new pane terminal bridge");

    expect(calls).toEqual(["terminal:term_11111111111111111111111111111111", "pane:p1"]);
    expect(openedPanes).toEqual(["p1", "p2"]);
    expect(operationBusy()).toBeFalse();
    expect(openPaneId()).toBe("p2");
    expect(isFullTerminal()).toBeTrue();
  });
});
