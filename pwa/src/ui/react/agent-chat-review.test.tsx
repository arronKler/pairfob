import { happy, resetTestDOM } from "../../../test-support/boot-dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { app, clearNotice, resetPaneView, showStatus, state, visibleNotice } from "../../state";
import { resetComposeDrafts, capturePromptRequest, switchComposeView } from "../../compose-drafts";
import { readStoredDraft } from "../../state-drafts";
import { clearAgentTraceCache } from "../../lib/agent-trace-cache";
import { setLang } from "../../lib/i18n";
import type { AgentTracePage } from "../../lib/operations";
import { ProtocolError } from "../../lib/protocol/errors";
import { setRenderer } from "../../paint";
import { leaveAgentChat, patchAgentChat, refreshAgentTrace, submitAgentPrompt } from "../agent-chat-controller";
import { AgentChatPane } from "./agent-chat";
import { leaveReactScreen, renderReactScreen } from "./root";

const handlers = { onBack() {}, onWorkspace() {}, onMenu() {}, onSwitch() {} };
const page = (text: string): AgentTracePage => ({ items: [
  { type: "user", text: "Question" }, { type: "assistant", text },
], nextCursor: null, truncated: false });
type Session = NonNullable<typeof state.live>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mount(): void { renderReactScreen(<AgentChatPane includeBack handlers={handlers} />); }
function field(): HTMLTextAreaElement { return app.querySelector<HTMLTextAreaElement>(".agent-dock textarea")!; }
function stream(): HTMLElement { return app.querySelector<HTMLElement>(".agent-stream")!; }
function emit(input: HTMLTextAreaElement, type: string): void {
  input.dispatchEvent(new happy.Event(type, { bubbles: true }) as unknown as Event);
}
async function drain(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}
function setSession(overrides: Record<string, unknown> = {}): void {
  state.live = {
    isConnected: () => true,
    agentTrace: async () => page("Reply"),
    promptAgent: async () => ({ outcome: "applied" }),
    sendKeys: async () => undefined,
    snapshot: async () => ({ panes: [{ pane_id: "p1", workspace_id: "w1", agent: "codex",
      agent_status: "working", cwd: "/tmp/review", history_available: true }] }),
    ...overrides,
  } as unknown as Session;
}

beforeEach(async () => {
  await resetTestDOM();
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.requestAnimationFrame = happy.requestAnimationFrame.bind(happy);
  globals.cancelAnimationFrame = happy.cancelAnimationFrame.bind(happy);
  resetComposeDrafts();
  clearAgentTraceCache();
  resetPaneView();
  setLang("zh");
  state.phase = "live";
  state.screen = "pane";
  state.paneId = "p1";
  state.credential = null;
  state.agentChat = true;
  state.agentTraceLoadState = "ready";
  state.agentTraceItems = page("Initial").items;
  state.agentTraceTail = 2;
  state.agentTraceSig = JSON.stringify(state.agentTraceItems);
  state.operationBusy = false;
  state.operationCapabilities = { ...state.operationCapabilities, prompt_agent: true, history: true };
  state.agents = ["p1", "p2"].map(paneId => ({ paneId, agent: "codex", hasAgent: true,
    status: "idle", workspaceLabel: paneId, cwd: "/tmp/review", historyAvailable: true }));
  clearNotice();
  setSession();
  setRenderer(mount);
});
afterEach(() => {
  act(leaveReactScreen);
  leaveAgentChat({ paint: false });
  resetComposeDrafts();
  clearAgentTraceCache();
  state.operationBusy = false;
  state.live = null;
  state.paneId = "";
  state.screen = "home";
  state.composeIME = false;
  state.composeFocused = false;
  setRenderer(() => {});
});

test("direct parent reuse for another pane restores that pane's draft and replaces the owned field", () => {
  state.composeDraft = "Pane one draft";
  act(mount);
  const previous = field();
  act(() => {
    switchComposeView(() => { state.paneId = "p2"; });
    state.composeDraft = "Pane two draft";
    mount();
  });
  expect(field().value).toBe("Pane two draft");
  expect(field() === previous).toBeFalse();
  expect(readStoredDraft({ daemonId: null, paneId: "p1", mode: "agent" }).text).toBe("Pane one draft");
});

