import { Window } from "happy-dom";
import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/pair", width: 390, height: 844 });
let visibility: DocumentVisibilityState = "visible";
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
Object.defineProperty(happy.document, "visibilityState", {
  configurable: true,
  get: () => visibility,
});
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

const { app, paneTermMode, setPaneTermMode, state } = await import("../state.ts");
const { setRenderer } = await import("../paint.ts");
const { renderPane, goBackFromPane } = await import("./pane.ts");
const {
  disposeFullTerminal,
  handleFullTerminalEvent,
  handleFullTerminalVisibility,
  leaveFullTerminal,
  setFullTerminalComposeLive,
  setTermFit,
} = await import("./full-terminal.ts");

const DRAFT = "keep-draft";

function live() {
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
  };
}

function bootFullTerminal(session = live()): void {
  disposeFullTerminal();
  state.phase = "live";
  state.screen = "pane";
  state.paneId = "p1";
  state.paneText = "ready";
  state.composeDraft = DRAFT;
  state.composeLive = false;
  state.agents = [{
    paneId: "p1",
    agent: "herdr",
    hasAgent: true,
    status: "idle",
    workspaceLabel: "demo",
    cwd: "/tmp/demo",
  }];
  state.live = session;
  state.fullTerminal = true;
  setPaneTermMode("p1", "full");
  setRenderer(() => renderPane());
  renderPane();
}

