import { expectSameNode } from "./node-identity";
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
 * The real-engine terminal scenes mount the actual complete-terminal
 * controller through the stable App with a deterministic mock xterm loader
 * (no WebGL/PTY): the open/frame/close lifecycle is production code. The two
 * `shellOnly` scenes deliberately render the standalone FullTerminalScreen
 * shell fixture without an engine. Coverage is reported honestly:
 * 103 scenes render through the stable App (including the 5 mock-engine
 * terminals), 2 shellOnly scenes render the QA shell fixture — all 105 catalog
 * scenes are exercised here; the browser matrix remains the full visual
 * contract.
 *
 * The loop runs at phone width against the baseline computer. What a scene
 * shows only on a wider layout (the inspector column, the rail) or only with
 * its own computer (a drawn terminal, a second Herdr session), and what it adds
 * after paint (search and jump), is asserted by the tests after the loop.
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
type SessionSource = import("../qa/session").SessionSource;
const { scenes, resetFixtureBaseline, applyScene, afterScenePaint, sceneSource, terminalSceneReadiness } = await import("../qa/scenes");
const { PANE } = await import("../qa/data");
const { FIXED_NOW } = await import("../qa/environment");
const { closeTestDialogs } = await import("./close-dialogs");
const { commitView } = await import("../src/app/host");
const { mountApp, unmountApp, isAppMounted } = await import("../src/app/mount");
const { disposeFullTerminal, getFullTerminalView, handleFullTerminalEvent, leaveFullTerminal } = await import("../src/features/session/full-terminal/full-terminal");
const { guidedScrollController } = await import("../src/features/session/guided/guided-scroll");
const { releaseBoardScroll } = await import("../src/pages/board/pane-scroll");
const { renderTerminalShell, disposeTerminalShell } = await import("../qa/terminal-shell");
const { registerSessionOwnerPreparer, sessionOwnerPreparer } = await import("../src/app/frame");
const { registerSessionView } = await import("../src/features/session/register");
const { setLang, applyDocumentLang, t } = await import("../src/lib/i18n");
const { inspectorOpen } = await import("../src/features/workspace/inspector-store");
const { composeLive } = await import("../src/features/session/compose-store");
const { keysExpanded, paneActivated, PANE_ACTIVATED_KEY } = await import("../src/features/settings/preferences-store");
const { needsDaemonUpdate } = await import("../src/features/settings/daemon-update");
const { currentDaemonId } = await import("../src/features/computers/catalog-store");
const { diffNotes } = await import("../src/lib/diff-notes");

const isReactElement = (element: Element) => Object.keys(element).some((key) => key.startsWith("__reactFiber$"));
const isShellOnly = (name: string) => scenes.find((scene) => scene.name === name)?.shellOnly === true;

let domReady = false;

