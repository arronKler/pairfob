import { beforeEach, afterEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { resetBoardTestDOM } from "../../../../test-support/dom";

class ReviewTerminal {
  cols = 80;
  rows = 24;
  modes = { applicationCursorKeysMode: false };
  buffer = { active: { cursorX: 0, cursorY: 0 } };
  _core = { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } };
  options: { fontSize?: number; lineHeight?: number };
  private root: HTMLElement | null = null;
  private data: (value: string) => void = () => {};
  constructor(options: { fontSize?: number; lineHeight?: number }) { this.options = { ...options }; }
  loadAddon(_addon: object): void {}
  open(mount: HTMLElement): void {
    const root = document.createElement("div");
    root.className = "xterm";
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    screen.append(document.createElement("canvas"));
    const input = document.createElement("textarea");
    input.className = "xterm-helper-textarea";
    root.append(screen, input);
    mount.append(root);
    this.root = root;
  }
  resize(cols: number, rows: number): void { this.cols = cols; this.rows = rows; }
  registerLinkProvider(_provider: object): void {}
  onData(listener: (value: string) => void): void { this.data = listener; }
  onBinary(_listener: (value: string) => void): void {}
  onResize(_listener: () => void): void {}
  input(value: string): void { this.data(value); }
  focus(): void { this.root?.querySelector("textarea")?.focus(); }
  reset(): void {}
  write(_data: Uint8Array, done?: () => void): void { done?.(); }
  dispose(): void { this.root?.remove(); }
}

mock.module("./full-terminal-loader", () => ({
  fullTerminalSupported: () => true,
  terminalWebglSupported: () => true,
  loadFullTerminalXterm: async () => ({
    Terminal: ReviewTerminal,
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
const { resetComposeDrafts } = await import("../drafts/compose-drafts");
const { setLang } = await import("../../../lib/i18n");
const { setPhase, setNetworkOnline } = await import("../../connection/connection-store.ts");
const { setScreen } = await import("../../../app/navigation-store.ts");
const { resetPaneView, selectPane, setFullTerminal, setAgentChat } = await import("../session-store.ts");
const { composeFocused, composeIME, setComposeDraft, setComposeFocused, setComposeIME, setComposeLive } =
  await import("../compose-store.ts");
const { setKeysExpanded, setPadKind, setPaneComposeLive, setPaneTermMode } = await import("../../settings/preferences-store.ts");
const { attachLiveSession } = await import("../../computers/catalog-store.ts");
const { applySnapshot } = await import("../../dashboard/catalog-store.ts");
const { applyRuntimeIdentity } = await import("../../connection/runtime-store.ts");
const {
  disposeFullTerminal, leaveFullTerminal, getFullTerminalView,
  sendFullTerminalScroll, syncFullTerminalChrome, setFullTerminalComposeLive,
} = await import("./full-terminal");
const { notifyFullTerminalKeyboard } = await import("./full-terminal-input");
import { happy } from "../../../../test-support/dom";
import type { LiveSession } from "../../../lib/protocol/client";

const app = appRoot();

type OpenResult = {
  operationId: string; terminalId: string; paneId: string; cols: number; rows: number; encoding: "ansi";
};
function opened(paneId = "p1", cols = 80, rows = 24, id = "1"): OpenResult {
  return { operationId: "op_AAECAwQFBgcICQoL", terminalId: `term_${id.repeat(32)}`, paneId, cols, rows, encoding: "ansi" };
}
function session() {
  const calls: string[] = [];
  return {
    calls,
    terminalOpen: async (pane: string, cols: number, rows: number): Promise<OpenResult> => {
      calls.push(`open:${pane}`); return opened(pane, cols, rows);
    },
    terminalClose: async (id: string) => { calls.push(`close:${id}`); },
    terminalInput: async (_id: string, _sequence: number, data: Uint8Array) => { calls.push(`input:${new TextDecoder().decode(data)}`); },
    terminalResize: async () => undefined,
    terminalScroll: async () => { calls.push("scroll"); },
    isConnected: () => true,
    onEvent: () => () => undefined,
    close: () => undefined,
  };
}

function boot(liveObj = session(), composeLiveMode = false): void {
  act(() => {
    disposeFullTerminal();
    setPhase("live");
    setScreen("pane");
    selectPane("p1");
    resetPaneView();
    setFullTerminal(true);
    setAgentChat(false);
    setComposeLive(composeLiveMode);
    setNetworkOnline(true);
    applyRuntimeIdentity({ herdHost: "", runtimeKind: "herdr" });
    attachLiveSession(liveObj as unknown as LiveSession);
    applySnapshot({
      workspaces: [{ workspace_id: "w1", label: "demo", cwd: "/tmp/demo" }],
      panes: [{ pane_id: "p1", workspace_id: "w1", agent: "herdr", agent_status: "working" }],
    });
    commitView();
  });
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 10)); });
  }
  throw new Error(`timed out: ${label}`);
}
function pointer(button: HTMLElement): void {
  const view = app.ownerDocument.defaultView!;
  button.dispatchEvent(new view.PointerEvent("pointerdown", { button: 0, bubbles: true, cancelable: true }));
  button.dispatchEvent(new view.PointerEvent("pointerup", { button: 0, bubbles: true, cancelable: true }));
}

