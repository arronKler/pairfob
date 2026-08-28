import { canPromptAgent, statusLabel } from "../lib/dashboard";
import { button, node } from "../lib/dom";
import { firstTurnNeedsUser } from "../lib/agent-trace-view";
import { cacheAgentTrace, cachedAgentTrace } from "../lib/agent-trace-cache";
import type { AgentTraceItem, AgentTracePage } from "../lib/operations";
import { ProtocolError } from "../lib/protocol/errors";
import { messageOf } from "../lib/notices";
import { track } from "../lib/telemetry";
import { fitOperationPrompt, OPERATION_INPUT_LIMITS } from "../lib/operations";
import { render } from "../paint";
import {
  COMPOSE_MAX_PX,
  COMPOSE_MIN_PX,
  app,
  haptic,
  markPaneSubmitted,
  selectedAgent,
  setPaneTermMode,
  state,
} from "../state";
import { backButton } from "./chrome";
import { leaveFullTerminal } from "./full-terminal";
import { chromeActionCluster, syncChromeStop } from "./session/chrome-actions";
import { paintAgentStream, readDetailsState } from "./agent-chat-stream";

function fingerprint(items: AgentTraceItem[]): string {
  return JSON.stringify(items);
}

function streamEl(): HTMLElement | null {
  return app.querySelector(".agent-stream");
}

function composeEl(): HTMLTextAreaElement | null {
  const field = app.querySelector(".agent-dock textarea");
  return field instanceof HTMLTextAreaElement ? field : null;
}

function atBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 32;
}

const TRACE_PAGE = 200;
const OLDER_FILL_MAX = 4;
let traceRequest = 0;

function streamSig(items: AgentTraceItem[], working: boolean, blocked: boolean): string {
  return `${fingerprint(items)}|${working ? 1 : 0}|${blocked ? 1 : 0}|${state.agentTraceLoadState}|${state.agentTraceNote}`;
}

function applyTracePage(page: AgentTracePage, older: boolean): boolean {
  if (older) {
    if (!page.items.length) {
      const changed = state.agentTraceNext !== page.nextCursor;
      state.agentTraceNext = page.nextCursor;
      return changed;
    }
    state.agentTraceItems = [...page.items, ...state.agentTraceItems];
    state.agentTraceNext = page.nextCursor;
    absorbPending(state.agentTraceItems);
    if (page.truncated) state.agentTraceNote = "部分内容已截断";
    return true;
  }
  const sig = fingerprint(page.items);
  if (sig === state.agentTraceSig) {
    const changed = state.agentTraceItems.length === state.agentTraceTail && state.agentTraceNext !== page.nextCursor;
    if (state.agentTraceItems.length === state.agentTraceTail) state.agentTraceNext = page.nextCursor;
    absorbPending(page.items);
    return changed;
  }
  const kept = Math.max(0, state.agentTraceItems.length - state.agentTraceTail);
  const prefix = kept > 0 ? state.agentTraceItems.slice(0, kept) : [];
  state.agentTraceItems = [...prefix, ...page.items];
  state.agentTraceTail = page.items.length;
  state.agentTraceSig = sig;
  if (prefix.length === 0) state.agentTraceNext = page.nextCursor;
  absorbPending(state.agentTraceItems);
  return true;
}

function rememberTrace(paneId: string): void {
  cacheAgentTrace(paneId, {
    items: state.agentTraceItems,
    nextCursor: state.agentTraceNext,
    note: state.agentTraceNote,
    signature: state.agentTraceSig,
    tail: state.agentTraceTail,
  });
}

export function restoreAgentTrace(paneId: string): boolean {
  const entry = cachedAgentTrace(paneId);
  if (!entry) return false;
  state.agentTraceItems = entry.items;
  state.agentTraceNext = entry.nextCursor;
  state.agentTraceNote = entry.note;
  state.agentTraceSig = entry.signature;
  state.agentTraceTail = entry.tail;
  state.agentTraceLoadState = "ready";
  return true;
}

