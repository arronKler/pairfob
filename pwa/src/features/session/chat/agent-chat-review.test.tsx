import { happy, resetTestDOM } from "../../../../test-support/boot-dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { appRoot } from "../../../app/dom-root";
import { resetComposeDrafts, capturePromptRequest, switchComposeView } from "../drafts/compose-drafts";
import { readStoredDraft } from "../drafts/state-drafts";
import { clearAgentTraceCache } from "../../../lib/agent-trace-cache";
import { setLang } from "../../../lib/i18n";
import type { AgentTracePage } from "../../../lib/operations";
import type { LiveSession } from "../../../lib/protocol/client";
import { ProtocolError } from "../../../lib/protocol/errors";
import { NO_OPERATION_CAPABILITIES } from "../../../lib/operations";
import { applyTrace, chatSnapshot, setTraceBusy, setTraceLoadState } from "./trace-store";
import { leaveAgentChat, patchAgentChat, refreshAgentTrace, submitAgentPrompt } from "./agent-chat-controller";
import { applyCapabilities, operationBusy, setOperationBusy } from "../../operations/capabilities-store";
import { composeDraft, composeFocused, composeIME, setComposeDraft, setComposeFocused, setComposeIME } from "../compose-store";
import { clearNotice, showStatus, visibleNotice } from "../../../app/notices-store";
import { attachLiveSession, liveSession, setCredential } from "../../computers/catalog-store";
import { replaceAgentsFromSnapshot } from "../../dashboard/catalog-store";
import { resetPaneView, selectPane, setAgentChat } from "../session-store";
import { setPhase } from "../../connection/connection-store";
import { setScreen } from "../../../app/navigation-store";
import { bindSessionOwnerFromLive } from "../bind-live";
import { AgentChatPane } from "./agent-chat";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";

const handlers = { onBack() {}, onWorkspace() {}, onMenu() {}, onSwitch() {} };
const page = (text: string): AgentTracePage => ({ items: [
  { type: "user", text: "Question" }, { type: "assistant", text },
], nextCursor: null, truncated: false });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function catalog(paneIds: string[], statuses: Record<string, string> = {}): Parameters<typeof replaceAgentsFromSnapshot>[0] {
  return {
    focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: paneIds[0] ?? "" },
    workspaces: [{ workspace_id: "w1", label: "demo" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
    panes: paneIds.map(paneId => ({
      pane_id: paneId, workspace_id: "w1", tab_id: "w1:t1", cwd: "/tmp/review",
      agent: "codex", agent_status: statuses[paneId] ?? "idle", history_available: true,
    })),
  };
}

function mount(): void {
  bindSessionOwnerFromLive();
  renderReact(<AgentChatPane includeBack handlers={handlers} />);
}
function field(): HTMLTextAreaElement { return appRoot().querySelector<HTMLTextAreaElement>(".agent-dock textarea")!; }
function stream(): HTMLElement { return appRoot().querySelector<HTMLElement>(".agent-stream")!; }
function emit(input: HTMLTextAreaElement, type: string): void {
  input.dispatchEvent(new happy.Event(type, { bubbles: true }) as unknown as Event);
}
async function drain(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}
function setSession(overrides: Record<string, unknown> = {}): void {
  attachLiveSession({
    isConnected: () => true,
    agentTrace: async () => page("Reply"),
    promptAgent: async () => ({ outcome: "applied" }),
    sendKeys: async () => undefined,
    snapshot: async () => ({ panes: [{ pane_id: "p1", workspace_id: "w1", agent: "codex",
      agent_status: "working", cwd: "/tmp/review", history_available: true }] }),
    ...overrides,
  } as unknown as LiveSession);
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
  setPhase("live");
  setScreen("pane");
  selectPane("p1");
  setCredential(null);
  setAgentChat(true);
  setTraceLoadState("ready");
  applyTrace({
    agentTraceItems: page("Initial").items,
    agentTraceTail: 2,
    agentTraceSig: JSON.stringify(page("Initial").items),
  });
  setOperationBusy(false);
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, prompt_agent: true, history: true }, []);
  replaceAgentsFromSnapshot(catalog(["p1", "p2"]));
  clearNotice();
  setSession();
});
afterEach(() => {
  act(unmountReact);
  leaveAgentChat({ paint: false });
  resetComposeDrafts();
  clearAgentTraceCache();
  setOperationBusy(false);
  attachLiveSession(null);
  selectPane("");
  setScreen("home");
  setComposeIME(false);
  setComposeFocused(false);
});

