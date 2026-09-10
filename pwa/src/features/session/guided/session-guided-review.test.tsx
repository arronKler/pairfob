import { happy, resetTestDOM } from "../../../../test-support/boot-dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import type { LiveSession } from "../../../lib/protocol/session-types";
import { ProtocolError } from "../../../lib/protocol/errors";
import { WorkspaceSnapshotRestorer } from "../../../../test-support/workspace-snapshot-restore";
import { ScalarPreferenceState } from "../../../../test-support/preferences-scalar-restore";
import { renderReact, unmountReact, mountTestApp, commitTest, unmountTestApp } from "../../../../test-support/react-harness";
import { clearNotice } from "../../../app/notices-store";
import { appRoot } from "../../../app/dom-root";
import { setScreen } from "../../../app/navigation-store";
import { setPhase, setNetworkOnline } from "../../connection/connection-store";
import { applyPaneRead, selectPane, setAgentChat, setFullTerminal, setPaneFollow, setPaneRow, setPaneUnread, setTermSelect, paneRow, livePaneHash } from "../session-store";
import { setComposeDraft, setComposeFocused, setComposeIME, setComposeLive, composeDraft, composeLive, composeIME } from "../compose-store";
import { setKeysExpanded, setPadKind, setTermWrap } from "../../settings/preferences-store";
import { attachLiveSession } from "../../computers/catalog-store";
import { replaceAgentsFromSnapshot, applySnapshot } from "../../dashboard/catalog-store";
import { bindPaneRefresh } from "../../connection/refresh-request";
import { clearModifiers, modifierIsActive } from "../keypad/keypad";
import { composeViewSnapshot, flushLiveInput, syncSendButton } from "./compose";
import { dropQueuedKeys, flushKeys } from "./keys";
import { predictText, resetEcho } from "./echo";
import { displayedTermModel, toggleTermSelect } from "./term";
import { paneModel } from "./pane-model";
import { guidedScrollController } from "./guided-scroll";
import { patchSessionScreen } from "./view";
import { SessionDock } from "./session-dock";
import { SessionTerminal } from "./session-terminal";
import { SessionRowBar } from "./session-rowbar";

let previousSelection: typeof window.getSelection;
const releases: Array<() => void> = [];
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function deferred<T>(value: T) {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  releases.push(() => resolve(value));
  return { promise, resolve, reject };
}
function live(extra: Record<string, unknown> = {}): LiveSession {
  return { isConnected: () => true, sendKeys: async () => undefined, sendText: async () => undefined,
    onEvent: () => () => undefined, ...extra } as LiveSession;
}
function paint(scope = "p1"): void {
  act(() => renderReact(<div key={scope}><SessionTerminal /><SessionRowBar /><SessionDock includeBack /></div>));
}
function field(): HTMLTextAreaElement { return appRoot().querySelector("textarea")!; }
function dispatch(target: EventTarget, type: string, init: Record<string, unknown> = {}): Event {
  const Constructor = type.startsWith("pointer") ? happy.PointerEvent : type.startsWith("key") ? happy.KeyboardEvent : happy.Event;
  const event = new Constructor(type, { bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event as unknown as Event); });
  return event as unknown as Event;
}
function key(label: string): HTMLButtonElement {
  const found = [...appRoot().querySelectorAll<HTMLButtonElement>(".key")].find(el => el.textContent === label || el.getAttribute("aria-label") === label);
  if (!found) throw new Error(`No key ${label}`);
  return found;
}

// Baseline resets go through named setters that publish immediately; the
// dashboard agents/completion state is touched by keys-Enter submission
// (markPaneSubmitted) and by the empty-agents seed, so guard the projection +
// raw + daemon maps with WorkspaceSnapshotRestorer capture/restore.
const snapshotRestorer = new WorkspaceSnapshotRestorer();
const scalarPrefState = new ScalarPreferenceState();