beforeEach(async () => {
  await resetBoardTestDOM();
  resetTransitionState();
  resetComposeDrafts();
  setLang("zh");
  act(() => {
    notifyFullTerminalKeyboard(false);
    setComposeDraft("");
    setComposeFocused(false);
    setComposeIME(false);
    setKeysExpanded(false);
    setPadKind("keys");
    setPaneComposeLive("p1", false);
    setPaneTermMode("p1", "full");
    registerSessionOwnerPreparer(registerSessionView);
    mountApp();
  });
});
afterEach(async () => {
  await act(async () => {
    await leaveFullTerminal({ rememberGuided: false, paint: false });
    disposeFullTerminal();
    unmountApp();
    registerSessionOwnerPreparer(null);
    attachLiveSession(null);
    notifyFullTerminalKeyboard(false);
    setComposeIME(false);
    setComposeFocused(false);
    resetTransitionState();
    await happy.happyDOM.abort();
  });
  expect(appHost()).toBeNull();
  expect(isAppMounted()).toBeFalse();
});

describe("independent complete-terminal React review", () => {
  test("remote scroll closes the helper and updates the keyboard control", async () => {
    const live = session();
    await act(() => boot(live, true));
    await until(() => getFullTerminalView().stage === "live", "live terminal");
    const button = app.querySelector<HTMLButtonElement>(".full-terminal-kb")!;
    await act(() => pointer(button));
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(app.querySelector(".full-terminal-host")?.classList.contains("kb-on")).toBeTrue();
    await act(() => sendFullTerminalScroll("down", 3, "wheel"));
    expect(live.calls).toContain("scroll");
    expect(app.querySelector(".full-terminal-host")?.classList.contains("kb-off")).toBeTrue();
    expect((app.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement).readOnly).toBeTrue();
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.textContent).toBe("点这里输入");
  });

  test("chrome, full paint and pad expansion retain the active IME field and engine", async () => {
    await act(() => boot());
    await until(() => getFullTerminalView().stage === "live", "live terminal");
    const host = app.querySelector(".full-terminal-host");
    const helper = app.querySelector(".xterm-helper-textarea");
    const field = app.querySelector<HTMLTextAreaElement>(".full-terminal-compose-input")!;
    const view = app.ownerDocument.defaultView!;
    await act(() => {
      field.focus();
      field.dispatchEvent(new view.Event("compositionstart"));
      field.value = "输入中文";
      field.dispatchEvent(new view.Event("input"));
      field.setSelectionRange(1, 3);
      applySnapshot({
        workspaces: [{ workspace_id: "w1", label: "demo", cwd: "/tmp/demo" }],
        panes: [{ pane_id: "p1", workspace_id: "w1", agent: "herdr", agent_status: "idle" }],
      });
      syncFullTerminalChrome();
      commitView();
    });
    const more = app.querySelector<HTMLButtonElement>(".key-more")!;
    await act(() => { pointer(more); more.click(); });
    expect(app.querySelector(".full-terminal-host") === host).toBeTrue();
    expect(app.querySelector(".xterm-helper-textarea") === helper).toBeTrue();
    expect(app.querySelector(".full-terminal-compose-input") === field).toBeTrue();
    expect(document.activeElement === field).toBeTrue();
    expect(field.value).toBe("输入中文");
    expect([field.selectionStart, field.selectionEnd]).toEqual([1, 3]);
    expect(composeIME()).toBeTrue();
    expect(app.querySelector(".icon-stop")).toBeNull();
  });

  test("mode changes keep the engine and send draft once without replay on repaint", async () => {
    const live = session();
    await act(() => boot(live));
    await until(() => getFullTerminalView().stage === "live", "live terminal");
    const host = app.querySelector(".full-terminal-host");
    const helper = app.querySelector(".xterm-helper-textarea");
    // The guided draft is present on the full-terminal field before switching
    // to live input; switching sends it exactly once.
    act(() => setComposeDraft("send once"));
    await act(() => setFullTerminalComposeLive(true));
    await act(() => { commitView(); syncFullTerminalChrome(); });
    expect(live.calls.filter((call) => call.startsWith("input:"))).toEqual(["input:send once"]);
    expect(app.querySelector(".full-terminal-compose-input")).toBeNull();
    expect(app.querySelector(".full-terminal-host") === host).toBeTrue();
    expect(app.querySelector(".xterm-helper-textarea") === helper).toBeTrue();
    await act(() => setFullTerminalComposeLive(false));
    // Drain the live-mode switch and any trailing engine/view publication so
    // they never flush outside act.
    await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
    expect(app.querySelector(".full-terminal-host") === host).toBeTrue();
    expect(app.querySelector(".xterm-helper-textarea") === helper).toBeTrue();
    expect((app.querySelector(".full-terminal-compose-input") as HTMLTextAreaElement).value).toBe("");
    expect(live.calls.filter((call) => call.startsWith("input:"))).toHaveLength(1);
  });

  test("detaching an IME field invalidates its queued Enter and stale events", async () => {
    const live = session();
    await act(() => boot(live));
    await until(() => getFullTerminalView().stage === "live", "live terminal");
    const field = app.querySelector<HTMLTextAreaElement>(".full-terminal-compose-input")!;
    const view = app.ownerDocument.defaultView!;
    await act(async () => {
      field.dispatchEvent(new view.Event("compositionstart"));
      field.value = "late text";
      field.dispatchEvent(new view.Event("input"));
      field.dispatchEvent(new view.KeyboardEvent("keydown", { key: "Enter", isComposing: true }));
      field.dispatchEvent(new view.Event("compositionend"));
      disposeFullTerminal();
      // The disposal staged fullTerminal=false; publish the resulting navigation
      // (full-terminal -> guided) inside this act so the App and terminal shell
      // re-render and settle before the late-key assertion.
      commitView();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });
    await act(async () => {
      // The stale Enter on the retired field must be a no-op; dispatch it (and
      // let the resulting guided navigation settle) inside act.
      field.dispatchEvent(new view.KeyboardEvent("keydown", { key: "Enter" }));
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });
    expect(live.calls.filter((call) => call.startsWith("input:"))).toEqual([]);
    expect(app.querySelector(".xterm-helper-textarea")).toBeNull();
    expect(document.documentElement.classList.contains("full-terminal-active")).toBeFalse();
    // Terminal cleanup detaches the engine and leaves the full-terminal surface;
    // it must not unmount the stable App React root. In declarative composition
    // the terminal subtree is replaced by the next page while the App stays live.
    expect(app.querySelector(".full-terminal-root")).toBeNull();
    expect(isAppMounted()).toBeTrue();
    expect(appHost()).not.toBeNull();
  });

  test("same pane in a new session receives a fresh host after coordinated leave", async () => {
    const oldSession = session();
    await act(() => boot(oldSession));
    await until(() => getFullTerminalView().stage === "live", "old live terminal");
    const oldHost = app.querySelector(".full-terminal-host");
    const oldOwner = getFullTerminalView().owner;
    await act(async () => { await leaveFullTerminal({ rememberGuided: false, paint: false }); });
    const newSession = session();
    await act(() => boot(newSession));
    await until(() => getFullTerminalView().stage === "live", "new live terminal");
    expect(getFullTerminalView().owner === oldOwner).toBeFalse();
    expect(app.querySelector(".full-terminal-host") === oldHost).toBeFalse();
    expect(oldSession.calls.filter((call) => call.startsWith("close:"))).toHaveLength(1);
    expect(newSession.calls.filter((call) => call.startsWith("open:"))).toEqual(["open:p1"]);
    expect(oldHost?.isConnected).toBeFalse();
  });
});