beforeAll(async () => {
  await resetBoardTestDOM();
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
  installEnvironment();
  // Bun and HappyDOM have separate global/window fetch; the browser fixture has one.
  globalThis.fetch = window.fetch as typeof globalThis.fetch;
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
async function prepareScene(name: string, source: SessionSource = {}): Promise<FixtureSession> {
  const session = createSession(source);
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
  expect(scenes.length).toBe(105);
  const seen = new Set<string>();
  for (const scene of scenes) {
    expect(seen.has(scene.name)).toBeFalse();
    seen.add(scene.name);
    expect(scene.description).toBeTruthy();
  }
});

test("every scene renders: 103 through the stable App (incl. mock-engine terminals), 2 shellOnly fixtures", async () => {
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
        // Connection progress lives on the state layer; the header is the shared identity.
        const detail = document.querySelector(".full-terminal-state-detail")?.textContent ?? "";
        expect(detail).toBe(scene.name === "terminal-error" ? t("ft.stateError") : t("ft.preparing"));
        shellRendered.push(scene.name);
      } else if (terminalSceneReadiness(scene.name)?.stage === "live") {
        // Real complete-terminal controller + mock xterm engine, actual App.
        await waitUntil(() => getFullTerminalView().stage === "live", `${scene.name} stage`);
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
        expectSameNode(document.getElementById("app"), app);
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
  expect(appRendered).toHaveLength(103);
  expect(appRendered.length + shellRendered.length).toBe(105);
}, 180_000);

test("attention QA scenes show all statuses and runtime replacement without filter pills", async () => {
  const first = await prepareScene("attention-rich");
  try {
    const copy = document.querySelector("#app")?.textContent ?? "";
    expect(copy).toContain(t("status.starting"));
    expect(copy).toContain(t("status.notReady"));
    expect(copy).toContain(t("status.ready"));
    expect(document.querySelector(".attention-filters")).toBeNull();
    const names = [...document.querySelectorAll(".card-name")].map((node) => node.textContent);
    expect(names).toContain("done-new");
    expect(names).toContain("done-old");
    expect(names.length).toBeGreaterThan(2);
  } finally {
    await teardownScene(first, false);
  }
  const updated = await prepareScene("attention-rich-updated");
  try {
    expect(document.querySelector(".attention-filters")).toBeNull();
    expect(document.querySelector("#app")?.textContent).toContain(t("status.ready"));
    expect(document.querySelectorAll(".card")).toHaveLength(8);
  } finally {
    await teardownScene(updated, false);
  }
});

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
    expectSameNode(document.getElementById("app"), before);
    expect(document.documentElement.lang).toBe("en");
    // Visible localized copy, not only the <html lang> attribute.
    const copy = document.body.textContent ?? "";
    // The phone tab bar carries the localized navigation copy.
    expect(copy).toContain(t("tabs.board"));
    expect(copy).toContain("Board");
    expect(copy).not.toContain("画板");
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
    expectSameNode(document.activeElement, input);
    expect([input?.selectionStart, input?.selectionEnd]).toEqual([1, 4]);
    expect(input?.value).toBe("正在编辑的文字");
  } finally {
    await teardownScene(session, false);
  }
});

test("attachment QA scenes seed the tray in every state", async () => {
  const session = await prepareScene("guided-attachments");
  try {
    const chips = [...document.querySelectorAll(".attach-tray .attach-chip")];
    expect(chips.map((chip) => [...chip.classList].find((name) => name.startsWith("is-"))))
      .toEqual(["is-ready", "is-ready", "is-uploading", "is-failed", "is-paused"]);
    expect(document.querySelector(".attach-chip-tag")).not.toBeNull();
    expect(document.querySelector(".attach-lead")).not.toBeNull();
  } finally {
    await teardownScene(session, false);
  }
  const relay = await prepareScene("guided-attachments-relay");
  try {
    const chips = [...document.querySelectorAll(".attach-tray .attach-chip")];
    expect(chips).toHaveLength(2);
    expect(chips.every((chip) => chip.classList.contains("is-waiting"))).toBeTrue();
    expect(document.querySelector(".attach-lead .attach-lead-btn")).not.toBeNull();
  } finally {
    await teardownScene(relay, false);
  }
  // The next scene starts with an empty tray.
  const plain = await prepareScene("guided");
  try {
    expect(document.querySelector(".attach-tray")).toBeNull();
  } finally {
    await teardownScene(plain, false);
  }
});

/** Run `body` on a 1440 px layout, then return the window to the phone the rest of the suite uses. */
async function atDeskWidth(body: () => Promise<void>): Promise<void> {
  // Mounted components listen for the width tier; their updates belong in act.
  const resize = (width: number, height: number) => act(async () => { happy.happyDOM.setWindowSize({ width, height }); });
  await resize(1440, 900);
  try {
    await body();
  } finally {
    await resize(390, 844);
  }
}