const AGENT_WIRE = ({ label, status }: { label: string; status: string }) => ({
  workspaces: [{ workspace_id: "w1", label: "work", cwd: "/work" }],
  tabs: [{ tab_id: "t1", workspace_id: "w1", label: "main" }],
  panes: [{
    pane_id: "p1", workspace_id: "w1", tab_id: "t1", cwd: "/work",
    agent: "codex", agent_status: status, label,
  }],
});

beforeEach(async () => {
  await resetTestDOM();
  previousSelection = window.getSelection;
  window.getSelection = () => happy.document.getSelection() as unknown as Selection;
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.requestAnimationFrame = happy.requestAnimationFrame.bind(happy);
  globals.cancelAnimationFrame = happy.cancelAnimationFrame.bind(happy);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  scalarPrefState.capture();
  snapshotRestorer.capture();
  setPhase("live");
  setScreen("pane");
  selectPane("p1");
  applyPaneRead("ready", "1".repeat(64));
  attachLiveSession(live());
  setNetworkOnline(true);
  setFullTerminal(false);
  setAgentChat(false);
  setTermSelect(false);
  setTermWrap(false);
  setPaneFollow(true);
  setPaneUnread(false);
  setPaneRow(null);
  setComposeDraft("");
  setComposeLive(false);
  setComposeIME(false);
  setComposeFocused(false);
  setKeysExpanded(true);
  setPadKind("keys");
  replaceAgentsFromSnapshot({ panes: [] });
  clearModifiers();
  clearNotice();
  resetEcho();
  displayedTermModel(paneModel());
  bindPaneRefresh(async () => null);
});

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await act(async () => { await flushLiveInput(); await flushKeys(); });
  act(() => { unmountReact(); unmountTestApp(); });
  dropQueuedKeys();
  guidedScrollController.dispose();
  clearModifiers();
  resetEcho();
  act(() => {
    setTermSelect(false);
    displayedTermModel(paneModel());
    attachLiveSession(null);
    selectPane("");
    setComposeDraft("");
    setComposeLive(false);
    setComposeIME(false);
    setComposeFocused(false);
  });
  clearNotice();
  bindPaneRefresh(async () => null);
  scalarPrefState.restore();
  snapshotRestorer.restore();
  window.getSelection = previousSelection;
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
});

test("a new pane's compose mount must not show prior unacknowledged live text", async () => {
  const ack = deferred<unknown>(undefined);
  setComposeLive(true);
  attachLiveSession(live({ sendText: () => ack.promise }));
  paint();
  field().value = "old pane text";
  dispatch(field(), "input");
  const flushing = flushLiveInput();
  await Promise.resolve();
  expect(composeViewSnapshot().pendingText).toBe("old pane text");
  selectPane("p2");
  setComposeDraft("new pane draft");
  paint("p2");
  expect(field().value).toBe("new pane draft");
  expect(appRoot().querySelector(".dock-form")?.classList.contains("live-pending")).toBeFalse();
  expect(appRoot().querySelector(".live-input-status")?.textContent).toBe("");
  ack.resolve(undefined);
  await flushing;
  expect(field().value).toBe("new pane draft");
});

test("IME completion sends its live text once without Enter during composition", async () => {
  const text: string[] = [];
  const keys: string[][] = [];
  setComposeLive(true);
  attachLiveSession(live({ sendText: async (_id: string, value: string) => { text.push(value); },
    sendKeys: async (_id: string, value: string[]) => { keys.push(value); } }));
  paint();
  const input = field();
  input.focus();
  dispatch(input, "compositionstart");
  input.value = "正在输入";
  dispatch(input, "input");
  const enter = dispatch(input, "keydown", { key: "Enter", isComposing: true });
  paint();
  expect(enter.defaultPrevented).toBeFalse();
  expect(text).toEqual([]);
  expect(keys).toEqual([]);
  expect(field() === input).toBeTrue();
  dispatch(input, "compositionend");
  dispatch(input, "input");
  await act(async () => { expect(await flushLiveInput()).toBeTrue(); });
  expect(text).toEqual(["正在输入"]);
  expect(keys).toEqual([]);
  expect(input.value).toBe("");
  expect(composeIME()).toBeFalse();
});

