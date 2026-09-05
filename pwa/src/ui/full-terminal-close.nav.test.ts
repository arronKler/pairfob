import { Window } from "happy-dom";
import { afterEach, describe, expect, mock, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/pair", width: 390, height: 844 });
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

const { app, setPaneTermMode, state } = await import("../state.ts");
const { ProtocolError } = await import("../lib/protocol/client.ts");
const { setRenderer } = await import("../paint.ts");
const { openPane } = await import("../live.ts");
const { closePane } = await import("../live-operations.ts");
const { renderPane } = await import("./pane.ts");
const { disposeFullTerminal, leaveFullTerminal } = await import("./full-terminal.ts");

function live() {
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
  };
}

function bootFullTerminal(session = live()): void {
  disposeFullTerminal();
  state.phase = "live";
  state.screen = "pane";
  state.paneId = "p1";
  state.paneText = "ready";
  state.networkOnline = true;
  state.operationBusy = false;
  state.agents = [{
    paneId: "p1",
    agent: "herdr",
    hasAgent: true,
    status: "idle",
    workspaceId: "w1",
    tabId: "t1",
    workspaceLabel: "demo",
    cwd: "/tmp/demo",
  }];
  state.live = session;
  state.fullTerminal = true;
  setPaneTermMode("p1", "full");
  setRenderer(() => renderPane());
  renderPane();
}

async function confirmDanger(): Promise<void> {
  await Promise.resolve();
  const dialog = happy.document.querySelector("dialog.modal");
  const go = [...(dialog?.querySelectorAll("button") ?? [])]
    .find((button) => button.className.includes("btn-danger"));
  if (!(go instanceof happy.HTMLButtonElement)) throw new Error("missing danger confirmation");
  go.click();
  await Promise.resolve();
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

afterEach(async () => {
  for (const dialog of happy.document.querySelectorAll("dialog")) dialog.remove();
  await leaveFullTerminal({ rememberGuided: false, paint: false });
  disposeFullTerminal();
  state.operationBusy = false;
  state.live = null;
  state.agents = [];
  state.paneId = "";
  state.screen = "home";
  state.paneTermModes = {};
  app.replaceChildren();
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
    await waitUntil(() => app.querySelector(".xterm") !== null, "active terminal renderer");

    const closing = closePane(state.agents[0]);
    await confirmDanger();
    await closing;

    expect(calls).toEqual([`terminal:${terminalId}`, "pane:p1"]);
    expect(state.fullTerminal).toBeFalse();
    expect(state.paneId).toBe("");
    expect(state.screen).toBe("home");
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

    const closing = closePane(state.agents[0]);
    await confirmDanger();
    await Promise.resolve();
    expect(calls).toEqual(["open"]);
    finishOpen();
    await closing;

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
    const other = { ...state.agents[0], paneId: "p2", paneLabel: "other" };
    state.agents.push(other);
    await waitUntil(() => app.querySelector(".xterm") !== null, "active terminal renderer");

    const closing = closePane(other);
    await confirmDanger();
    await closing;

    expect(calls).toEqual(["pane:p2"]);
    expect(state.fullTerminal).toBeTrue();
    expect(state.paneId).toBe("p1");
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
    await waitUntil(() => app.querySelector(".xterm") !== null, "active terminal renderer");

    const closing = closePane(state.agents[0]);
    await confirmDanger();
    await closing;

    expect(calls).toEqual(["terminal", "pane:p1"]);
    expect(state.operationBusy).toBeFalse();
    expect(state.fullTerminal).toBeFalse();
    expect(state.screen).toBe("home");
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
    await waitUntil(() => app.querySelector(".xterm") !== null, "active terminal renderer");

    const closing = closePane(state.agents[0]);
    await confirmDanger();
    await closing;

    expect(calls).toEqual(["terminal", "pane", "snapshot"]);
    expect(state.operationBusy).toBeFalse();
    expect(state.fullTerminal).toBeFalse();
    expect(state.paneId).toBe("p1");
    expect(state.screen).toBe("pane");
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
    state.agents.push({ ...state.agents[0], paneId: "p2", paneLabel: "next" });
    setPaneTermMode("p2", "full");
    await waitUntil(() => app.querySelector(".xterm") !== null, "active terminal renderer");

    const first = closePane(state.agents[0]);
    const second = closePane(state.agents[0]);
    await Promise.resolve();
    const dialogs = [...happy.document.querySelectorAll("dialog.modal")];
    expect(dialogs).toHaveLength(2);
    for (const dialog of dialogs) {
      const go = [...dialog.querySelectorAll("button")]
        .find((button) => button.className.includes("btn-danger"));
      if (!(go instanceof happy.HTMLButtonElement)) throw new Error("missing duplicate close confirmation");
      go.click();
      await Promise.resolve();
    }
    expect(calls).toEqual(["terminal:term_11111111111111111111111111111111"]);
    const switching = openPane("p2");
    await Promise.resolve();
    expect(openedPanes).toEqual(["p1"]);
    releaseTerminalClose();
    await Promise.all([first, second, switching]);
    await waitUntil(() => openedPanes.length === 2, "new pane terminal bridge");

    expect(calls).toEqual(["terminal:term_11111111111111111111111111111111", "pane:p1"]);
    expect(openedPanes).toEqual(["p1", "p2"]);
    expect(state.operationBusy).toBeFalse();
    expect(state.paneId).toBe("p2");
    expect(state.fullTerminal).toBeTrue();
  });
});