test("direct parent reuse for another pane restores that pane's draft and replaces the owned field", () => {
  setComposeDraft("Pane one draft");
  act(mount);
  const previous = field();
  act(() => {
    switchComposeView(() => { selectPane("p2"); });
    setComposeDraft("Pane two draft");
    mount();
  });
  expect(field().value).toBe("Pane two draft");
  expect(field() === previous).toBeFalse();
  expect(readStoredDraft({ daemonId: null, paneId: "p1", mode: "agent" }).text).toBe("Pane one draft");
});

test("a new session reusing the pane id cannot keep the preceding session's compose field", () => {
  setComposeDraft("Old computer draft");
  act(mount);
  const previous = field();
  act(() => {
    setSession();
    setComposeDraft("Current computer draft");
  });
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
  applyTrace({ agentTraceItems: items("first-detail") });
  act(mount);
  act(() => {
    appRoot().querySelector<HTMLDetailsElement>(".agent-reply-fold")!.open = true;
    appRoot().querySelector<HTMLDetailsElement>(".agent-tool")!.open = true;
  });
  await drain();
  expect(requested).toEqual(["p1:first-detail"]);
  act(() => {
    switchComposeView(() => { selectPane("p2"); });
    applyTrace({ agentTraceItems: items("second-detail") });
    mount();
  });
  await drain();
  expect({ foldOpen: appRoot().querySelector<HTMLDetailsElement>(".agent-reply-fold")!.open,
    toolOpen: appRoot().querySelector<HTMLDetailsElement>(".agent-tool")!.open, requested })
    .toEqual({ foldOpen: false, toolOpen: false, requested: ["p1:first-detail"] });
});

test("older-page publication anchors against committed React content and keeps the stream node", async () => {
  const pending = deferred<AgentTracePage>();
  setSession({ agentTrace: () => pending.promise });
  applyTrace({ agentTraceNext: "older-cursor", agentTraceFollow: false });
  act(mount);
  const original = stream();
  Object.defineProperties(original, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, get: () => original.querySelectorAll(".agent-user, .agent-assistant").length * 100 },
  });
  original.scrollTop = 25;
  let refresh!: Promise<boolean>;
  act(() => { refresh = refreshAgentTrace(true); });
  expect(appRoot().querySelector<HTMLButtonElement>(".agent-older")!.disabled).toBeTrue();
  await act(async () => {
    pending.resolve({ items: [{ type: "user", text: "Older question" }, { type: "assistant", text: "Older reply" }],
      nextCursor: null, truncated: false });
    await refresh;
  });
  expect(stream() === original).toBeTrue();
  expect(original.scrollHeight).toBe(400);
  expect(original.scrollTop).toBe(225);
  expect(chatSnapshot().agentTraceBusy).toBeFalse();
  expect(appRoot().querySelector<HTMLButtonElement>(".agent-older")!.hidden).toBeTrue();
});

test("a current-tail update preserves reading position and publishes the unread jump", () => {
  applyTrace({ agentTraceFollow: false });
  act(mount);
  const original = stream();
  Object.defineProperties(original, { clientHeight: { value: 100 }, scrollHeight: { value: 600 } });
  original.scrollTop = 80;
  act(() => {
    applyTrace({ agentTraceItems: page("Changed reply").items });
    expect(patchAgentChat()).toBeTrue();
  });
  expect(stream() === original).toBeTrue();
  expect(original.scrollTop).toBe(80);
  expect(chatSnapshot().agentTraceUnread).toBeTrue();
  expect(appRoot().querySelector<HTMLButtonElement>(".agent-jump")!.hidden).toBeFalse();
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
    selectPane("p2");
    setAgentChat(true);
    setTraceLoadState("ready");
    setTraceBusy(false);
    mount();
  });
  let current!: Promise<boolean>;
  act(() => { current = refreshAgentTrace(); });
  await act(async () => { oldRead.resolve(page("Retired reply")); await previous; });
  expect(chatSnapshot().agentTraceBusy).toBeTrue();
  expect(appRoot().textContent).not.toContain("Retired reply");
  await act(async () => { newRead.resolve(page("Current reply")); await current; });
  expect(chatSnapshot().agentTraceBusy).toBeFalse();
  expect(appRoot().textContent).toContain("Current reply");
});

test("IME text and selection survive notice/chrome publications and Enter does not submit early", async () => {
  const submitted: string[] = [];
  const pending = deferred<unknown>();
  setSession({ promptAgent: (input: { text: string }) => { submitted.push(input.text); return pending.promise; } });
  setComposeDraft("Committed");
  act(mount);
  const input = field();
  act(() => {
    input.focus();
    emit(input, "compositionstart");
    input.value = "拼音 in progress";
    input.setSelectionRange(2, 5);
    emit(input, "input");
    showStatus("Notice while composing");
    replaceAgentsFromSnapshot(catalog(["p1", "p2"], { p1: "blocked" }));
    patchAgentChat();
    input.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }) as unknown as Event);
  });
  expect(submitted).toEqual([]);
  expect(field() === input).toBeTrue();
  expect(document.activeElement === input).toBeTrue();
  expect(input.value).toBe("拼音 in progress");
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5]);
  expect(composeDraft()).toBe("Committed");
  expect(appRoot().querySelector(".agent-confirm")).not.toBeNull();
  expect(appRoot().querySelector("[data-app-notice]")?.textContent).toBe("Notice while composing");
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
  act(unmountReact);
  setComposeDraft("New owner draft");
  act(() => {
    previous.value = "Detached text";
    emit(previous, "input");
    emit(previous, "compositionstart");
    previous.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
  });
  expect(composeDraft()).toBe("New owner draft");
  expect(composeIME()).toBeFalse();
  expect(submits).toBe(0);
});