test("held Alt survives repaint, maps one physical arrow, and releases without latching", async () => {
  const sent: string[][] = [];
  attachLiveSession(live({ sendKeys: async (_id: string, value: string[]) => { sent.push(value); } }));
  paint();
  const alt = key("Opt");
  const left = key("←");
  dispatch(alt, "pointerdown", { pointerId: 11, button: 0, pointerType: "touch" });
  paint();
  expect(key("Opt") === alt).toBeTrue();
  expect(modifierIsActive("alt")).toBeTrue();
  dispatch(left, "pointerdown", { pointerId: 12, button: 0, pointerType: "touch" });
  dispatch(document, "pointerup", { pointerId: 12, pointerType: "touch" });
  act(() => { left.dispatchEvent(new happy.MouseEvent("click", { bubbles: true, detail: 1 }) as unknown as Event); });
  dispatch(document, "pointerup", { pointerId: 11, pointerType: "touch" });
  await act(async () => { await flushKeys(); });
  expect(sent).toEqual([["esc", "b"]]);
  expect(modifierIsActive("alt")).toBeFalse();
  expect(alt.getAttribute("aria-pressed")).toBe("false");
});

test("unmount cancels active arrow repeat and detached native key listeners", async () => {
  const sent: string[][] = [];
  attachLiveSession(live({ sendKeys: async (_id: string, value: string[]) => { sent.push(value); } }));
  paint();
  const up = key("↑");
  dispatch(up, "pointerdown", { pointerId: 1, button: 0, pointerType: "touch" });
  expect(sent).toEqual([["up"]]);
  act(() => unmountReact());
  dispatch(up, "pointerdown", { pointerId: 2, button: 0 });
  act(() => up.click());
  await wait(530);
  expect(sent).toEqual([["up"]]);
  expect(up.classList.contains("is-pressed")).toBeFalse();
});

test("guarded form prevents duplicate submission and does not replay unknown outcome", async () => {
  const ack = deferred<unknown>(undefined);
  const sent: string[] = [];
  const keys: string[][] = [];
  setComposeDraft("run the focused tests");
  attachLiveSession(live({ paneRead: async () => ({ text: "ready", hash: "1".repeat(64) }),
    sendText: (_id: string, text: string) => { sent.push(text); return ack.promise; },
    sendKeys: async (_id: string, value: string[]) => { keys.push(value); } }));
  paint();
  const input = field();
  const form = input.form!;
  dispatch(form, "submit");
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(sent).toEqual(["run the focused tests"]);
  expect(appRoot().querySelector<HTMLButtonElement>(".send-btn")?.disabled).toBeTrue();
  paint();
  dispatch(form, "submit");
  expect(sent).toHaveLength(1);
  await act(async () => { ack.reject(new ProtocolError("unknown_outcome", "uncertain")); await wait(10); });
  expect(sent).toHaveLength(1);
  expect(keys).toEqual([]);
  expect(field() === input).toBeTrue();
  expect(appRoot().querySelector<HTMLButtonElement>(".send-btn")?.disabled).toBeFalse();
  act(syncSendButton);
  expect(sent).toHaveLength(1);
});

test("frozen native range survives output and echo repaint, then exit shows current output", () => {
  applyPaneRead("first line\nsecond line", "1".repeat(64));
  paint();
  act(() => toggleTermSelect(true));
  // The selection freeze captures the display on the repaint that follows the
  // toggle (production gets it from the commit boundary; the fixture repaints).
  paint();
  const span = appRoot().querySelector<HTMLElement>(".term-line > span")!;
  const textNode = span.firstChild!;
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.setStart(textNode, 1);
  range.setEnd(textNode, 5);
  selection.removeAllRanges();
  selection.addRange(range);
  applyPaneRead("replacement\nnew output", "1".repeat(64));
  paint();
  act(() => predictText("p1", "x", livePaneHash()));
  expect(appRoot().querySelector(".term-line > span")?.firstChild === textNode).toBeTrue();
  expect(selection.toString()).toBe("irst");
  expect(appRoot().querySelector(".term")?.textContent).toContain("first line");
  act(() => toggleTermSelect(false));
  paint();
  expect(appRoot().querySelector(".term")?.textContent).toContain("replacement");
  expect(selection.rangeCount).toBe(0);
});

