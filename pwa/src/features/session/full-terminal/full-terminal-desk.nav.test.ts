import { expectSameNode } from "../../../../test-support/node-identity";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { lang, setLang } from "../../../lib/i18n";
import type { LiveSession } from "../../../lib/protocol/client";

/**
 * The complete terminal as one column of the desk shell.
 *
 * It used to own the whole viewport, so nothing else could be reached while it
 * was open. Beside the list every one of these is a click away, and each has to
 * leave exactly one renderer, one bridge and no blank column behind.
 */

class TestTerminal {
  /** How often the keyboard was handed to a renderer. */
  static focused = 0;
  /** The row the next frame leaves the cursor on. */
  static cursorRow = 0;
  cols = 80;
  rows = 24;
  modes = { applicationCursorKeysMode: false };
  buffer = { active: { cursorY: 0 } };
  element: HTMLElement | undefined;
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
    this.element = this.root;
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
  focus(): void { TestTerminal.focused++; }
  reset(): void {}
  write(_data: Uint8Array, done?: () => void): void {
    this.buffer.active.cursorY = TestTerminal.cursorRow;
    done?.();
  }
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
const { isFullTerminal, openPaneId, resetPaneView, selectPane, setAgentChat, setFullTerminal } =
  await import("../session-store.ts");
const { setComposeLive } = await import("../compose-store.ts");
const { attachLiveSession } = await import("../../computers/catalog-store.ts");
const { applySnapshot } = await import("../../dashboard/catalog-store.ts");
const { setOperationBusy } = await import("../../operations/capabilities-store.ts");
const { setPaneTermMode } = await import("../../settings/preferences-store.ts");
const { leaveSettings, openSettings } = await import("../../settings/actions.ts");
const { leaveComputers, openComputers } = await import("../../computers/actions.ts");
const { setInspectorOpen } = await import("../../workspace/inspector-store.ts");
const { closePane } = await import("../../operations/controller.ts");
const { openPane, refreshSnapshot } = await import("../../connection/controller.ts");
const { disposeFullTerminal, handleFullTerminalEvent, leaveFullTerminal } = await import("./full-terminal.ts");
const { getFullTerminalView } = await import("./full-terminal-view.ts");
const { liftPanCanvas } = await import("./full-terminal-lift.ts");
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

/** A session that opens every bridge at once and remembers what it was asked. */
function bridges() {
  const opened: Array<{ paneId: string; id: string }> = [];
  const closed: string[] = [];
  const resized: Array<[number, number]> = [];
  const session = {
    snapshot: async () => ({ panes: [] }),
    closePane: async () => undefined,
    getConfig: async () => ({}),
    listDevices: async () => ({ devices: [] }),
    terminalOpen: async (paneId: string, cols: number, rows: number) => {
      const id = `term_${String(opened.length + 1).padStart(32, "0")}`;
      opened.push({ paneId, id });
      return { operationId: "op_AAECAwQFBgcICQoL", terminalId: id, paneId, cols, rows, encoding: "ansi" as const };
    },
    terminalClose: async (id: string) => { closed.push(id); },
    terminalInput: async () => undefined,
    terminalResize: async (_id: string, _sequence: number, cols: number, rows: number) => { resized.push([cols, rows]); },
    terminalScroll: async () => undefined,
    sendText: async () => undefined,
    sendKeys: async () => undefined,
    isConnected: () => true,
    onEvent: () => () => undefined,
    reconnectNow: () => undefined,
    close: () => undefined,
  } as unknown as LiveSession;
  return { session, opened, closed, resized };
}

function bootDeskTerminal(session: LiveSession, panes: readonly string[] = ["p1", "p2"]): void {
  happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
  act(() => {
    disposeFullTerminal();
    batch(() => {
      setPhase("live");
      setScreen("pane");
      selectPane("p1");
      resetPaneView();
      setComposeLive(false);
      setAgentChat(false);
      setFullTerminal(true);
      setNetworkOnline(true);
      setOperationBusy(false);
      attachLiveSession(session);
      publishPanes(panes);
      for (const paneId of panes) setPaneTermMode(paneId, "full");
    });
    commitView();
  });
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 10)); });
  }
  throw new Error(`timed out waiting for ${label}`);
}

