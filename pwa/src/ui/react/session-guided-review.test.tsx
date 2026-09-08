import { happy, resetTestDOM } from "../../../test-support/boot-dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import type { LiveSession } from "../../lib/protocol/session-types";
import { ProtocolError } from "../../lib/protocol/errors";
import { app, clearNotice, state } from "../../state";
import { setRenderer } from "../../paint";
import { bindPaneRefresh } from "../../pane-refresh-request";
import { clearModifiers, modifierIsActive } from "../keypad";
import { composeViewSnapshot, flushLiveInput, syncSendButton } from "../session/compose";
import { dropQueuedKeys, flushKeys } from "../session/keys";
import { predictText, resetEcho } from "../session/echo";
import { displayedTermModel, toggleTermSelect } from "../session/term";
import { paneModel } from "../session/model";
import { guidedScrollController } from "../session/guided-scroll";
import { renderApp } from "./app-screen";
import { patchSessionScreen } from "../session/view";
import { SessionDock } from "./session-dock";
import { SessionTerminal } from "./session-terminal";
import { SessionRowBar } from "./session-rowbar";
import { leaveReactScreen, renderReactScreen } from "./root";

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
  act(() => renderReactScreen(<div key={scope}><SessionTerminal /><SessionRowBar /><SessionDock includeBack /></div>));
}
function field(): HTMLTextAreaElement { return app.querySelector("textarea")!; }
function dispatch(target: EventTarget, type: string, init: Record<string, unknown> = {}): Event {
  const Constructor = type.startsWith("pointer") ? happy.PointerEvent : type.startsWith("key") ? happy.KeyboardEvent : happy.Event;
  const event = new Constructor(type, { bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event as unknown as Event); });
  return event as unknown as Event;
}
function key(label: string): HTMLButtonElement {
  const found = [...app.querySelectorAll<HTMLButtonElement>(".key")].find(el => el.textContent === label || el.getAttribute("aria-label") === label);
  if (!found) throw new Error(`No key ${label}`);
  return found;
}

beforeEach(async () => {
  await resetTestDOM();
  previousSelection = window.getSelection;
  window.getSelection = () => happy.document.getSelection() as unknown as Selection;
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.requestAnimationFrame = happy.requestAnimationFrame.bind(happy);
  globals.cancelAnimationFrame = happy.cancelAnimationFrame.bind(happy);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  Object.assign(state, { agents: [], phase: "live", screen: "pane", paneId: "p1", paneText: "ready", paneHash: "1".repeat(64),
    live: live(), networkOnline: true, fullTerminal: false, agentChat: false, termSelect: false, termWrap: false,
    paneFollow: true, paneUnread: false, paneRow: null, composeDraft: "", composeLive: false,
    composeIME: false, composeFocused: false, keysExpanded: true, padKind: "keys" });
  clearModifiers();
  clearNotice();
  resetEcho();
  displayedTermModel(paneModel());
  bindPaneRefresh(async () => null);
  setRenderer(() => paint());
});

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await act(async () => { await flushLiveInput(); await flushKeys(); });
  act(() => leaveReactScreen());
  dropQueuedKeys();
  guidedScrollController.dispose();
  clearModifiers();
  resetEcho();
  state.termSelect = false;
  displayedTermModel(paneModel());
  state.live = null;
  state.agents = [];
  state.paneId = "";
  state.composeDraft = "";
  state.composeLive = false;
  state.composeIME = false;
  state.composeFocused = false;
  clearNotice();
  bindPaneRefresh(async () => null);
  setRenderer(() => {});
  window.getSelection = previousSelection;
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
});

test("a new pane's compose mount must not show prior unacknowledged live text", async () => {
  const ack = deferred<unknown>(undefined);
  state.composeLive = true;
  state.live = live({ sendText: () => ack.promise });
  paint();
  field().value = "old pane text";
  dispatch(field(), "input");
  const flushing = flushLiveInput();
  await Promise.resolve();
  expect(composeViewSnapshot().pendingText).toBe("old pane text");
  state.paneId = "p2";
  state.composeDraft = "new pane draft";
  paint("p2");
  expect(field().value).toBe("new pane draft");
  expect(app.querySelector(".dock-form")?.classList.contains("live-pending")).toBeFalse();
  expect(app.querySelector(".live-input-status")?.textContent).toBe("");
  ack.resolve(undefined);
  await flushing;
  expect(field().value).toBe("new pane draft");
});

test("IME completion sends its live text once without Enter during composition", async () => {
  const text: string[] = [];
  const keys: string[][] = [];
  state.composeLive = true;
  state.live = live({ sendText: async (_id: string, value: string) => { text.push(value); },
    sendKeys: async (_id: string, value: string[]) => { keys.push(value); } });
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
  expect(state.composeIME).toBeFalse();
});

test("held Alt survives repaint, maps one physical arrow, and releases without latching", async () => {
  const sent: string[][] = [];
  state.live = live({ sendKeys: async (_id: string, value: string[]) => { sent.push(value); } });
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
  state.live = live({ sendKeys: async (_id: string, value: string[]) => { sent.push(value); } });
  paint();
  const up = key("↑");
  dispatch(up, "pointerdown", { pointerId: 1, button: 0, pointerType: "touch" });
  expect(sent).toEqual([["up"]]);
  act(() => leaveReactScreen());
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
  state.composeDraft = "run the focused tests";
  state.live = live({ paneRead: async () => ({ text: "ready", hash: "1".repeat(64) }),
    sendText: (_id: string, text: string) => { sent.push(text); return ack.promise; },
    sendKeys: async (_id: string, value: string[]) => { keys.push(value); } });
  paint();
  const input = field();
  const form = input.form!;
  dispatch(form, "submit");
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(sent).toEqual(["run the focused tests"]);
  expect(app.querySelector<HTMLButtonElement>(".send-btn")?.disabled).toBeTrue();
  paint();
  dispatch(form, "submit");
  expect(sent).toHaveLength(1);
  await act(async () => { ack.reject(new ProtocolError("unknown_outcome", "uncertain")); await wait(10); });
  expect(sent).toHaveLength(1);
  expect(keys).toEqual([]);
  expect(field() === input).toBeTrue();
  expect(app.querySelector<HTMLButtonElement>(".send-btn")?.disabled).toBeFalse();
  act(syncSendButton);
  expect(sent).toHaveLength(1);
});

