import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act } from "react";

/**
 * Actual window.qa orchestrator regressions: these drive the SAME
 * createFixtureAPI the Vite QA page boots (not a hand-assembled setup), in
 * happy-dom, and preserve the reviewer's six behavioral controls:
 *
 * 1. guided edit, focus/selection, hold/release and exactly-one send survive a
 *    real render through the mounted App host;
 * 2. the IME scene keeps focus/selection/value through render and setLanguage
 *    changes visible copy;
 * 3. (R2) connect-error -> connect clears the named pairing validation state
 *    (error target, failed step, open details, invalid input) via the typed
 *    baseline reset;
 * 4. (R1) a shellOnly scene -> App scene hands #app over with exactly one root
 *    owner (no createRoot-on-existing-container diagnostic) and unloads
 *    cleanly on beforeunload;
 * 5. the live mock engine keeps its helper node through render and is retired
 *    exactly once when the next scene replaces the session;
 * 6. a held pending read fails once without replay and retires on navigation.
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
let loaderGate: { promise: Promise<void>; resolve(): void } | null = null;
mock.module("../src/features/session/full-terminal/full-terminal-loader", () => ({
  fullTerminalSupported: () => true,
  terminalWebglSupported: () => true,
  loadFullTerminalXterm: async () => {
    // Test-local deferred gate: a regression holds the renderer load while the
    // real fixture's api.setScene(terminal-…) is pending to prove QA ready is
    // not fulfilled before the actual staged open/rejection. Null = unchanged.
    if (loaderGate) await loaderGate.promise;
    return {
      Terminal: TestTerminal,
      FitAddon: class { fit(): void {} },
      WebglAddon: class { onContextLoss(_listener: () => void): void {} },
    };
  },
  preloadFullTerminalXterm: () => {},
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const { resetBoardTestDOM, happy } = await import("./dom");
await resetBoardTestDOM();
for (const key of ["innerWidth", "innerHeight"] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, get: () => happy[key] });
}
Object.assign(globalThis, { Event: happy.Event, InputEvent: happy.InputEvent });
if (!(document as { fonts?: unknown }).fonts) {
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
}
const { installEnvironment, FIXED_NOW } = await import("../qa/environment");
installEnvironment();
// Bun and HappyDOM have separate global/window fetch; the browser fixture has one.
globalThis.fetch = window.fetch as typeof globalThis.fetch;

const { createFixtureAPI } = await import("../qa/fixtures");
const { composeDraft } = await import("../src/features/session/compose-store");
const { pairingStore } = await import("../src/features/pairing/form-store");
const { liveSession, credential, lastUsedDaemon } = await import("../src/features/computers/catalog-store");
const { t } = await import("../src/lib/i18n");
const { formatDeviceAge } = await import("../src/lib/ui-model");
const { isAppMounted } = await import("../src/app/mount");
const { appHost } = await import("../src/app/host");
const { getFullTerminalView } = await import("../src/features/session/full-terminal/full-terminal");

type FixtureAPI = Awaited<ReturnType<typeof createFixtureAPI>>;
let api: FixtureAPI | undefined;

async function start(scene: string): Promise<FixtureAPI> {
  await act(async () => { api = await createFixtureAPI("zh", scene); await api.ready; });
  return api!;
}
async function scene(name: string): Promise<void> {
  await act(async () => { await api!.setScene(name); });
}
async function settle(predicate: () => boolean): Promise<void> {
  for (let n = 0; n < 50; n++) {
    if (predicate()) return;
    await act(async () => { await new Promise((done) => setTimeout(done, 10)); });
  }
  throw new Error("observable settlement timed out");
}

afterEach(async () => {
  if (api) {
    await act(async () => {
      window.dispatchEvent(new Event("beforeunload"));
      await Promise.resolve();
    });
    api = undefined;
  }
});
afterAll(() => { mock.restore(); });

test("actual API guided edit, focus/selection, hold/release and one send survive real render", async () => {
  const a = await start("guided-draft");
  expect(a.snapshot().reactOwned).toBeTrue();
  expect(a.snapshot().ready).toBeTrue();
  expect("state" in a).toBeFalse();
  const host = appHost();
  const input = document.querySelector<HTMLTextAreaElement>(".dock textarea")!;
  expect(input).not.toBeNull();
  await act(async () => {
    input.focus();
    input.value = "QA input exactly once";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "QA input exactly once" }));
    input.setSelectionRange(2, 7);
    await a.render();
  });
  expect(document.querySelector(".dock textarea") === input).toBeTrue();
  expect(appHost() === host).toBeTrue();
  expect(composeDraft()).toBe("QA input exactly once");
  expect(document.activeElement === input).toBeTrue();
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 7]);
  a.clearCalls();
  a.hold("sendText");
  await act(async () => {
    input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  expect(a.calls.filter((c) => c.method === "sendText")).toHaveLength(1);
  await act(async () => { a.release("sendText"); await Promise.resolve(); });
  await settle(() => a.calls.some((c) => c.method === "paneRead"));
  expect(a.calls.filter((c) => c.method === "sendText")).toHaveLength(1);
  expect(a.calls.find((c) => c.method === "sendText")?.args).toEqual(["w1:p1", "QA input exactly once"]);
  expect(a.snapshot().errors).toEqual([]);
});

test("actual API IME survives render and visible language changes", async () => {
  const a = await start("guided-ime");
  const input = document.querySelector<HTMLTextAreaElement>(".dock textarea")!;
  expect(document.activeElement === input).toBeTrue();
  expect([input.selectionStart, input.selectionEnd]).toEqual([1, 4]);
  await act(async () => { await a.render(); });
  expect(document.querySelector(".dock textarea") === input).toBeTrue();
  expect(input.value).toBe("正在编辑的文字");
  expect([input.selectionStart, input.selectionEnd]).toEqual([1, 4]);
  await scene("home-populated");
  const host = appHost();
  await act(async () => { await a.setLanguage("en"); });
  expect(appHost() === host).toBeTrue();
  expect(document.body.textContent).toContain("Computers");
  expect(document.body.textContent).not.toContain("电脑");
});

test("actual API scene reset removes earlier pairing validation state", async () => {
  const a = await start("connect-error");
  expect(document.querySelector('input[aria-invalid="true"]')).not.toBeNull();
  await scene("connect");
  expect(pairingStore.get().pairErrorTarget).toBeNull();
  expect(pairingStore.get().pairFailedStep).toBeNull();
  expect(pairingStore.get().pairManualOpen).toBeFalse();
  expect(document.querySelector("details")?.open).toBeFalse();
  expect(document.querySelector('input[aria-invalid="true"]')).toBeNull();
  expect(a.snapshot().errors).toEqual([]);
});

test("actual API scenes restore the historical no-last-used baseline across transitions", async () => {
  const startNow = FIXED_NOW;
  // The real catalog setCredential remembers the seeded daemon as last used;
  // the fixture restores the plain-state baseline, so the picker first row keeps
  // the generic device.lastUsed meta and never a 上次使用 (computers.lastUsed) mark.
  const metaText = () => [...document.querySelectorAll<HTMLElement>(".computer-row .switch-meta")].map((el) => el.textContent ?? "");
  const a = await start("computers-one");
  expect(credential()).toBeNull();
  expect(lastUsedDaemon()).toBeNull();
  expect(metaText()).toEqual([t("device.lastUsed", { when: formatDeviceAge(startNow - 60000) })]);
  // Across a scene transition the baseline is re-established identically.
  await scene("computers-many");
  expect(lastUsedDaemon()).toBeNull();
  const metas = metaText();
  expect(metas).toHaveLength(3);
  const markerPrefix = t("computers.lastUsed", { when: "" }).slice(0, t("computers.lastUsed", { when: "" }).indexOf("{when}"));
  for (const meta of metas) expect(meta.startsWith(markerPrefix)).toBeFalse();
  expect(metas[0]).toBe(t("device.lastUsed", { when: formatDeviceAge(startNow - 60000) }));
});

test("actual API shell to App has one root owner and can unload cleanly", async () => {
  const a = await start("terminal-loading");
  expect(isAppMounted()).toBeFalse();
  expect(a.snapshot().shellOnly).toBeTrue();
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); original(...args); };
  try {
    await scene("guided-draft");
    expect(isAppMounted()).toBeTrue();
    expect(document.querySelector(".dock textarea")).not.toBeNull();
    expect(document.querySelector(".full-terminal-root")).toBeNull();
    await act(async () => {
      window.dispatchEvent(new Event("beforeunload"));
      await Promise.resolve();
    });
    expect(isAppMounted()).toBeFalse();
    expect(document.getElementById("app")!.childElementCount).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    console.error = original;
  }
});

test("actual API live engine keeps helper through render then retires on next scene", async () => {
  const a = await start("terminal-live");
  await settle(() => getFullTerminalView().stage === "live");
  const helper = document.querySelector(".xterm-helper-textarea");
  const session = liveSession();
  const before = disposals;
  expect(helper).not.toBeNull();
  expect(session?.isConnected()).toBeTrue();
  expect(document.querySelector(".full-terminal-root")?.getAttribute("data-pane-id")).toBe("w1:p1");
  expect(a.terminalFrame("QA injected frame")).toBeTrue();
  await act(async () => { await a.render(); });
  expect(document.querySelector(".xterm-helper-textarea") === helper).toBeTrue();
  expect(disposals).toBe(before);
  await scene("home-populated");
  expect(session?.isConnected()).toBeFalse();
  expect(disposals).toBe(before + 1);
  expect(document.querySelector(".full-terminal-root")).toBeNull();
  expect(a.terminalFrame("stale")).toBeFalse();
});

test("actual API pending read releases, fails once without replay, and retires on navigation", async () => {
  const a = await start("workspace-file-loading");
  const old = liveSession();
  expect(a.calls.filter((c) => c.method === "workspaceRead")).toHaveLength(1);
  a.failNext("workspaceRead", "daemon_offline");
  await act(async () => { a.release("workspaceRead"); await Promise.resolve(); });
  await settle(() => !!document.querySelector(".workspace-error"));
  expect(a.calls.filter((c) => c.method === "workspaceRead")).toHaveLength(1);
  await scene("workspace-loading");
  const pending = liveSession();
  expect(old?.isConnected()).toBeFalse();
  expect(a.calls.filter((c) => c.method === "workspaceOpen")).toHaveLength(1);
  await scene("home-populated");
  expect(pending?.isConnected()).toBeFalse();
  expect(document.querySelector(".workspace-shell")).toBeNull();
  expect(a.snapshot().screen).toBe("home");
});

test("actual API terminal-live ready waits for the renderer open and its current TerminalOpen", async () => {
  const gate = deferred();
  loaderGate = gate;
  try {
    const a = await start("computers-many");
    let readySettled = false;
    const next = a.setScene("terminal-live").then(() => { readySettled = true; });
    // Hold the renderer load: the scene promise is pending and QA ready stays
    // false — never a paused loader snapshot marked ready.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    expect(readySettled).toBeFalse();
    expect(document.documentElement.dataset.qaReady).toBe("false");
    expect(a.snapshot().ready).toBeFalse();
    gate.resolve();
    await act(async () => { await next; });
    expect(readySettled).toBeTrue();
    // Ready now implies the actual live stage and this scene's single TerminalOpen.
    expect(getFullTerminalView().stage).toBe("live");
    expect(a.calls.filter((c) => c.method === "terminalOpen")).toHaveLength(1);
    expect(document.documentElement.dataset.qaReady).toBe("true");
    expect(a.snapshot().ready).toBeTrue();
  } finally {
    gate.resolve();
    loaderGate = null;
  }
});

test("actual API terminal-open-error ready resolves only after the rejected TerminalOpen error stage", async () => {
  const gate = deferred();
  loaderGate = gate;
  try {
    const a = await start("computers-many");
    let readySettled = false;
    const next = a.setScene("terminal-open-error").then(() => { readySettled = true; });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    expect(readySettled).toBeFalse();
    expect(document.documentElement.dataset.qaReady).toBe("false");
    gate.resolve();
    await act(async () => { await next; });
    expect(readySettled).toBeTrue();
    // The rejected TerminalOpen surfaced the error stage before ready, with the
    // current scene's single terminalOpen attempt recorded.
    expect(getFullTerminalView().stage).toBe("error");
    expect(a.calls.filter((c) => c.method === "terminalOpen")).toHaveLength(1);
    expect(document.querySelector('.full-terminal-state[data-stage="error"]')).not.toBeNull();
    expect(document.documentElement.dataset.qaReady).toBe("true");
    expect(a.snapshot().ready).toBeTrue();
  } finally {
    gate.resolve();
    loaderGate = null;
  }
});