test("inspector scenes put the column beside the session at desk width, on their tab or detail", async () => {
  const column = () => document.querySelector<HTMLElement>("#app.desk.inspector > aside.inspector");
  const shown: Record<string, () => void> = {
    "inspector-guided-changes": () => {
      expect(document.querySelector(".main .dock textarea")).not.toBeNull();
      expect(column()?.querySelector(".inspector-list")?.textContent).toContain("styles.scss");
    },
    "inspector-guided-diff": () => {
      expect(document.querySelector(".main .dock textarea")).not.toBeNull();
      expect(column()?.querySelector(".workspace-diff-view")?.textContent).toContain("export function App()");
    },
    "inspector-chat-changes": () => {
      expect(document.querySelector(".main .agent-stream")).not.toBeNull();
      expect(column()?.querySelector(".inspector-list")?.textContent).toContain("styles.scss");
    },
    "inspector-chat-diff": () => {
      expect(column()?.querySelector(".workspace-diff-view")?.textContent).toContain("export function App()");
      expect(column()?.querySelector(".workspace-diff-note")).toBeNull();
    },
    "inspector-chat-diff-note": () => {
      expect(column()?.querySelector(".workspace-diff-note .diff-note-body")?.textContent).toContain("ready");
      expect(column()?.querySelector(".workspace-notes-bar")).not.toBeNull();
      expect(diffNotes()).toHaveLength(1);
    },
    "inspector-chat-file": () => {
      expect(column()?.querySelector(".workspace-detail-view:not(.workspace-diff-view)")?.textContent).toContain("createRoot");
    },
    "inspector-chat-files": () => {
      expect(column()?.querySelector(".inspector-list")?.textContent).toContain("package.json");
    },
  };
  expect(scenes.filter((scene) => scene.name.startsWith("inspector")).map((scene) => scene.name).sort()).toEqual(Object.keys(shown).sort());
  await atDeskWidth(async () => {
    for (const [name, assertShown] of Object.entries(shown)) {
      const session = await prepareScene(name);
      try {
        expect(inspectorOpen()).toBeTrue();
        expect(column()).not.toBeNull();
        const tab = column()?.querySelector(".inspector-tab.on")?.textContent ?? "";
        expect(tab).toContain(t(name.includes("-file") ? "workspace.files" : "workspace.changes"));
        assertShown();
      } finally {
        await teardownScene(session, false);
      }
    }
    // The reset takes the session off the page, which closes the column and
    // lets go of the note that was pinned beside it.
    const plain = await prepareScene("desktop-chat");
    try {
      expect(inspectorOpen()).toBeFalse();
      expect(document.querySelector(".inspector")).toBeNull();
      expect(document.getElementById("app")?.classList.contains("inspector")).toBeFalse();
      expect(diffNotes()).toHaveLength(0);
    } finally {
      await teardownScene(plain, false);
    }
  });
});

test("an inspector scene on the phone is the plain session with the column parked", async () => {
  const session = await prepareScene("inspector-chat-diff");
  try {
    expect(inspectorOpen()).toBeTrue();
    expect(document.querySelector(".inspector")).toBeNull();
    expect(document.querySelector(".workspace-shell")).toBeNull();
    expect(document.querySelector("#app .agent-stream")).not.toBeNull();
  } finally {
    await teardownScene(session, false);
  }
  const next = await prepareScene("chat");
  try {
    expect(inspectorOpen()).toBeFalse();
  } finally {
    await teardownScene(next, false);
  }
});

test("a terminal scene's computer draws its screen on open and again after a resize", async () => {
  const source = sceneSource("terminal-wide");
  const direct = createSession(source);
  const frames: Array<{ width: number; text: string }> = [];
  direct.live.onEvent((event) => {
    if (event.type === "terminal_frame" && event.terminalFrame) {
      frames.push({ width: event.terminalFrame.width, text: new TextDecoder().decode(event.terminalFrame.data) });
    }
  });
  const nextTask = () => new Promise((done) => setTimeout(done, 0));
  const opened = await direct.live.terminalOpen(PANE, 100, 12);
  expect(frames).toHaveLength(0);
  await nextTask();
  expect(frames.map((frame) => frame.width)).toEqual([100]);
  // Every row ends in the number of the last column, so a pan to the end is checkable.
  expect(frames[0].text).toContain(" 100|");
  await direct.live.terminalResize(opened.terminalId, 1, 100, 12, 7, 16);
  await nextTask();
  expect(frames).toHaveLength(1);
  await direct.live.terminalResize(opened.terminalId, 2, 132, 12, 7, 16);
  await nextTask();
  expect(frames.map((frame) => frame.width)).toEqual([100, 132]);
  expect(frames[1].text).toContain(" 132|");
  expect(direct.terminalFrames()).toBe(2);
  direct.dispose();

  // Through the App: the mock engine opens the bridge and the screen follows.
  for (const name of ["terminal-frame", "terminal-wide", "terminal-inspector"]) {
    expect(terminalSceneReadiness(name)).toEqual({ stage: "live", screen: true });
    const session = await prepareScene(name, sceneSource(name));
    try {
      await waitUntil(() => getFullTerminalView().stage === "live", `${name} stage`);
      await waitUntil(() => session.terminalFrames() > 0, `${name} screen`);
      assertPaneRoot(PANE);
      expect(getFullTerminalView().stage).toBe("live");
    } finally {
      await teardownScene(session, false);
    }
  }
  expect(terminalSceneReadiness("terminal-live")).toEqual({ stage: "live", screen: false });
  expect(terminalSceneReadiness("terminal-open-error")).toEqual({ stage: "error", screen: false });
  expect(terminalSceneReadiness("terminal-loading")).toBeNull();
});