test("frozen native range survives output and echo repaint, then exit shows current output", () => {
  state.paneText = "first line\nsecond line";
  paint();
  act(() => toggleTermSelect(true));
  const span = app.querySelector<HTMLElement>(".term-line > span")!;
  const textNode = span.firstChild!;
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.setStart(textNode, 1);
  range.setEnd(textNode, 5);
  selection.removeAllRanges();
  selection.addRange(range);
  state.paneText = "replacement\nnew output";
  paint();
  act(() => predictText("p1", "x", state.paneHash));
  expect(app.querySelector(".term-line > span")?.firstChild === textNode).toBeTrue();
  expect(selection.toString()).toBe("irst");
  expect(app.querySelector(".term")?.textContent).toContain("first line");
  act(() => toggleTermSelect(false));
  expect(app.querySelector(".term")?.textContent).toContain("replacement");
  expect(selection.rangeCount).toBe(0);
});

test("a new live session with the same pane id does not inherit frozen terminal text", () => {
  state.paneText = "computer A secret output";
  paint();
  act(() => toggleTermSelect(true));
  state.live = live();
  state.paneText = "computer B output";
  paint("new-session");
  expect(app.querySelector(".term")?.textContent).toContain("computer B output");
  expect(app.querySelector(".term")?.textContent).not.toContain("computer A");
});


test("actual guided route patches output without replacing focused IME compose or its range", () => {
  state.agents = [{ paneId: "p1", paneLabel: "working", workspaceId: "w1", workspaceLabel: "work",
    tabId: "t1", cwd: "/work", agent: "codex", hasAgent: true, status: "working" }];
  setRenderer(renderApp);
  act(renderApp);
  const input = field();
  const term = app.querySelector(".term")!;
  expect(app.querySelector("[data-react-guided-pane]")).not.toBeNull();
  input.value = "正在编辑的文字";
  input.focus();
  input.setSelectionRange(1, 4);
  dispatch(input, "compositionstart");
  dispatch(input, "input");
  state.paneText = "new output";
  state.paneHash = "2".repeat(64);
  act(() => { expect(patchSessionScreen()).toBeTrue(); });
  expect(field() === input).toBeTrue();
  expect(app.querySelector(".term") === term).toBeTrue();
  expect(document.activeElement === input).toBeTrue();
  expect([input.selectionStart, input.selectionEnd]).toEqual([1, 4]);
  expect(input.value).toBe("正在编辑的文字");
  expect(state.composeIME).toBeTrue();
  expect(term.textContent).toContain("new output");
});


test("late old-session live failure cannot restore queued text into same-id pane on another computer", async () => {
  const ack = deferred<unknown>(undefined);
  state.composeLive = true;
  state.live = live({ sendText: () => ack.promise });
  paint();
  field().value = "old in flight";
  dispatch(field(), "input");
  const flushing = flushLiveInput();
  field().value = "old queued";
  dispatch(field(), "input");
  expect(composeViewSnapshot().pendingText).toContain("old queued");
  state.live = live();
  state.composeDraft = "new computer draft";
  paint("other-computer");
  expect(app.querySelector(".live-input-status")?.textContent).toBe("");
  await act(async () => {
    ack.reject(new ProtocolError("disconnected", "old connection lost"));
    await flushing;
    await Promise.resolve();
  });
  expect(state.composeLive).toBeTrue();
  expect(state.composeDraft).toBe("new computer draft");
  expect(field().value).toBe("new computer draft");
  expect(app.querySelector(".dock-form")?.classList.contains("live-pending")).toBeFalse();
});

test("actual route hides row actions while output is frozen and quotes current output after selection ends", () => {
  state.agents = [{ paneId: "p1", paneLabel: "working", workspaceId: "w1", workspaceLabel: "work",
    tabId: "t1", cwd: "/work", agent: "codex", hasAgent: true, status: "working" }];
  state.paneText = "old visible line";
  state.paneRow = 0;
  setRenderer(renderApp);
  act(renderApp);
  expect(app.querySelector(".row-quote")?.textContent).toBe("old visible line");
  act(() => toggleTermSelect(true));
  state.paneText = "current line /work/app.ts";
  act(() => { expect(patchSessionScreen()).toBeTrue(); });
  expect(app.querySelector(".term")?.textContent).toContain("old visible line");
  expect(app.querySelector(".row-bar")).toBeNull();
  expect(state.paneRow).toBeNull();
  act(() => toggleTermSelect(false));
  state.paneRow = 0;
  act(renderApp);
  expect(app.querySelector(".row-quote")?.textContent).toBe("current line /work/app.ts");
  const quote = [...app.querySelectorAll<HTMLButtonElement>(".row-act")].find(el => el.textContent === "引用到输入框")!;
  act(() => quote.click());
  expect(field().value).toBe("current line /work/app.ts");
  expect(state.paneRow).toBeNull();
});