function emptyTraceMessage(working: boolean): string {
  if (state.agentTraceNote) return state.agentTraceNote;
  if (working) return state.agentTraceLoadState === "ready" ? "Agent 正在执行，正在等待新的过程记录…" : "Agent 正在执行，正在同步过程…";
  if (state.agentTraceLoadState === "cold" || state.agentTraceLoadState === "loading") return "正在读取 Agent 执行过程…";
  return "还没有对话。给 Agent 发一条消息开始。";
}

function traceLatencyBucket(ms: number): string {
  if (ms < 100) return "lt_100ms";
  if (ms < 500) return "lt_500ms";
  if (ms < 2_000) return "lt_2s";
  return "gte_2s";
}

function olderButton(): HTMLButtonElement {
  const btn = button("加载更早内容", "btn btn-small agent-older", () => {
    if (state.agentTraceNext && !state.agentTraceBusy) void refreshAgentTrace(true);
  });
  syncOlderButton(btn);
  return btn;
}

function syncOlderButton(btn?: HTMLElement | null): void {
  const el = btn ?? app.querySelector(".agent-older");
  if (!(el instanceof HTMLButtonElement)) return;
  const more = Boolean(state.agentTraceNext);
  el.hidden = !more;
  el.disabled = !more || state.agentTraceBusy;
  el.textContent = state.agentTraceBusy && more ? "正在读取更早内容…" : "加载更早内容";
}

export function stickAgentStream(): void {
  const stream = streamEl();
  if (stream && state.agentTraceFollow) stream.scrollTop = stream.scrollHeight;
}

function sizeChatCompose(field: HTMLTextAreaElement): void {
  field.style.height = "auto";
  field.style.height = `${Math.min(Math.max(field.scrollHeight, COMPOSE_MIN_PX), COMPOSE_MAX_PX)}px`;
}

const AGENT_PROMPT_LIMIT_NOTICE = "单条消息最多 32 KiB，已保留可发送的前半部分。";

function syncAgentDraft(input: HTMLTextAreaElement, hint: HTMLElement): void {
  const fitted = fitOperationPrompt(input.value);
  state.composeDraft = fitted.text;
  input.value = fitted.text;
  hint.hidden = !fitted.truncated;
  hint.textContent = fitted.truncated ? AGENT_PROMPT_LIMIT_NOTICE : "";
  sizeChatCompose(input);
  syncChatCompose();
}

function absorbPending(items: AgentTraceItem[]): void {
  const pending = state.agentTracePending.trim();
  if (!pending) return;
  if (items.some((item) => item.type === "user" && item.text === pending)) state.agentTracePending = "";
}

function visibleItems(): AgentTraceItem[] {
  const pending = state.agentTracePending.trim();
  if (!pending) return state.agentTraceItems;
  return [...state.agentTraceItems, { type: "user", text: pending }];
}

export function canEnterAgentChat(agent: { historyAvailable?: boolean; hasAgent?: boolean } | null | undefined = selectedAgent()): boolean {
  return Boolean(agent && state.operationCapabilities.history && (agent.historyAvailable || agent.hasAgent));
}

function canSend(agent = selectedAgent()): boolean {
  return Boolean(agent && canPromptAgent(agent) && state.operationCapabilities.prompt_agent);
}