test("an old prompt failure restores only its saved draft and cannot release a newer prompt lock", async () => {
  const failure = deferred<unknown>();
  setSession({ promptAgent: () => failure.promise });
  setComposeDraft("First pane attempt");
  act(mount);
  let request!: Promise<void>;
  act(() => { request = submitAgentPrompt(); });
  act(() => {
    switchComposeView(() => { selectPane("p2"); });
    setComposeDraft("Second pane draft");
    unmountReact();
    mount();
  });
  const owner = capturePromptRequest(liveSession()!, "p2", "New attempt");
  expect(owner).not.toBeNull();
  await act(async () => { failure.reject(new Error("First pane failed")); await request; });
  expect(operationBusy()).toBeTrue();
  expect(field().value).toBe("Second pane draft");
  expect(composeDraft()).toBe("Second pane draft");
  expect(visibleNotice()?.text).not.toBe("First pane failed");
  expect(readStoredDraft({ daemonId: null, paneId: "p1", mode: "agent" }).text).toBe("First pane attempt");
});

test("unknown-outcome prompt refreshes state once without replaying the mutation", async () => {
  let mutations = 0, snapshots = 0;
  const snapshot = { panes: [{ pane_id: "p1", workspace_id: "w1", agent: "codex", agent_status: "working",
    cwd: "/tmp/review", history_available: true }] };
  setSession({ promptAgent: async () => { mutations++; throw new ProtocolError("unknown_outcome", "Unknown outcome"); },
    snapshot: async () => { snapshots++; return snapshot; } });
  setComposeDraft("Do this once");
  act(mount);
  await act(async () => { await submitAgentPrompt(); });
  expect(mutations).toBe(1);
  expect(snapshots).toBe(1);
  expect(composeDraft()).toBe("");
  expect(operationBusy()).toBeFalse();
  expect(field().value).toBe("");
});

test("a cold pane unmounted before its guarded microtask does not start an orphan read", async () => {
  let reads = 0;
  setSession({ agentTrace: async () => { reads++; return page("Cold reply"); } });
  applyTrace({ agentTraceItems: [], agentTraceLoadState: "cold" });
  // mount commits inside its own act: the actual chat node is confirmed mounted
  // before the same-task unmount retires the guarded cold-start microtask.
  mount();
  expect(appRoot().querySelector("[data-react-agent-chat]")).not.toBeNull();
  unmountReact();
  await drain();
  expect(reads).toBe(0);
});
test("unreadable Pi transcript keeps a terminal exit after one successful send and can later recover", async () => {
  let sends = 0;
  let readable = false;
  const snapshot = catalog(["p1"]);
  snapshot.panes = snapshot.panes!.map(pane => ({ ...pane, agent: "pi", history_available: false }));
  replaceAgentsFromSnapshot(snapshot);
  applyTrace({ agentTraceItems: [], agentTraceNote: "", agentTracePending: "" });
  setSession({
    agentTrace: async () => {
      if (!readable) throw new ProtocolError("transcript_unavailable");
      return page("Recovered answer");
    },
    promptAgent: async () => { sends++; return { outcome: "applied" }; },
  });
  act(mount);
  await act(async () => { await refreshAgentTrace(); });
  expect(stream().textContent).toContain("当前无法读取此会话的记录");
  expect(stream().querySelector(".agent-open-terminal")).not.toBeNull();
  setComposeDraft("Run once");
  await act(async () => { await submitAgentPrompt(); });
  expect(sends).toBe(1);
  expect(stream().querySelector(".agent-user-text")?.textContent).toBe("Run once");
  expect(stream().textContent).toContain("不要因为这里没有显示而重复发送");
  expect(stream().querySelector(".agent-run-status")).toBeNull();
  expect(stream().querySelector(".agent-open-terminal")).not.toBeNull();
  readable = true;
  await act(async () => { await refreshAgentTrace(); });
  expect(stream().textContent).toContain("Recovered answer");
  expect(stream().querySelector(".agent-open-terminal")).toBeNull();
  expect(sends).toBe(1);
});
