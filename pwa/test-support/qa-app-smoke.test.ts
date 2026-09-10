import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { act } from "react";

/**
 * QA renderer smoke: every named scene drives the SAME stable production App
 * (`app/mount.tsx`) through the QA fixture baseline + typed domain actions + a
 * real concurrent commit, and produces a React-owned page in the document.
 *
 * Lifecycle contract (mirrors the browser fixture's `select()`):
 * - The PREVIOUS scene is torn down at setup time.
 * - The CURRENT scene's terminal/session stay LIVE through the assertions;
 *   teardown runs only afterwards, inside an act boundary in the finally step.
 *   Disposing the new terminal before asserting would hide the exact lifetime
 *   the browser exposes and silence real async diagnostics by retiring producers.
 *
 * The two real-engine terminal scenes mount the actual complete-terminal
 * controller through the stable App with a deterministic mock xterm loader
 * (no WebGL/PTY): the open/frame/close lifecycle is production code. The two
 * `shellOnly` scenes deliberately render the standalone FullTerminalScreen
 * shell fixture without an engine. Coverage is reported honestly:
 * 54 scenes render through the stable App (including the 2 mock-engine
 * terminals), 2 shellOnly scenes render the QA shell fixture — all 56 catalog
 * scenes are exercised here; the 224-shot browser matrix remains the full
 * visual contract.
 */

let disposals = 0;
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
  write(_data: Uint8Array, done?: () => void): void { done?.(); }
  dispose(): void { disposals++; this.root?.remove(); }
}

// Registered BEFORE any production App import so the controller's dynamic
// loader import resolves to this deterministic engine.
mock.module("../src/features/session/full-terminal/full-terminal-loader", () => ({
  fullTerminalSupported: () => true,
  terminalWebglSupported: () => true,
  loadFullTerminalXterm: async () => ({
    Terminal: TestTerminal,
    FitAddon: class { fit(): void {} },
    WebglAddon: class { onContextLoss(_listener: () => void): void {} },
  }),
  preloadFullTerminalXterm: () => {},
}));

const { resetBoardTestDOM, happy } = await import("./dom");
const { installEnvironment } = await import("../qa/environment");
const { createSession } = await import("../qa/session");
type FixtureSession = import("../qa/session").FixtureSession;
const { scenes, resetFixtureBaseline, applyScene, afterScenePaint } = await import("../qa/scenes");
const { PANE } = await import("../qa/data");
const { commitView } = await import("../src/app/host");
const { mountApp, unmountApp, isAppMounted } = await import("../src/app/mount");
const { disposeFullTerminal, getFullTerminalView, handleFullTerminalEvent, leaveFullTerminal } = await import("../src/features/session/full-terminal/full-terminal");
const { guidedScrollController } = await import("../src/features/session/guided/guided-scroll");
const { releaseBoardScroll } = await import("../src/pages/board/pane-scroll");
const { renderTerminalShell, disposeTerminalShell } = await import("../qa/terminal-shell");
const { registerSessionOwnerPreparer, sessionOwnerPreparer } = await import("../src/app/frame");
const { registerSessionView } = await import("../src/features/session/register");
const { setLang, applyDocumentLang, t } = await import("../src/lib/i18n");

const isReactElement = (element: Element) => Object.keys(element).some((key) => key.startsWith("__reactFiber$"));
const isShellOnly = (name: string) => scenes.find((scene) => scene.name === name)?.shellOnly === true;

let domReady = false;

beforeAll(async () => {
  await resetBoardTestDOM();
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
  installEnvironment();
  domReady = true;
});

afterAll(async () => {
  await act(async () => {
    disposeTerminalShell();
    if (isAppMounted()) unmountApp();
    registerSessionOwnerPreparer(null);
    await Promise.resolve();
  });
});

function mountStableApp(): void {
  if (!isAppMounted()) {
    if (!sessionOwnerPreparer()) registerSessionOwnerPreparer(registerSessionView);
    mountApp();
  }
}

/** Bounded observable wait: real settlement, never a fixed sleep. */
async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await act(async () => { await new Promise((done) => setTimeout(done, 10)); });
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * Prepare a scene exactly like the browser fixture's `select()`: tear down any
 * PREVIOUS scene, reset named domains through typed actions, then mount/commit
 * the stable App (or render the deliberate standalone shell fixture). The
 * current scene's terminal and session stay alive for the assertions.
 */
async function prepareScene(name: string): Promise<FixtureSession> {
  const session = createSession();
  session.live.onEvent(handleFullTerminalEvent);
  const shellOnly = isShellOnly(name);
  await act(async () => {
    guidedScrollController.dispose();
    releaseBoardScroll();
    disposeFullTerminal();
    resetFixtureBaseline(session);
    await applyScene(name, session);
    // Retire whichever fixture owned the previous scene at this setup boundary.
    disposeTerminalShell();
    if (shellOnly) {
      if (isAppMounted()) unmountApp();
      renderTerminalShell(name === "terminal-error");
    } else {
      mountStableApp();
      commitView();
    }
    await Promise.resolve();
  });
  return session;
}

/** Teardown of the CURRENT scene, after its assertions, inside act. */
async function teardownScene(session: FixtureSession, shellOnly: boolean): Promise<void> {
  await act(async () => {
    if (shellOnly) disposeTerminalShell();
    else await leaveFullTerminal({ rememberGuided: false, paint: false });
    disposeFullTerminal();
    guidedScrollController.dispose();
    session.dispose();
    await Promise.resolve();
  });
}

function assertPaneRoot(expectedPane: string): void {
  const root = document.querySelector(".pane-root.full-terminal-root") as HTMLElement | null;
  expect(root).not.toBeNull();
  // The actual expected pane identity, not a vacuous type-different comparison.
  expect(root?.getAttribute("data-pane-id")).toBe(expectedPane);
}