export async function refreshAgentTrace(older = false): Promise<boolean> {
  const session = state.live;
  const paneId = state.paneId;
  if (!session || !paneId || !state.agentChat || !session.isConnected()) return false;
  if (state.agentTraceBusy) return false;
  if (older && !state.agentTraceNext) return false;
  const request = ++traceRequest;
  const measureColdLoad = !older && state.agentTraceLoadState === "cold" && !state.agentTraceItems.length;
  const startedAt = Date.now();
  let measured = false;
  const stream = streamEl();
  const follow = !older && (!stream || atBottom(stream));
  const top = stream?.scrollTop ?? 0;
  const height = stream?.scrollHeight ?? 0;
  state.agentTraceBusy = true;
  if (!older && !state.agentTraceItems.length && !state.agentTracePending) state.agentTraceLoadState = "loading";
  stream?.setAttribute("aria-busy", "true");
  syncOlderButton();
  if (!older) state.agentTraceNote = "";
  let changed = false;
  try {
    let cursor: string | null = older ? state.agentTraceNext : null;
    let pulls = 0;
    const filling = !older;
    while (pulls < (filling ? OLDER_FILL_MAX : 1)) {
      const page = await session.agentTrace(paneId, cursor, TRACE_PAGE);
      if (request !== traceRequest || state.live !== session || state.paneId !== paneId || !state.agentChat) return false;
      if (measureColdLoad && !measured) {
        track("pwa_agent_trace", {
          result: page.items.length ? "content" : "empty",
          extra: traceLatencyBucket(Date.now() - startedAt),
        });
        measured = true;
      }
      const applied = applyTracePage(page, cursor !== null);
      if (page.truncated) state.agentTraceNote = "部分内容已截断";
      else if (!cursor) state.agentTraceNote = "";
      changed = applied || changed;
      pulls += 1;
      state.agentTraceLoadState = "ready";
      rememberTrace(paneId);
      if (applied || pulls === 1) {
        const current = streamEl();
        const pageTop = cursor === null ? top : current?.scrollTop ?? top;
        const pageHeight = cursor === null ? height : current?.scrollHeight ?? height;
        if (!patchAgentChat({ follow, older: cursor !== null, top: pageTop, height: pageHeight })) render();
      }
      if (cursor !== null && !applied) break;
      if (!filling || !firstTurnNeedsUser(state.agentTraceItems, state.agentTraceNext) || !state.agentTraceNext) break;
      cursor = state.agentTraceNext;
    }
    state.agentTraceLoadState = "ready";
    rememberTrace(paneId);
    syncOlderButton();
    return changed;
  } catch (error) {
    if (request !== traceRequest || state.live !== session || state.paneId !== paneId || !state.agentChat) return false;
    const code = error instanceof ProtocolError ? error.code : "";
    if (measureColdLoad && !measured) {
      track("pwa_agent_trace", { result: code || "failed", extra: traceLatencyBucket(Date.now() - startedAt) });
      measured = true;
    }
    state.agentTraceLoadState = "error";
    if (code === "transcript_unavailable") {
      state.agentTraceItems = [];
      state.agentTraceNext = null;
      state.agentTraceSig = "";
      state.agentTraceTail = 0;
      state.agentTraceNote = state.agentTracePending
        ? ""
        : "还没有可读取的 Agent 记录。发出去的消息会写进这个对话。";
      if (!patchAgentChat({ follow: true })) render();
      return false;
    }
    state.agentTraceNote = messageOf(error, "read");
    if (!patchAgentChat({ follow })) render();
    return false;
  } finally {
    if (request === traceRequest && state.live === session && state.paneId === paneId && state.agentChat) {
      state.agentTraceBusy = false;
      streamEl()?.setAttribute("aria-busy", "false");
      syncOlderButton();
    }
  }
}

export function enterAgentChat(): void {
  if (!state.live || !state.paneId || state.agentChat) return;
  const start = () => {
    haptic(8);
    setPaneTermMode(state.paneId, "agent");
    state.fullTerminal = false;
    state.agentChat = true;
    state.agentTraceFollow = true;
    render();
    void refreshAgentTrace();
    queueMicrotask(() => composeEl()?.focus());
  };
  if (state.fullTerminal) {
    void leaveFullTerminal({ rememberGuided: false, paint: false }).then(() => {
      if (state.phase !== "live" || !state.paneId) return;
      start();
    });
    return;
  }
  start();
}

export function leaveAgentChat(opts?: { rememberGuided?: boolean; paint?: boolean }): void {
  if (!state.agentChat) return;
  if (opts?.rememberGuided !== false) setPaneTermMode(state.paneId, "guided");
  state.agentChat = false;
  traceRequest++;
  state.agentTraceBusy = false;
  state.agentTracePending = "";
  if (opts?.paint !== false) render();
}