function click(selector: string): void {
  const el = app.querySelector(selector);
  if (!(el instanceof HTMLButtonElement)) throw new Error(`missing ${selector}: ${app.innerHTML.slice(0, 200)}`);
  el.click();
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

beforeAll(() => {
  setRenderer(() => renderPane());
});

afterEach(async () => {
  visibility = "visible";
  await leaveFullTerminal({ rememberGuided: false, paint: false });
  disposeFullTerminal();
  state.screen = "pane";
  state.composeDraft = "";
  state.composeLive = false;
  state.paneComposeLive = {};
  state.paneTermModes = {};
  state.termFit = "pan";
  state.live = null;
  app.replaceChildren();
});

describe("complete-terminal remembers its mode per pane", () => {
  test("‹ returns to the session list and keeps complete-terminal as the pane mode", async () => {
    bootFullTerminal();
    expect(app.querySelector(".full-terminal-root")).toBeTruthy();
    expect(app.querySelector(".dock")).toBeNull();
    expect(app.querySelector(".full-terminal-pad")).toBeTruthy();
    expect(app.querySelector('.full-terminal-pad [aria-label="上箭头"]')).toBeTruthy();
    click(".full-terminal-chrome .back");
    await leaveFullTerminal({ rememberGuided: false, paint: false });
    await Promise.resolve();
    expect(state.fullTerminal).toBe(false);
    expect(state.screen).toBe("home");
    expect(paneTermMode("p1")).toBe("full");
    expect(app.querySelector(".full-terminal-root")).toBeNull();
  });

  test("reopening the pane restores complete-terminal", async () => {
    bootFullTerminal();
    click(".full-terminal-chrome .back");
    await leaveFullTerminal({ rememberGuided: false, paint: false });
    await Promise.resolve();
    expect(state.screen).toBe("home");
    state.screen = "pane";
    state.paneId = "p1";
    state.fullTerminal = paneTermMode("p1") === "full";
    renderPane();
    expect(state.fullTerminal).toBe(true);
    expect(app.querySelector(".full-terminal-root")).toBeTruthy();
    expect(app.querySelector(".dock")).toBeNull();
  });

  test("leaving the terminal mode from the menu returns to guided", async () => {
    bootFullTerminal();
    expect(app.querySelector('button[aria-label="会话操作"]')).toBeTruthy();
    expect(app.querySelector(".full-terminal-exit")).toBeNull();
    await leaveFullTerminal();
    expect(state.fullTerminal).toBe(false);
    expect(state.screen).toBe("pane");
    expect(paneTermMode("p1")).toBe("guided");
    expect(state.composeDraft).toBe(DRAFT);
    expect(app.querySelector(".dock")).toBeTruthy();
    expect(app.querySelector('button[aria-label="会话操作"]')).toBeTruthy();
  });

  test("swipe-back from complete-terminal returns to the list", async () => {
    bootFullTerminal();
    goBackFromPane();
    await leaveFullTerminal({ rememberGuided: false, paint: false });
    await Promise.resolve();
    expect(state.screen).toBe("home");
    expect(paneTermMode("p1")).toBe("full");
  });

  test("the host keeps a side-pan canvas for the selected PTY width", () => {
    bootFullTerminal();
    const host = app.querySelector(".full-terminal-host");
    expect(host?.classList.contains("is-pan")).toBe(true);
    expect(host?.querySelector(".full-terminal-pan")).toBeTruthy();
    expect(host?.querySelector(".full-terminal-canvas")).toBeTruthy();
    expect(host?.querySelector(".full-terminal-scroll")).toBeTruthy();
    setTermFit("fit");
    expect(app.querySelector(".full-terminal-host")?.classList.contains("is-pan")).toBe(false);
    setTermFit("pan");
    expect(app.querySelector(".full-terminal-host")?.classList.contains("is-pan")).toBe(true);
    setTermFit("pan", 120);
    expect(state.termCols).toBe(120);
    expect(localStorage.getItem("pairfob:termCols")).toBe("120");
  });

  test("compose and live input switch in place without losing an unsent draft", () => {
    bootFullTerminal();
    expect(app.querySelector(".full-terminal-compose-input")).toBeTruthy();
    expect(app.querySelector(".full-terminal-kb")).toBeNull();
    setFullTerminalComposeLive(true);
    expect(state.composeLive).toBe(true);
    expect(state.paneComposeLive.p1).toBe(true);
    expect(state.composeDraft).toBe(DRAFT);
    expect(app.querySelector(".full-terminal-compose-input")).toBeNull();
    expect(app.querySelector(".full-terminal-kb")).toBeTruthy();
    setFullTerminalComposeLive(false);
    expect(state.composeLive).toBe(false);
    expect(state.paneComposeLive.p1).toBe(false);
    expect((app.querySelector(".full-terminal-compose-input") as HTMLTextAreaElement).value).toBe(DRAFT);
  });

  test("list-back lives on the guided chrome after leaving", async () => {
    bootFullTerminal();
    await leaveFullTerminal();
    click(".chrome .back");
    expect(state.screen).toBe("home");
    expect(state.composeDraft).toBe("");
    expect(paneTermMode("p1")).toBe("guided");
  });

  test("a stale open failure cannot replace the reconnecting state", async () => {
    let rejectOpen: ((reason?: unknown) => void) | undefined;
    const session = live();
    session.terminalOpen = () => new Promise((_resolve, reject) => { rejectOpen = reject; });
    bootFullTerminal(session);

    await waitUntil(() => rejectOpen !== undefined, "pending terminal open");
    expect(rejectOpen).toBeDefined();
    handleFullTerminalEvent({ type: "disconnected" });
    rejectOpen?.(new Error("old transport closed"));
    await Promise.resolve();
    await Promise.resolve();

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

    handleFullTerminalEvent({ type: "reconnecting" });
    await Promise.resolve();
    expect(opens).toBe(0);
    expect(app.querySelector<HTMLElement>(".full-terminal-state")?.dataset.stage).toBe("waiting");

    connected = true;
    handleFullTerminalEvent({ type: "connected" });
    await waitUntil(() => opens === 1, "recovered terminal open");
    expect(opens).toBe(1);
    expect(app.querySelector<HTMLElement>(".full-terminal-state")?.hidden).toBe(true);

    handleFullTerminalEvent({ type: "connected" });
    await Promise.resolve();
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

    handleFullTerminalEvent({ type: "connected" });
    expect(opens).toBe(0);
    expect(app.querySelector(".xterm")).toBeNull();
    await waitUntil(() => opens === 1, "renderer-backed terminal open");
    expect(app.querySelector(".xterm")).toBeTruthy();
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
    handleFullTerminalEvent(terminalFrame("1", true));
    handleFullTerminalEvent(terminalFrame("1", false));
    handleFullTerminalEvent(terminalFrame("3", true));
    handleFullTerminalEvent(terminalFrame("4", false));
    handleFullTerminalEvent(terminalFrame("2", false));
    await Promise.resolve();
    expect(closes).toBe(0);

    handleFullTerminalEvent(terminalFrame("6", false));
    await Promise.resolve();
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
    handleFullTerminalEvent({ type: "terminal_closed", terminalId, reason: "frame gap" });

    visibility = "hidden";
    click(".full-terminal-state-retry");
    const status = app.querySelector<HTMLElement>(".full-terminal-state");
    expect(opens).toBe(1);
    expect(status?.dataset.stage).toBe("error");
    expect(status?.querySelector<HTMLButtonElement>(".full-terminal-state-retry")?.hidden).toBeFalse();

    visibility = "visible";
    handleFullTerminalVisibility(false);
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
    handleFullTerminalVisibility(true);
    visibility = "visible";
    handleFullTerminalVisibility(false);
    await waitUntil(() => opens === 2, "newer terminal open");
    const status = app.querySelector<HTMLElement>(".full-terminal-state");
    expect(opens).toBe(2);
    expect(status?.hidden).toBeTrue();

    resolveClose();
    await Promise.resolve();
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
    handleFullTerminalVisibility(true);
    visibility = "visible";
    handleFullTerminalVisibility(false);
    await waitUntil(
      () => app.querySelector<HTMLElement>(".full-terminal-state")?.dataset.stage === "error",
      "newer terminal open failure",
    );
    const status = app.querySelector<HTMLElement>(".full-terminal-state");
    const failureText = status?.textContent;
    expect(status?.dataset.stage).toBe("error");
    expect(status?.querySelector<HTMLButtonElement>(".full-terminal-state-retry")?.hidden).toBeFalse();

    resolveClose();
    await Promise.resolve();
    expect(status?.textContent).toBe(failureText);
    expect(status?.textContent).not.toContain("终端连接已暂停");
    expect(status?.querySelector<HTMLButtonElement>(".full-terminal-state-retry")?.hidden).toBeFalse();
  });
});