const terminalRoot = () => app.querySelector<HTMLElement>(".main .full-terminal-root");
const terminalHost = () => app.querySelector<HTMLElement>(".main .full-terminal-host");
const live = () => getFullTerminalView().stage === "live";

let baselineLang: ReturnType<typeof lang> = "zh";

beforeEach(async () => {
  await resetBoardTestDOM();
  resetTransitionState();
  resetComposeDrafts();
  baselineLang = lang();
  setLang("zh");
  registerSessionOwnerPreparer(registerSessionView);
  act(() => mountApp());
});

afterEach(async () => {
  await act(async () => {
    await leaveFullTerminal({ rememberGuided: false, paint: false });
    disposeFullTerminal();
    setInspectorOpen(false);
    resetComposeDrafts();
    unmountApp();
    setLang(baselineLang);
    registerSessionOwnerPreparer(null);
    attachLiveSession(null);
    setScreen("home");
    resetTransitionState();
    happy.happyDOM.setWindowSize({ width: 390, height: 844 });
    await happy.happyDOM.abort();
  });
  expect(appHost()).toBeNull();
  expect(isAppMounted()).toBeFalse();
});

describe("complete terminal beside the list", () => {
  test("it fills the main column, the list stays, and it has no back of its own", async () => {
    const { session, opened } = bridges();
    bootDeskTerminal(session);
    await waitUntil(live, "live terminal");

    expect(app.classList.contains("desk")).toBeTrue();
    expect(app.classList.contains("session")).toBeFalse();
    expect(app.querySelector(".rail")).not.toBeNull();
    expect(terminalRoot()?.dataset.paneId).toBe("p1");
    expect(terminalRoot()?.querySelector(".back")).toBeNull();
    expect(terminalHost()?.querySelector(".xterm")).not.toBeNull();
    expect(opened.map((bridge) => bridge.paneId)).toEqual(["p1"]);
  });

  test("another complete-terminal session from the list swaps the bridge, never stacks one", async () => {
    const { session, opened, closed } = bridges();
    bootDeskTerminal(session);
    await waitUntil(live, "first terminal");

    await act(async () => { await openPane("p2"); });
    await waitUntil(() => opened.length === 2 && live(), "second terminal");

    expect(closed).toEqual([opened[0].id]);
    expect(opened.map((bridge) => bridge.paneId)).toEqual(["p1", "p2"]);
    expect(openPaneId()).toBe("p2");
    expect(terminalRoot()?.dataset.paneId).toBe("p2");
    expect(app.querySelectorAll(".full-terminal-root")).toHaveLength(1);
    expect(app.querySelectorAll(".xterm")).toHaveLength(1);
    expect(app.querySelector(".rail")).not.toBeNull();
  });

  test("its own row in the list keeps the renderer, the bridge and the mode, and hands it the keyboard", async () => {
    const { session, opened, closed, resized } = bridges();
    bootDeskTerminal(session);
    await waitUntil(live, "terminal before its own row");
    const host = terminalHost();
    const xterm = host?.querySelector(".xterm");
    const asked = resized.length;
    // The mode stored for the pane is not the one on screen: a second open would drop to it.
    act(() => setPaneTermMode("p1", "guided"));
    const row = document.createElement("button");
    app.querySelector(".rail")!.append(row);
    act(() => row.focus());
    const handed = TestTerminal.focused;

    await act(async () => { await openPane("p1"); });
    await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 20)); });

    expect(isFullTerminal()).toBeTrue();
    expect(openPaneId()).toBe("p1");
    expect(terminalHost() === host).toBeTrue();
    expectSameNode(terminalHost()?.querySelector(".xterm"), xterm);
    expect(opened).toHaveLength(1);
    expect(closed).toEqual([]);
    expect(resized).toHaveLength(asked);
    expect(live()).toBeTrue();
    expect(TestTerminal.focused).toBe(handed + 1);
  });

  test("its own row while Settings fills the column brings it back with a fresh renderer and bridge", async () => {
    const { session, opened, closed } = bridges();
    bootDeskTerminal(session);
    await waitUntil(live, "terminal before settings");
    act(() => openSettings());
    await waitUntil(() => closed.length === 1, "bridge released for settings");

    // Not on screen any more: this is an open, through the same paintless leave as any other.
    await act(async () => { await openPane("p1"); });
    await waitUntil(() => opened.length === 2 && live(), "terminal after its own row");

    expect(currentScreen()).toBe("pane");
    expect(isFullTerminal()).toBeTrue();
    expect(opened.map((bridge) => bridge.paneId)).toEqual(["p1", "p1"]);
    expect(closed).toEqual([opened[0].id]);
    expect(app.querySelectorAll(".full-terminal-root")).toHaveLength(1);
    expect(terminalHost()?.querySelector(".xterm")).not.toBeNull();
  });

  test("a guided session from the list closes the bridge and fills the column with that pane", async () => {
    const { session, opened, closed } = bridges();
    bootDeskTerminal(session);
    await waitUntil(live, "first terminal");
    act(() => setPaneTermMode("p2", "guided"));

    await act(async () => { await openPane("p2"); });

    expect(isFullTerminal()).toBeFalse();
    expect(closed).toEqual([opened[0].id]);
    expect(opened).toHaveLength(1);
    expect(app.querySelector(".full-terminal-root")).toBeNull();
    expect(app.querySelector(".main [data-react-guided-pane]")).not.toBeNull();
    expect(document.documentElement.classList.contains("full-terminal-active")).toBeFalse();
    // The stale bridge's frames no longer belong to anything on screen.
    expect(handleFullTerminalEvent({ type: "terminal_closed", terminalId: opened[0].id } as never)).toBeFalse();
  });

  test("Settings from the list releases the bridge; coming back opens a fresh one", async () => {
    const { session, opened, closed } = bridges();
    bootDeskTerminal(session);
    await waitUntil(live, "terminal before settings");

    act(() => openSettings());
    await waitUntil(() => closed.length === 1, "bridge released for settings");
    expect(currentScreen()).toBe("settings");
    expect(app.querySelector(".main-settings")).not.toBeNull();
    expect(app.querySelector(".full-terminal-root")).toBeNull();
    expect(app.querySelector(".xterm")).toBeNull();
    expect(closed).toEqual([opened[0].id]);
    // The mode is remembered, the page-wide terminal styling is not.
    expect(isFullTerminal()).toBeTrue();
    expect(document.documentElement.classList.contains("full-terminal-active")).toBeFalse();

    act(() => leaveSettings());
    await waitUntil(() => opened.length === 2 && live(), "terminal after settings");
    expect(currentScreen()).toBe("pane");
    expect(terminalRoot()?.dataset.paneId).toBe("p1");
    expect(terminalHost()?.querySelector(".xterm")).not.toBeNull();
    expect(app.querySelector<HTMLElement>(".full-terminal-state")?.hidden).toBeTrue();
    expect(closed).toHaveLength(1);
    expect(document.documentElement.classList.contains("full-terminal-active")).toBeTrue();
  });

  test("the computer list in the main column is the same round trip", async () => {
    const { session, opened, closed } = bridges();
    bootDeskTerminal(session);
    await waitUntil(live, "terminal before computers");

    act(() => openComputers());
    await waitUntil(() => closed.length === 1, "bridge released for computers");
    expect(app.querySelector(".full-terminal-root")).toBeNull();

    act(() => leaveComputers("pane"));
    await waitUntil(() => opened.length === 2 && live(), "terminal after computers");
    expect(terminalHost()?.querySelector(".xterm")).not.toBeNull();
    expect(closed).toEqual([opened[0].id]);
  });

  test("opening and closing the inspector keeps the terminal, its bridge and its columns", async () => {
    const { session, opened, closed, resized } = bridges();
    bootDeskTerminal(session);
    await waitUntil(live, "terminal before inspector");
    const host = terminalHost();
    const xterm = host?.querySelector(".xterm");
    const asked = resized.length;

    act(() => { setInspectorOpen(true); commitView(); });
    expect(app.classList.contains("inspector")).toBeTrue();
    expect(app.querySelector(".rail")).not.toBeNull();
    expect(isFullTerminal()).toBeTrue();
    expect(terminalHost() === host).toBeTrue();
    expectSameNode(terminalHost()?.querySelector(".xterm"), xterm);
    expect(app.querySelector(".icon-workspace")?.getAttribute("aria-pressed")).toBe("true");

    act(() => { setInspectorOpen(false); commitView(); });
    await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 20)); });
    expect(app.classList.contains("inspector")).toBeFalse();
    expect(terminalHost() === host).toBeTrue();
    expect(app.querySelector(".icon-workspace")?.getAttribute("aria-pressed")).toBe("false");

    expect(opened).toHaveLength(1);
    expect(closed).toEqual([]);
    expect(resized).toHaveLength(asked);
    expect(live()).toBeTrue();
  });

  test("the computer is asked once per size, and a frame that answers a request asks nothing more", async () => {
    const { session, opened, resized } = bridges();
    bootDeskTerminal(session);
    await waitUntil(live, "terminal before frames");
    let sequence = 0;
    const frame = async (width: number, height: number): Promise<void> => {
      await act(async () => {
        handleFullTerminalEvent({
          type: "terminal_frame",
          terminalId: opened[0].id,
          terminalFrame: {
            terminalId: opened[0].id, sequence: String(++sequence), width, height,
            full: true, index: 0, count: 1, data: new Uint8Array([65]),
          },
        });
        await new Promise<void>((resolve) => window.setTimeout(resolve, 10));
      });
    };

    // The bridge opened with a grid only: the first frame's refit carries the cell size, once.
    await frame(80, 24);
    expect(resized).toEqual([[80, 24]]);
    await frame(80, 24);
    expect(resized).toHaveLength(1);

    // The computer moved to another grid on its own: it is told the wanted one again.
    await frame(100, 30);
    expect(resized).toEqual([[80, 24], [80, 24]]);
    // Its answer lands on the size already asked for: nothing more to say.
    await frame(80, 24);
    expect(resized).toHaveLength(2);
  });

  test("a frame that moves the cursor under the key pad slides the canvas after it, and back", async () => {
    const { session, opened, resized } = bridges();
    bootDeskTerminal(session);
    await waitUntil(live, "terminal before frames");
    const canvas = terminalHost()!.querySelector<HTMLElement>(".full-terminal-canvas")!;
    // What a fit leaves behind with the pad open: a 722px room, 544px of it in view.
    liftPanCanvas(canvas, 722, 544);
    let sequence = 0;
    const frame = async (cursorRow: number): Promise<void> => {
      TestTerminal.cursorRow = cursorRow;
      await act(async () => {
        handleFullTerminalEvent({
          type: "terminal_frame",
          terminalId: opened[0].id,
          terminalFrame: {
            terminalId: opened[0].id, sequence: String(++sequence), width: 80, height: 24,
            full: sequence === 1, index: 0, count: 1, data: new Uint8Array([65]),
          },
        });
        await new Promise<void>((resolve) => window.setTimeout(resolve, 10));
      });
    };

    try {
      // 16px rows: the first 34 fit in 544px.
      await frame(0);
      expect(canvas.style.marginTop).toBe("");
      const asked = resized.length;
      await frame(33);
      expect(canvas.style.marginTop).toBe("");
      await frame(40);
      expect(canvas.style.marginTop).toBe("-112px");
      await frame(2);
      expect(canvas.style.marginTop).toBe("");
      // Following the cursor asks nothing of the computer.
      expect(resized).toHaveLength(asked);
    } finally {
      TestTerminal.cursorRow = 0;
    }
  });

  test("without room for three columns the list gives way and the header leads back to it", async () => {
    const { session, opened, closed } = bridges();
    bootDeskTerminal(session);
    happy.happyDOM.setWindowSize({ width: 1024, height: 768 });
    act(() => commitView());
    await waitUntil(live, "terminal at 1024");
    const host = terminalHost();

    act(() => { setInspectorOpen(true); commitView(); });
    expect(app.classList.contains("rail-hidden")).toBeTrue();
    expect(terminalHost() === host).toBeTrue();
    const back = terminalRoot()?.querySelector<HTMLButtonElement>(".back");
    expect(back).not.toBeNull();

    // That back closes the inspector; it does not leave the session.
    act(() => back!.click());
    expect(app.classList.contains("inspector")).toBeFalse();
    expect(currentScreen()).toBe("pane");
    expect(isFullTerminal()).toBeTrue();
    expect(terminalHost() === host).toBeTrue();
    expect(opened).toHaveLength(1);
    expect(closed).toEqual([]);
  });

  test("a pane that disappears leaves the empty main, not a dead terminal", async () => {
    const { session, opened } = bridges();
    bootDeskTerminal(session);
    await waitUntil(live, "terminal before the pane goes");

    // The next snapshot from the computer no longer reports it.
    (session as unknown as { snapshot: () => Promise<unknown> }).snapshot =
      async () => ({ focused: { pane_id: "p2" }, workspaces: DEMO_WORKSPACES, panes: [paneCard("p2")] });
    await act(async () => { await refreshSnapshot(); });

    expect(isFullTerminal()).toBeFalse();
    expect(app.querySelector(".full-terminal-root")).toBeNull();
    expect(app.querySelector(".xterm")).toBeNull();
    expect(app.querySelector(".rail")).not.toBeNull();
    expect(app.querySelector(".main")).not.toBeNull();
    expect(document.documentElement.classList.contains("full-terminal-active")).toBeFalse();
    // Its bridge died with the pane; a late event for it is nobody's.
    expect(handleFullTerminalEvent({ type: "terminal_closed", terminalId: opened[0].id } as never)).toBeFalse();
  });

  test("closing the session closes its bridge once and returns the column to the list's choice", async () => {
    const { session, opened, closed } = bridges();
    let paneClosed = 0;
    (session as unknown as { closePane: () => Promise<void> }).closePane = async () => { paneClosed++; };
    bootDeskTerminal(session);
    await waitUntil(live, "terminal before close");

    let closing!: Promise<void>;
    act(() => { closing = closePane(); });
    await act(async () => { await Promise.resolve(); });
    const confirm = [...(happy.document.querySelector("dialog.modal")?.querySelectorAll("button") ?? [])]
      .find((button) => button.className.includes("btn-danger"));
    if (!(confirm instanceof happy.HTMLButtonElement)) throw new Error("missing close confirmation");
    act(() => confirm.click());
    await act(async () => { await closing; });

    expect(paneClosed).toBe(1);
    expect(closed).toEqual([opened[0].id]);
    expect(isFullTerminal()).toBeFalse();
    expect(app.querySelector(".full-terminal-root")).toBeNull();
    expect(app.querySelector(".xterm")).toBeNull();
    expect(app.querySelector(".rail")).not.toBeNull();
  });

  test("narrowing the window to a phone moves the terminal to its own screen with a new bridge", async () => {
    const { session, opened, closed } = bridges();
    bootDeskTerminal(session);
    await waitUntil(live, "desk terminal");

    happy.happyDOM.setWindowSize({ width: 390, height: 844 });
    act(() => commitView());
    await waitUntil(() => opened.length === 2 && live(), "phone terminal");

    expect(app.classList.contains("desk")).toBeFalse();
    expect(app.querySelector(".rail")).toBeNull();
    expect(app.querySelectorAll(".full-terminal-root")).toHaveLength(1);
    expect(app.querySelector(".full-terminal-root .back")).not.toBeNull();
    expect(closed).toEqual([opened[0].id]);
  });
});