test("a new live session with the same pane id does not inherit frozen terminal text", () => {
  applyPaneRead("computer A secret output", "1".repeat(64));
  paint();
  act(() => toggleTermSelect(true));
  attachLiveSession(live());
  applyPaneRead("computer B output", "1".repeat(64));
  paint("new-session");
  expect(appRoot().querySelector(".term")?.textContent).toContain("computer B output");
  expect(appRoot().querySelector(".term")?.textContent).not.toContain("computer A");
});


test("actual guided route patches output without replacing focused IME compose or its range", () => {
  applySnapshot(AGENT_WIRE({ label: "working", status: "working" }));
  mountTestApp();
  act(commitTest);
  const input = field();
  const term = appRoot().querySelector(".term")!;
  expect(appRoot().querySelector("[data-react-guided-pane]")).not.toBeNull();
  input.value = "正在编辑的文字";
  input.focus();
  input.setSelectionRange(1, 4);
  dispatch(input, "compositionstart");
  dispatch(input, "input");
  act(() => {
    applyPaneRead("new output", "2".repeat(64));
    expect(patchSessionScreen()).toBe("patched");
  });
  expect(field() === input).toBeTrue();
  expect(appRoot().querySelector(".term") === term).toBeTrue();
  expect(document.activeElement === input).toBeTrue();
  expect([input.selectionStart, input.selectionEnd]).toEqual([1, 4]);
  expect(input.value).toBe("正在编辑的文字");
  expect(composeIME()).toBeTrue();
  expect(term.textContent).toContain("new output");
});


test("late old-session live failure cannot restore queued text into same-id pane on another computer", async () => {
  const ack = deferred<unknown>(undefined);
  setComposeLive(true);
  attachLiveSession(live({ sendText: () => ack.promise }));
  paint();
  field().value = "old in flight";
  dispatch(field(), "input");
  const flushing = flushLiveInput();
  field().value = "old queued";
  dispatch(field(), "input");
  expect(composeViewSnapshot().pendingText).toContain("old queued");
  attachLiveSession(live());
  setComposeDraft("new computer draft");
  paint("other-computer");
  expect(appRoot().querySelector(".live-input-status")?.textContent).toBe("");
  await act(async () => {
    ack.reject(new ProtocolError("disconnected", "old connection lost"));
    await flushing;
    await Promise.resolve();
  });
  expect(composeLive()).toBeTrue();
  expect(composeDraft()).toBe("new computer draft");
  expect(field().value).toBe("new computer draft");
  expect(appRoot().querySelector(".dock-form")?.classList.contains("live-pending")).toBeFalse();
});

test("actual route hides row actions while output is frozen and quotes current output after selection ends", () => {
  applySnapshot(AGENT_WIRE({ label: "working", status: "working" }));
  applyPaneRead("old visible line", "1".repeat(64));
  setPaneRow(0);
  mountTestApp();
  act(commitTest);
  expect(appRoot().querySelector(".row-quote")?.textContent).toBe("old visible line");
  act(() => toggleTermSelect(true));
  act(() => {
    applyPaneRead("current line /work/app.ts", "1".repeat(64));
    expect(patchSessionScreen()).toBe("patched");
  });
  expect(appRoot().querySelector(".term")?.textContent).toContain("old visible line");
  expect(appRoot().querySelector(".row-bar")).toBeNull();
  expect(paneRow()).toBeNull();
  act(() => toggleTermSelect(false));
  act(() => { setPaneRow(0); commitTest(); });
  expect(appRoot().querySelector(".row-quote")?.textContent).toBe("current line /work/app.ts");
  const quote = [...appRoot().querySelectorAll<HTMLButtonElement>(".row-act")].find(el => el.textContent === "引用到输入框")!;
  act(() => quote.click());
  expect(field().value).toBe("current line /work/app.ts");
  expect(paneRow()).toBeNull();
});