test("live-input scenes switch the field over and the next scene gets the composed field back", async () => {
  for (const [name, pad] of [["guided-live", false], ["guided-live-expanded", true]] as const) {
    const session = await prepareScene(name);
    try {
      expect(composeLive()).toBeTrue();
      expect(document.querySelector(".dock .dock-form.live")).not.toBeNull();
      expect(keysExpanded()).toBe(pad);
      expect(document.querySelector('.dock .key-more[aria-expanded="true"]') !== null).toBe(pad);
    } finally {
      await teardownScene(session, false);
    }
  }
  const plain = await prepareScene("guided");
  try {
    expect(composeLive()).toBeFalse();
    expect(keysExpanded()).toBeFalse();
    expect(document.querySelector(".dock .dock-form.live")).toBeNull();
  } finally {
    await teardownScene(plain, false);
  }
});

test("palette scenes open search and jump after paint: waiting first, then history or the list, then a typed query", async () => {
  const dialog = () => document.querySelector<HTMLDialogElement>("dialog.command-palette");
  const heads = () => [...(dialog()?.querySelectorAll(".palette-head") ?? [])].map((head) => head.textContent);
  const panes = () => [...(dialog()?.querySelectorAll<HTMLElement>(".palette-row.is-session") ?? [])].map((row) => row.dataset.paneId);
  const open = async (name: string): Promise<FixtureSession> => {
    const session = await prepareScene(name);
    await act(async () => { afterScenePaint(name); await Promise.resolve(); });
    return session;
  };
  const close = async (session: FixtureSession): Promise<void> => {
    await act(async () => { closeTestDialogs(); await new Promise((done) => setTimeout(done, 0)); });
    expect(dialog()).toBeNull();
    await teardownScene(session, false);
  };

  const recent = await open("palette-recent");
  try {
    expect(dialog()?.open).toBeTrue();
    expect(heads()).toEqual([t("palette.waiting", { count: "1" }), t("palette.recent"), t("palette.actions")]);
    // The waiting session, then the reader's opens from the latest back.
    expect(panes()).toEqual(["w1:p2", "w1:p3", "w2:p1", "w2:p2", PANE]);
  } finally {
    await close(recent);
  }

  const plain = await open("palette");
  try {
    expect(paneActivated()).toEqual({});
    expect(heads()).toEqual([t("palette.waiting", { count: "1" }), t("palette.sessions"), t("palette.actions")]);
    expect(dialog()?.querySelector("input")?.value).toBe("");
  } finally {
    await close(plain);
  }

  const query = await open("palette-query");
  try {
    expect(dialog()?.querySelector("input")?.value).toBe("dash");
    expect(heads()).toEqual([t("palette.sessions")]);
    expect(panes()).toEqual(["w2:p1", "w2:p2"]);
  } finally {
    await close(query);
  }
});