test("a new session reusing the pane id cannot keep the preceding session's compose field", () => {
  state.composeDraft = "Old computer draft";
  act(mount);
  const previous = field();
  setSession();
  state.composeDraft = "Current computer draft";
  act(mount);
  expect(field().value).toBe("Current computer draft");
  expect(field() === previous).toBeFalse();
});

test("a new pane does not inherit the previous pane's expanded tools or lazy detail request", async () => {
  const requested: string[] = [];
  setSession({ agentTraceDetail: async (paneId: string, detailRef: string) => {
    requested.push(`${paneId}:${detailRef}`);
    return { detailRef, output: "Tool result", truncated: false };
  } });
  const items = (detailRef: string): AgentTracePage["items"] => [
    { type: "user", text: "Same question" }, { type: "tool", name: "Read", detailRef },
    { type: "assistant", text: "Same answer" },
  ];
  state.agentTraceItems = items("first-detail");
  act(mount);
  act(() => {
    app.querySelector<HTMLDetailsElement>(".agent-reply-fold")!.open = true;
    app.querySelector<HTMLDetailsElement>(".agent-tool")!.open = true;
  });
  await drain();
  expect(requested).toEqual(["p1:first-detail"]);
  act(() => {
    switchComposeView(() => { state.paneId = "p2"; });
    state.agentTraceItems = items("second-detail");
    mount();
  });
  await drain();
  expect({ foldOpen: app.querySelector<HTMLDetailsElement>(".agent-reply-fold")!.open,
    toolOpen: app.querySelector<HTMLDetailsElement>(".agent-tool")!.open, requested })
    .toEqual({ foldOpen: false, toolOpen: false, requested: ["p1:first-detail"] });
});

test("older-page publication anchors against committed React content and keeps the stream node", async () => {
  const pending = deferred<AgentTracePage>();
  setSession({ agentTrace: () => pending.promise });
  state.agentTraceNext = "older-cursor";
  state.agentTraceFollow = false;
  act(mount);
  const original = stream();
  Object.defineProperties(original, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, get: () => original.querySelectorAll(".agent-user, .agent-assistant").length * 100 },
  });
  original.scrollTop = 25;
  let refresh!: Promise<boolean>;
  act(() => { refresh = refreshAgentTrace(true); });
  expect(app.querySelector<HTMLButtonElement>(".agent-older")!.disabled).toBeTrue();
  await act(async () => {
    pending.resolve({ items: [{ type: "user", text: "Older question" }, { type: "assistant", text: "Older reply" }],
      nextCursor: null, truncated: false });
    await refresh;
  });
  expect(stream() === original).toBeTrue();
  expect(original.scrollHeight).toBe(400);
  expect(original.scrollTop).toBe(225);
  expect(state.agentTraceBusy).toBeFalse();
  expect(app.querySelector<HTMLButtonElement>(".agent-older")!.hidden).toBeTrue();
});

test("a current-tail update preserves reading position and publishes the unread jump", () => {
  state.agentTraceFollow = false;
  act(mount);
  const original = stream();
  Object.defineProperties(original, { clientHeight: { value: 100 }, scrollHeight: { value: 600 } });
  original.scrollTop = 80;
  state.agentTraceItems = page("Changed reply").items;
  act(() => { expect(patchAgentChat()).toBeTrue(); });
  expect(stream() === original).toBeTrue();
  expect(original.scrollTop).toBe(80);
  expect(state.agentTraceUnread).toBeTrue();
  expect(app.querySelector<HTMLButtonElement>(".agent-jump")!.hidden).toBeFalse();
});

test("a retired trace request cannot overwrite the new pane or release its active read", async () => {
  const oldRead = deferred<AgentTracePage>();
  const newRead = deferred<AgentTracePage>();
  setSession({ agentTrace: (paneId: string) => paneId === "p1" ? oldRead.promise : newRead.promise });
  act(mount);
  let previous!: Promise<boolean>;
  act(() => { previous = refreshAgentTrace(); });
  act(() => {
    leaveAgentChat({ paint: false });
    resetPaneView();
    state.paneId = "p2";
    state.agentChat = true;
    state.agentTraceLoadState = "ready";
    mount();
  });
  let current!: Promise<boolean>;
  act(() => { current = refreshAgentTrace(); });
  await act(async () => { oldRead.resolve(page("Retired reply")); await previous; });
  expect(state.agentTraceBusy).toBeTrue();
  expect(app.textContent).not.toContain("Retired reply");
  await act(async () => { newRead.resolve(page("Current reply")); await current; });
  expect(state.agentTraceBusy).toBeFalse();
  expect(app.textContent).toContain("Current reply");
});

