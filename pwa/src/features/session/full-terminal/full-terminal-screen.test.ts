import { resetBoardTestDOM } from "../../../../test-support/dom";
import { happy } from "../../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { LiveSession } from "../../../lib/protocol/client";

class TestTerminal {
  cols = 80;
  rows = 24;
  modes = { applicationCursorKeysMode: false };
  options: { fontSize?: number; lineHeight?: number };
  _core = { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } };
  private root: HTMLElement | null = null;
  constructor(options: { fontSize?: number; lineHeight?: number }) {
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
  write(_data: Uint8Array, done?: () => void): void {
    done?.();
  }
  dispose(): void {
    this.root?.remove();
  }
}

mock.module("./full-terminal-loader", () => ({
  fullTerminalSupported: () => true,
  terminalWebglSupported: () => true,
  loadFullTerminalXterm: async () => ({
    Terminal: TestTerminal,
    FitAddon: class { fit(): void {} },
    WebglAddon: class { onContextLoss(_listener: () => void): void {} },
  }),
  preloadFullTerminalXterm: () => {},
}));

const { appRoot } = await import("../../../app/dom-root.ts");
const { appHost, commitView } = await import("../../../app/host.ts");
const { isAppMounted, mountApp, unmountApp } = await import("../../../app/mount.tsx");
const { registerSessionOwnerPreparer } = await import("../../../app/frame.ts");
const { registerSessionView } = await import("../register.ts");
const { resetTransitionState } = await import("../../../app/transition.ts");
const { setPhase, setNetworkOnline } = await import("../../connection/connection-store.ts");
const { setScreen } = await import("../../../app/navigation-store.ts");
const { resetPaneView, selectPane, setFullTerminal } = await import("../session-store.ts");
const { setComposeLive } = await import("../compose-store.ts");
const { attachLiveSession } = await import("../../computers/catalog-store.ts");
const { applySnapshot } = await import("../../dashboard/catalog-store.ts");
const { applyRuntimeIdentity } = await import("../../connection/runtime-store.ts");
const {
  disposeFullTerminal,
  getFullTerminalView,
  handleFullTerminalEvent,
  leaveFullTerminal,
  releaseFullTerminalScreen,
  subscribeFullTerminalView,
  syncFullTerminalChrome,
} = await import("./full-terminal.ts");
const { FullTerminalScreen } = await import("./full-terminal-screen.tsx");

const app = appRoot();

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await act(async () => { await wait(10); });
  }
  throw new Error(`timed out waiting for ${label}`);
}

function live(extra: Record<string, unknown> = {}) {
  return {
    terminalOpen: async (paneId: string, cols: number, rows: number) => ({
      operationId: "op_AAECAwQFBgcICQoL",
      terminalId: "term_11111111111111111111111111111111",
      paneId,
      cols,
      rows,
      encoding: "ansi" as const,
    }),
    terminalClose: async () => undefined,
    terminalInput: async () => undefined,
    terminalResize: async () => undefined,
    terminalScroll: async () => undefined,
    isConnected: () => true,
    onEvent: () => () => undefined,
    close: () => undefined,
    ...extra,
  };
}

function boot(): void {
  disposeFullTerminal();
  const liveSessionHandle = live();
  act(() => {
    setPhase("live");
    setScreen("pane");
    selectPane("p1");
    resetPaneView();
    setFullTerminal(true);
    setComposeLive(false);
    setNetworkOnline(true);
    applyRuntimeIdentity({ herdHost: "", runtimeKind: "herdr" });
    attachLiveSession(liveSessionHandle as unknown as LiveSession);
    applySnapshot({
      workspaces: [{ workspace_id: "w1", label: "demo", cwd: "/tmp/demo" }],
      panes: [{ pane_id: "p1", workspace_id: "w1", agent: "herdr", agent_status: "working" }],
    });
    commitView();
  });
}