test("home-recent stamps each open at its own instant and the next scene starts with none", async () => {
  const stored = () => Array.from({ length: localStorage.length }, (_unused, index) => localStorage.key(index) ?? "")
    .filter((key) => key.startsWith(PANE_ACTIVATED_KEY));
  const session = await prepareScene("home-recent");
  try {
    const stamps = paneActivated();
    expect(Object.keys(stamps).sort()).toEqual([PANE, "w1:p3", "w2:p1", "w2:p2"]);
    expect(new Set(Object.values(stamps)).size).toBe(4);
    for (const stamp of Object.values(stamps)) expect(stamp).toBeLessThan(FIXED_NOW);
    expect(stamps["w1:p3"]).toBeGreaterThan(stamps["w2:p1"]);
    expect(stored()).toHaveLength(1);
    // The scoped clock is back at the fixture instant.
    expect(Date.now()).toBe(FIXED_NOW);
    // The list follows the opens: the latest one leads.
    expect(document.querySelector(".card-name")?.textContent).toBe("Validate types");
  } finally {
    await teardownScene(session, false);
  }
  const plain = await prepareScene("home-populated");
  try {
    expect(paneActivated()).toEqual({});
    expect(stored()).toHaveLength(0);
    expect(document.querySelector(".card-name")?.textContent).toBe("React migration");
  } finally {
    await teardownScene(plain, false);
  }
});

test("home-update marks Settings on the outdated computer only, and home-herd-sessions offers the switch", async () => {
  const baseline = await prepareScene("home-populated");
  const baselineDaemon = currentDaemonId();
  await teardownScene(baseline, false);
  await atDeskWidth(async () => {
    const update = await prepareScene("home-update");
    try {
      expect(currentDaemonId()).not.toBe(baselineDaemon);
      expect(needsDaemonUpdate()).toBeTrue();
      await waitUntil(() => document.querySelector(".rail-nav .rail-nav-dot") !== null, "the rail's update dot");
      expect(document.querySelector(".rail-head")?.textContent).toContain("Studio Mac");
    } finally {
      await teardownScene(update, false);
    }
    const plain = await prepareScene("home-populated");
    try {
      expect(currentDaemonId()).toBe(baselineDaemon);
      expect(needsDaemonUpdate()).toBeFalse();
      expect(document.querySelector(".rail-nav .rail-nav-dot")).toBeNull();
      expect(document.querySelector(".rail > .herd-session-switch")).toBeNull();
    } finally {
      await teardownScene(plain, false);
    }
    const herd = await prepareScene("home-herd-sessions", sceneSource("home-herd-sessions"));
    try {
      expect(document.querySelector(".rail > .herd-session-switch")).not.toBeNull();
    } finally {
      await teardownScene(herd, false);
    }
    const after = await prepareScene("home-populated");
    try {
      expect(document.querySelector(".rail > .herd-session-switch")).toBeNull();
    } finally {
      await teardownScene(after, false);
    }
  });
  // The phone carries both in its own frame: the tab bar's dot and the header's pill.
  const update = await prepareScene("home-update");
  try {
    await waitUntil(() => (document.getElementById("app")?.textContent ?? "").includes(t("tabs.updateAria")), "the tab bar's update mark");
  } finally {
    await teardownScene(update, false);
  }
  const herd = await prepareScene("home-herd-sessions", sceneSource("home-herd-sessions"));
  try {
    expect(document.querySelector("#app .herd-session-switch")).not.toBeNull();
  } finally {
    await teardownScene(herd, false);
  }
});