function paintItems(items: AgentTraceItem[], working: boolean, stream: HTMLElement | null): HTMLElement {
  const next = paintAgentStream({
    items,
    working,
    emptyMessage: emptyTraceMessage(working),
    note: state.agentTraceNote,
    busy: state.agentTraceBusy || (!state.agentTraceItems.length && state.agentTraceLoadState === "cold"),
    kept: readDetailsState(stream),
    blocked: selectedAgent()?.status === "blocked",
    onConfirm: () => leaveAgentChat(),
    onNeedOlder: () => {
      if (state.agentTraceNext && !state.agentTraceBusy) void refreshAgentTrace(true);
    },
  });
  next.querySelector(".agent-stream-inner")?.prepend(olderButton());
  return next;
}

function syncChatCompose(agent = selectedAgent()): void {
  const input = composeEl();
  const send = app.querySelector(".agent-dock .send-btn");
  if (!(input instanceof HTMLTextAreaElement) || !(send instanceof HTMLButtonElement)) return;
  const allowed = canSend(agent);
  input.placeholder = allowed ? "给 Agent 发消息" : "这个会话还不能给 Agent 发任务";
  input.disabled = !allowed || state.operationBusy;
  send.disabled = !allowed || state.operationBusy || !state.composeDraft.trim();
}

function patchChatChrome(chrome: HTMLElement, selected: ReturnType<typeof selectedAgent>): void {
  const title = chrome.querySelector(".full-terminal-title");
  if (title) title.textContent = selected ? selected.agent || "对话" : "对话";
  const status = chrome.querySelector(".full-terminal-status");
  if (status) status.textContent = selected ? statusLabel(selected.status) : "";
  syncChromeStop(chrome, selected?.status === "working", () => {
    const session = state.live;
    const paneId = state.paneId;
    if (!session || !paneId) return;
    void session.sendKeys(paneId, ["esc"], { intent: "pad" }).then(() => refreshAgentTrace());
  });
}

export function patchAgentChat(opts?: { follow?: boolean; older?: boolean; top?: number; height?: number }): boolean {
  const root = app.querySelector(".agent-chat-root");
  const stream = streamEl();
  const chrome = root?.querySelector(".chrome");
  if (!root || !stream || !(chrome instanceof HTMLElement) || !state.agentChat) return false;
  const selected = selectedAgent();
  const working = selected?.status === "working";
  const blocked = selected?.status === "blocked";
  const items = visibleItems();
  const sig = streamSig(items, working, blocked);
  const follow = opts?.follow ?? (state.agentTraceFollow && atBottom(stream));
  const prevTop = opts?.top ?? stream.scrollTop;
  const prevHeight = opts?.height ?? stream.scrollHeight;
  patchChatChrome(chrome, selected);
  syncChatCompose(selected);
  syncOlderButton();
  if (!opts?.older && stream.dataset.sig === sig) {
    if (follow) {
      state.agentTraceFollow = true;
      stream.scrollTop = stream.scrollHeight;
    }
    return true;
  }
  const next = paintItems(items, working, stream);
  next.dataset.sig = sig;
  stream.replaceWith(next);
  const painted = streamEl();
  if (!painted) return true;
  if (opts?.older) painted.scrollTop = painted.scrollHeight - prevHeight + prevTop;
  else if (follow) {
    state.agentTraceFollow = true;
    painted.scrollTop = painted.scrollHeight;
  } else {
    painted.scrollTop = prevTop;
  }
  return true;
}

function chatCompose(selectedHasAgent: boolean): { dock: HTMLElement; input: HTMLTextAreaElement } {
  const dock = node("div", "dock agent-dock");
  const form = node("form", "dock-form");
  const input = node("textarea");
  const hint = node("p", "agent-compose-hint");
  hint.setAttribute("aria-live", "polite");
  hint.hidden = true;
  input.rows = 1;
  input.enterKeyHint = "send";
  input.maxLength = OPERATION_INPUT_LIMITS.prompt;
  input.placeholder = selectedHasAgent ? "给 Agent 发消息" : "这个会话还不能给 Agent 发任务";
  const initial = fitOperationPrompt(state.composeDraft);
  state.composeDraft = initial.text;
  input.value = initial.text;
  if (initial.truncated) {
    hint.hidden = false;
    hint.textContent = AGENT_PROMPT_LIMIT_NOTICE;
  }
  input.disabled = !selectedHasAgent || state.operationBusy;
  input.addEventListener("input", () => {
    if (state.composeIME) {
      sizeChatCompose(input);
      return;
    }
    syncAgentDraft(input, hint);
  });
  input.addEventListener("compositionstart", () => {
    state.composeIME = true;
  });
  input.addEventListener("compositionend", () => {
    state.composeIME = false;
    syncAgentDraft(input, hint);
  });
  input.addEventListener("focus", () => {
    state.composeFocused = true;
  });
  input.addEventListener("blur", () => {
    state.composeFocused = false;
  });
  input.addEventListener("keydown", (event) => {
    if (event.isComposing || state.composeIME) return;
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    void submitAgentPrompt();
  });
  const send = button("发送", "send-btn", () => void submitAgentPrompt());
  send.disabled = !selectedHasAgent || state.operationBusy || !state.composeDraft.trim();
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitAgentPrompt();
  });
  form.append(input, send);
  dock.append(form, hint);
  return { dock, input };
}