test("IME text and selection survive notice/chrome publications and Enter does not submit early", async () => {
  const submitted: string[] = [];
  const pending = deferred<unknown>();
  setSession({ promptAgent: (input: { text: string }) => { submitted.push(input.text); return pending.promise; } });
  state.composeDraft = "Committed";
  act(mount);
  const input = field();
  act(() => {
    input.focus();
    emit(input, "compositionstart");
    input.value = "拼音 in progress";
    input.setSelectionRange(2, 5);
    emit(input, "input");
    showStatus("Notice while composing");
    state.agents[0].status = "blocked";
    patchAgentChat();
    input.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }) as unknown as Event);
  });
  expect(submitted).toEqual([]);
  expect(field() === input).toBeTrue();
  expect(document.activeElement === input).toBeTrue();
  expect(input.value).toBe("拼音 in progress");
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5]);
  expect(state.composeDraft).toBe("Committed");
  expect(app.querySelector(".agent-confirm")).not.toBeNull();
  expect(app.querySelector("[data-app-notice]")?.textContent).toBe("Notice while composing");
  act(() => {
    input.value = "Confirmed text";
    emit(input, "compositionend");
    input.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
  });
  expect(submitted).toEqual(["Confirmed text"]);
  await act(async () => { pending.resolve({ outcome: "applied" }); await Promise.resolve(); });
  await drain();
});

test("the detached composer releases every input/composition/key listener", () => {
  let submits = 0;
  setSession({ promptAgent: async () => { submits++; } });
  act(mount);
  const previous = field();
  act(leaveReactScreen);
  state.composeDraft = "New owner draft";
  act(() => {
    previous.value = "Detached text";
    emit(previous, "input");
    emit(previous, "compositionstart");
    previous.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
  });
  expect(state.composeDraft).toBe("New owner draft");
  expect(state.composeIME).toBeFalse();
  expect(submits).toBe(0);
});

test("an old prompt failure restores only its saved draft and cannot release a newer prompt lock", async () => {
  const failure = deferred<unknown>();
  setSession({ promptAgent: () => failure.promise });
  state.composeDraft = "First pane attempt";
  act(mount);
  let request!: Promise<void>;
  act(() => { request = submitAgentPrompt(); });
  act(() => {
    switchComposeView(() => { state.paneId = "p2"; });
    state.composeDraft = "Second pane draft";
    leaveReactScreen();
    mount();
  });
  const owner = capturePromptRequest(state.live!, "p2", "New attempt");
  expect(owner).not.toBeNull();
  await act(async () => { failure.reject(new Error("First pane failed")); await request; });
  expect(state.operationBusy).toBeTrue();
  expect(field().value).toBe("Second pane draft");
  expect(state.composeDraft).toBe("Second pane draft");
  expect(visibleNotice()?.text).not.toBe("First pane failed");
  expect(readStoredDraft({ daemonId: null, paneId: "p1", mode: "agent" }).text).toBe("First pane attempt");
});

test("unknown-outcome prompt refreshes state once without replaying the mutation", async () => {
  let mutations = 0, snapshots = 0;
  const snapshot = { panes: [{ pane_id: "p1", workspace_id: "w1", agent: "codex", agent_status: "working",
    cwd: "/tmp/review", history_available: true }] };
  setSession({ promptAgent: async () => { mutations++; throw new ProtocolError("unknown_outcome", "Unknown outcome"); },
    snapshot: async () => { snapshots++; return snapshot; } });
  state.composeDraft = "Do this once";
  act(mount);
  await act(async () => { await submitAgentPrompt(); });
  expect(mutations).toBe(1);
  expect(snapshots).toBe(1);
  expect(state.composeDraft).toBe("");
  expect(state.operationBusy).toBeFalse();
  expect(field().value).toBe("");
});

test("a cold pane unmounted before its guarded microtask does not start an orphan read", async () => {
  let reads = 0;
  setSession({ agentTrace: async () => { reads++; return page("Cold reply"); } });
  state.agentTraceItems = [];
  state.agentTraceLoadState = "cold";
  act(() => { mount(); leaveReactScreen(); });
  await drain();
  expect(reads).toBe(0);
});