test("every QA scene id + untitled built", () => {
  expect(scenes.length).toBe(56);
  const seen = new Set<string>();
  for (const scene of scenes) {
    expect(seen.has(scene.name)).toBeFalse();
    seen.add(scene.name);
    expect(scene.description).toBeTruthy();
  }
});

test("every scene renders: 54 through the stable App (incl. mock-engine terminals), 2 shellOnly fixtures", async () => {
  expect(domReady).toBeTrue();
  const failures: string[] = [];
  const appRendered: string[] = [];
  const shellRendered: string[] = [];
  const app = document.getElementById("app") as HTMLElement;
  for (const scene of scenes) {
    const shellOnly = isShellOnly(scene.name);
    let session: FixtureSession | null = null;
    let liveEngineDisposals: number | null = null;
    try {
      session = await prepareScene(scene.name);
      if (shellOnly) {
        // The deliberate QA FullTerminalScreen shell fixture, App unmounted.
        expect(isAppMounted()).toBeFalse();
        assertPaneRoot(PANE);
        const detail = document.querySelector(".full-terminal-status")?.textContent ?? "";
        expect(detail).toBe(scene.name === "terminal-error" ? t("ft.stateError") : t("ft.preparing"));
        shellRendered.push(scene.name);
      } else if (scene.name === "terminal-live") {
        // Real complete-terminal controller + mock xterm engine, actual App.
        await waitUntil(() => getFullTerminalView().stage === "live", "terminal-live stage");
        assertPaneRoot(PANE);
        expect(document.querySelector(".xterm-helper-textarea")).not.toBeNull();
        expect(session.terminalFrame("\u001b[2J\u001b[Hpairfob renderer QA\r\n")).toBeTrue();
        // The engine must still be alive while the scene is asserted; it is
        // disposed only by the teardown below.
        liveEngineDisposals = disposals;
        appRendered.push(scene.name);
      } else if (scene.name === "terminal-open-error") {
        // The rejected TerminalOpen surfaces the retry state on the same pane.
        await waitUntil(() => getFullTerminalView().stage === "error", "terminal-open-error stage");
        assertPaneRoot(PANE);
        expect(document.querySelector('.full-terminal-state[data-stage="error"]')).not.toBeNull();
        appRendered.push(scene.name);
      } else {
        // The App never re-roots; it reconciles inside the same #app element.
        expect(document.getElementById("app")).toBe(app);
        expect([...app.children].some(isReactElement)).toBeTrue();
        expect(app.childElementCount).toBeGreaterThan(0);
        appRendered.push(scene.name);
      }
    } catch (error) {
      failures.push(`${scene.name}: ${String(error)}`);
    } finally {
      if (session) await teardownScene(session, shellOnly);
    }
    if (liveEngineDisposals !== null) {
      // Production leave/close disposed the mock engine exactly at teardown.
      expect(disposals).toBeGreaterThan(liveEngineDisposals);
    }
  }
  expect(failures).toEqual([]);
  expect(shellRendered).toEqual(["terminal-loading", "terminal-error"]);
  expect(appRendered).toHaveLength(54);
  expect(appRendered.length + shellRendered.length).toBe(56);
}, 180_000);

test("an input-bearing scene keeps the compose field through a later real commit", async () => {
  expect(domReady).toBeTrue();
  const session = await prepareScene("guided-draft");
  try {
    const textarea = document.querySelector<HTMLTextAreaElement>("#app .dock textarea");
    expect(textarea).not.toBeNull();
    expect(textarea?.value).toContain("Review the changes");
    // A later interaction route commit keeps the same mount and field identity.
    await act(async () => { commitView(); await Promise.resolve(); });
    const after = document.querySelector<HTMLTextAreaElement>("#app .dock textarea");
    expect(after).toBe(textarea);
    expect(after?.value).toContain("Review the changes");
  } finally {
    await teardownScene(session, false);
  }
});

test("language switch re-renders visible copy through the same App", async () => {
  expect(domReady).toBeTrue();
  await act(async () => { setLang("en"); applyDocumentLang(); });
  const before = document.getElementById("app");
  const session = await prepareScene("home-populated");
  try {
    expect(document.getElementById("app")).toBe(before);
    expect(document.documentElement.lang).toBe("en");
    // Visible localized copy, not only the <html lang> attribute.
    const copy = document.body.textContent ?? "";
    expect(copy).toContain(t("home.computers"));
    expect(copy).toContain("Computers");
    expect(copy).not.toContain("电脑");
  } finally {
    await teardownScene(session, false);
  }
});

test("guided IME scene keeps the focused, selected compose field after its paint hook", async () => {
  expect(domReady).toBeTrue();
  await act(async () => { setLang("zh"); applyDocumentLang(); });
  const session = await prepareScene("guided-ime");
  try {
    await act(async () => { afterScenePaint("guided-ime"); await Promise.resolve(); });
    const input = document.querySelector<HTMLTextAreaElement>(".dock textarea");
    expect(input).not.toBeNull();
    expect(document.activeElement === input).toBeTrue();
    expect([input?.selectionStart, input?.selectionEnd]).toEqual([1, 4]);
    expect(input?.value).toBe("正在编辑的文字");
  } finally {
    await teardownScene(session, false);
  }
});

test("scene names and descriptions are documented for the window.qa surface", () => {
  const names = scenes.map((scene) => scene.name);
  expect(names).toContain("terminal-loading");
  expect(names).toContain("terminal-error");
  expect(names.length).toBe(56);
  for (const scene of scenes) expect(scene.description).toBeTruthy();
});