beforeEach(async () => {
  await resetBoardTestDOM();
  resetTransitionState();
  registerSessionOwnerPreparer(registerSessionView);
  act(() => mountApp());
});

afterEach(async () => {
  await act(async () => {
    await leaveFullTerminal({ rememberGuided: false, paint: false });
    disposeFullTerminal();
    releaseFullTerminalScreen();
    unmountApp();
    registerSessionOwnerPreparer(null);
    attachLiveSession(null);
    resetTransitionState();
    await happy.happyDOM.abort();
  });
  expect(appHost()).toBeNull();
  expect(isAppMounted()).toBeFalse();
});

describe("react complete-terminal shell", () => {
  test("matches host/chrome/canvas order and does not wrap xterm", async () => {
    act(boot);
    const root = app.querySelector(".full-terminal-root") as HTMLElement;
    expect(root).toBeTruthy();
    expect(root.dataset.paneId).toBe("p1");
    expect(root?.hasAttribute("data-react-full-terminal")).toBeTrue();
    const chrome = root.querySelector(".full-terminal-chrome");
    const host = root.querySelector(".full-terminal-host");
    const pad = root.querySelector(".full-terminal-pad");
    expect([...root.children].map((el) => el.className.split(" ")[0])).toEqual(["chrome", "full-terminal-host", "full-terminal-pad"]);
    expect(host?.contains(root.querySelector(".full-terminal-scroll")!)).toBeTrue();
    expect(host?.querySelector(".full-terminal-pan > .full-terminal-canvas")).toBeTruthy();
    expect(chrome?.querySelector(".full-terminal-title")).toBeTruthy();
    expect(chrome?.querySelector(".full-terminal-status")?.textContent).toBe(getFullTerminalView().detail);
    expect(chrome?.querySelector(".icon-workspace")).toBeTruthy();
    expect(chrome?.querySelector(".icon-more")).toBeTruthy();
    expect(getFullTerminalView().working).toBeTrue();
    expect(chrome?.querySelector(".icon-stop")).toBeTruthy();
    expect(app.querySelector(".full-terminal-state")?.getAttribute("role")).toBe("status");
    await waitUntil(() => Boolean(app.querySelector(".xterm")), "xterm");
    // Fully settle the terminal open (live stage) before asserting the mounted
    // shell; openBridge's live emit must not publish after this act boundary.
    await waitUntil(() => getFullTerminalView().stage === "live", "live after xterm");
    expect(app.querySelector(".full-terminal-canvas .xterm")).toBeTruthy();
    expect(app.querySelector(".full-terminal-canvas .xterm-helper-textarea")).toBeTruthy();
    expect(pad).toBeTruthy();
  });

  test("keeps host and helper textarea across chrome subscription updates", async () => {
    act(boot);
    // Original precondition: the helper textarea must exist before identity
    // assertions (the identity checks are otherwise vacuous null===null). Then
    // additionally wait for the terminal open to fully settle (stage live) so
    // openBridge's live emit never publishes after this act boundary.
    await waitUntil(() => Boolean(app.querySelector(".xterm-helper-textarea")), "textarea");
    await waitUntil(() => getFullTerminalView().stage === "live", "live after helper");
    const host = app.querySelector(".full-terminal-host");
    const canvas = app.querySelector(".full-terminal-canvas");
    const field = app.querySelector(".xterm-helper-textarea");
    const paints: number[] = [];
    const stop = subscribeFullTerminalView(() => paints.push(1));
    act(() => {
      applySnapshot({
        workspaces: [{ workspace_id: "w1", label: "demo", cwd: "/tmp/demo" }],
        panes: [{ pane_id: "p1", workspace_id: "w1", agent: "herdr", agent_status: "idle" }],
      });
      syncFullTerminalChrome();
    });
    expect((app.querySelector(".icon-stop")) === null).toBeTrue();
    expect(app.querySelector(".full-terminal-host") === host).toBeTrue();
    expect(app.querySelector(".full-terminal-canvas") === canvas).toBeTrue();
    expect(app.querySelector(".xterm-helper-textarea") === field).toBeTrue();
    stop();
    expect(paints.length).toBeGreaterThan(0);
  });

  test("repeated live frames do not rebuild the engine", async () => {
    act(boot);
    await waitUntil(() => getFullTerminalView().stage === "live", "live");
    const host = app.querySelector(".full-terminal-host");
    const field = app.querySelector(".xterm-helper-textarea");
    let views = 0;
    const stop = subscribeFullTerminalView(() => {
      views += 1;
    });
    handleFullTerminalEvent({
      type: "terminal_frame",
      terminalId: "term_11111111111111111111111111111111",
      terminalFrame: {
        terminalId: "term_11111111111111111111111111111111",
        sequence: "1",
        width: 80,
        height: 24,
        full: true,
        index: 0,
        count: 1,
        data: new Uint8Array([65]),
      },
    });
    const afterFirst = views;
    for (let i = 0; i < 3; i++) {
      handleFullTerminalEvent({
        type: "terminal_frame",
        terminalId: "term_11111111111111111111111111111111",
        terminalFrame: {
          terminalId: "term_11111111111111111111111111111111",
          sequence: String(i + 2),
          width: 80,
          height: 24,
          full: false,
          index: 0,
          count: 1,
          data: new Uint8Array([65]),
        },
      });
    }
    stop();
    expect(app.querySelector(".full-terminal-host") === host).toBeTrue();
    expect(app.querySelector(".xterm-helper-textarea") === field).toBeTrue();
    expect(views).toBe(afterFirst);
  });

  test("async error and retry ARIA come from the view store", async () => {
    disposeFullTerminal();
    act(() => {
      setPhase("live");
      setScreen("pane");
      selectPane("p1");
      resetPaneView();
      setFullTerminal(true);
      attachLiveSession(live({
        terminalOpen: async () => {
          throw new Error("nope");
        },
      }) as unknown as LiveSession);
      applySnapshot({
        workspaces: [{ workspace_id: "w1", label: "demo", cwd: "/tmp/demo" }],
        panes: [{ pane_id: "p1", workspace_id: "w1", agent: "herdr", agent_status: "working" }],
      });
    });
    await waitUntil(() => app.querySelector<HTMLElement>(".full-terminal-state")?.dataset.stage === "error", "error");
    await waitUntil(() => getFullTerminalView().retry, "retry eligible");
    const layer = app.querySelector<HTMLElement>(".full-terminal-state")!;
    expect(layer.getAttribute("role")).toBe("alert");
    expect(layer.getAttribute("aria-live")).toBe("assertive");
    expect(layer.querySelector<HTMLButtonElement>(".full-terminal-state-retry")?.hidden).toBeFalse();
    expect(getFullTerminalView().retry).toBeTrue();
    expect(app.querySelector(".full-terminal-status")?.textContent).toBe(getFullTerminalView().detail);
  });

  test("FullTerminalScreen is the route component", () => {
    // Isolated component boundary: a private fixture root renders only the
    // shell with explicit ports; it never uses the App screen bridge.
    let isolated: Root | null = null;
    const container = document.createElement("div");
    document.body.append(container);
    act(() => {
      isolated = createRoot(container);
      isolated.render(createElement(FullTerminalScreen, {
        onBack: () => undefined,
        onWorkspace: () => undefined,
        onMenu: () => undefined,
        onStop: () => undefined,
        onRetry: () => undefined,
        scroll: () => undefined,
        pageLines: () => 23,
        controls: { sendKey: () => undefined, sendCompose: () => false, desk: false,
          keyboard: { open() {}, close() {}, toggle() {}, isOpen: () => false } },
      }));
    });
    expect(container.querySelector(".full-terminal-root")).toBeTruthy();
    expect(container.querySelector("[data-react-full-terminal]")).toBeTruthy();
    act(() => isolated?.unmount());
    container.remove();
  });
});