async function submitAgentPrompt(): Promise<void> {
  const session = state.live;
  const selected = selectedAgent();
  const text = state.composeDraft.trim();
  if (!session || !selected || !text || !canSend(selected) || state.operationBusy) return;
  state.operationBusy = true;
  state.composeDraft = "";
  state.agentTracePending = text;
  state.agentTraceFollow = true;
  const field = composeEl();
  if (field) {
    field.value = "";
    sizeChatCompose(field);
  }
  syncChatCompose(selected);
  if (!patchAgentChat({ follow: true })) render();
  try {
    await session.promptAgent({ pane_id: selected.paneId, text });
    markPaneSubmitted(selected.paneId);
    haptic(8);
    if (!patchAgentChat({ follow: true })) render();
    await refreshAgentTrace();
  } catch (error) {
    state.composeDraft = text;
    state.agentTracePending = "";
    state.agentTraceNote = messageOf(error);
    const restore = composeEl();
    if (restore) {
      restore.value = text;
      sizeChatCompose(restore);
    }
    if (!patchAgentChat({ follow: true })) render();
  } finally {
    state.operationBusy = false;
    syncChatCompose();
    stickAgentStream();
    composeEl()?.focus();
  }
}

function chatChrome(
  onBack: () => void,
  includeBack: boolean,
  onMenu: () => void,
  selected: ReturnType<typeof selectedAgent>,
): HTMLElement {
  const chrome = node("header", "chrome");
  if (includeBack) {
    chrome.append(backButton(onBack, "返回会话列表"));
  }
  const title = node("div", "full-terminal-heading");
  title.append(
    node("strong", "full-terminal-title", selected ? selected.agent || "对话" : "对话"),
    node("span", "full-terminal-status", selected ? statusLabel(selected.status) : ""),
  );
  chrome.append(title, chromeActionCluster(onMenu));
  syncChromeStop(chrome, selected?.status === "working", () => {
    const session = state.live;
    const paneId = state.paneId;
    if (!session || !paneId) return;
    void session.sendKeys(paneId, ["esc"], { intent: "pad" }).then(() => refreshAgentTrace());
  });
  return chrome;
}

export function fillAgentChat(
  container: HTMLElement,
  onBack: () => void,
  includeBack: boolean,
  onMenu: () => void,
): HTMLTextAreaElement {
  const selected = selectedAgent();
  const working = selected?.status === "working";
  const items = visibleItems();
  const stream = paintItems(items, working, null);
  const { dock, input } = chatCompose(canSend(selected));
  stream.dataset.sig = streamSig(items, working, selected?.status === "blocked");
  container.dataset.back = includeBack ? "1" : "0";
  container.append(chatChrome(onBack, includeBack, onMenu, selected), stream, dock);
  sizeChatCompose(input);
  if (!state.agentTraceBusy && state.agentTraceLoadState === "cold") void refreshAgentTrace();
  if (state.agentTraceFollow) requestAnimationFrame(stickAgentStream);
  return input;
}

export function renderAgentChat(onBack: () => void, onMenu: () => void): void {
  const root = node("div", "pane-root agent-chat-root");
  fillAgentChat(root, onBack, true, onMenu);
  app.replaceChildren(root);
}