test("an empty list says why in the main column at desk width, and on the phone in the list itself", async () => {
  // Scene, the main column's heading, its buttons (a trailing ! is one that cannot be pressed), the rail's note.
  const states: Array<[string, string, string[], string | null]> = [
    ["home-reading", t("deskEmpty.readingTitle"), [`${t("empty.actionCreate")}!`, `${t("deskEmpty.search")}!`], null],
    ["home-empty", t("empty.hostTitle", { host: "MacBook Pro" }), [t("empty.actionCreate"), t("deskEmpty.search")], t("empty.noneTitle")],
    ["home-empty-locked", t("empty.hostTitle", { host: "MacBook Pro" }), [t("empty.copy"), t("deskEmpty.search")], t("empty.noneTitle")],
    ["home-exited", t("empty.exitedTitle"), [t("empty.copy"), t("empty.actionRetry")], t("empty.exitedTitle")],
    ["home-unverified", t("empty.unverifiedTitle"), [t("empty.actionRetry"), t("empty.details")], t("empty.unverifiedTitle")],
    ["home-offline-empty", t("deskEmpty.offlineTitle"), [], null],
    ["home-reconnecting", t("empty.reconnectingTitle"), [], null],
  ];
  await atDeskWidth(async () => {
    for (const [name, title, buttons, note] of states) {
      const session = await prepareScene(name);
      try {
        const main = document.querySelector("#app.desk .main .desk-empty")!;
        expect(`${name}: ${main.querySelector("h2.empty-title")?.textContent}`).toBe(`${name}: ${title}`);
        expect(main.querySelector(".empty-sub")?.textContent).toBeTruthy();
        expect([...main.querySelectorAll("button")].map((button) => `${button.textContent?.replace("⌘K", "")}${button.disabled ? "!" : ""}`)).toEqual(buttons);
        // A session can be started from here only on a computer that is simply empty.
        expect(main.querySelectorAll(".btn-primary:not(:disabled)")).toHaveLength(name === "home-empty" ? 1 : 0);
        expect(document.querySelector(".rail .herd-empty.is-beside")?.textContent ?? null).toBe(note);
        expect(document.querySelector(".rail .herd-empty-panel, .rail .herd-empty-title, .rail > .banner")).toBeNull();
      } finally {
        await teardownScene(session, false);
      }
    }
  });
  // The phone has no column beside its list: the list explains itself, as it did.
  for (const [name, selector] of [["home-exited", ".herd-empty-panel.is-exited"], ["home-unverified", ".herd-empty-panel.is-unverifiable"],
    ["home-empty-locked", ".herd-empty .herd-empty-title"], ["home-offline-empty", "p.herd-empty-note"], ["home-reconnecting", "p.herd-empty-note"]]) {
    const session = await prepareScene(name);
    try {
      expect(`${name}: ${document.querySelector(`#app .herd-page ${selector}`) !== null}`).toBe(`${name}: true`);
      expect(document.querySelector("#app .desk-empty, #app .herd-empty.is-beside")).toBeNull();
    } finally {
      await teardownScene(session, false);
    }
  }
});

test("the unreachable scenes keep the rail's frame beside the explanation, and the narrow board takes the row", async () => {
  const resize = (width: number, height: number) => act(async () => { happy.happyDOM.setWindowSize({ width, height }); });
  const app = () => document.getElementById("app")!;
  try {
    for (const [width, height] of [[1440, 900], [820, 1180]]) {
      await resize(width, height);
      for (const name of ["home-unreachable", "home-unreachable-relay"]) {
        const session = await prepareScene(name);
        try {
          expect(app().classList.contains("desk")).toBeTrue();
          expect(app().querySelector(".rail .host-title.is-off")).not.toBeNull();
          expect(app().querySelector(".rail .card, .rail .herd-skeleton")).toBeNull();
          expect([...app().querySelectorAll<HTMLButtonElement>(".rail-search, .rail-nav-item")].every((button) => button.disabled)).toBeTrue();
          expect(app().querySelector(".main-unreachable .conn-path-card")).not.toBeNull();
          expect(app().querySelector(".main-unreachable .conn-retry")?.textContent).toBe(t("unreach.retryNow"));
          expect(app().querySelector(".unreachable-shell, .tab-bar")).toBeNull();
        } finally {
          await teardownScene(session, false);
        }
      }
    }
    // 720–899 px: the list gives the board its column; from 900 px it stays beside it.
    for (const [width, alone] of [[820, true], [1180, false]] as const) {
      await resize(width, width === 820 ? 1180 : 820);
      const session = await prepareScene("board-busy", sceneSource("board-busy"));
      try {
        expect(app().classList.contains("desk")).toBeTrue();
        expect(app().classList.contains("rail-hidden")).toBe(alone);
        expect(app().querySelector(".board-chrome .chrome-back .back") !== null).toBe(alone);
      } finally {
        await teardownScene(session, false);
      }
    }
  } finally {
    await resize(390, 844);
  }
});

test("scene names and descriptions are documented for the window.qa surface", () => {
  const names = scenes.map((scene) => scene.name);
  expect(names).toContain("terminal-loading");
  expect(names).toContain("terminal-error");
  expect(names.length).toBe(105);
  for (const scene of scenes) expect(scene.description).toBeTruthy();
});
