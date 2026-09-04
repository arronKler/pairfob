import { canPromptAgent, chromeName, statusLabel } from "../lib/dashboard";
import { button, node } from "../lib/dom";
import { t } from "../lib/i18n";
import { firstTurnNeedsUser, mergeAgentTraceSegments } from "../lib/agent-trace-view";
import { agentTraceDetailRevision, cacheAgentTrace, cachedAgentTrace } from "../lib/agent-trace-cache";
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
  showError,
  showStatus,
  state,
  visibleNotice,
  type Notice,
} from "../state";
import { backButton, canInterruptAgent, feedbackNode } from "./chrome";
import { leaveFullTerminal } from "./full-terminal";
import { chromeActionCluster, syncChromeStop } from "./session/chrome-actions";
import { paintAgentStream, readDetailsState, type AgentEmptySpec } from "./agent-chat-stream";
import { loadToolDetail, toolDetailView } from "./agent-chat-detail";

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

function streamSig(items: AgentTraceItem[], working: boolean): string {
  return `${fingerprint(items)}|${working ? 1 : 0}|${state.agentTraceLoadState}|${state.agentTraceTruncated ? 1 : 0}|${agentTraceDetailRevision()}`;
}

function applyTracePage(page: AgentTracePage, older: boolean): boolean {
  if (older) {
    if (!page.items.length) {
      const changed = state.agentTraceNext !== page.nextCursor;
      state.agentTraceNext = page.nextCursor;
      return changed;
    }
    const tailWasWholeView = state.agentTraceItems.length === state.agentTraceTail;
    const merged = mergeAgentTraceSegments(page.items, state.agentTraceItems);
    state.agentTraceItems = merged.items;
    if (tailWasWholeView) state.agentTraceTail = Math.max(0, state.agentTraceTail - merged.overlap);
    state.agentTraceNext = page.nextCursor;
    absorbPending(state.agentTraceItems);
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
  const merged = mergeAgentTraceSegments(prefix, page.items);
  state.agentTraceItems = merged.items;
  state.agentTraceTail = page.items.length - merged.overlap;
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
    truncated: state.agentTraceTruncated,
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
  state.agentTraceTruncated = entry.truncated;
  state.agentTraceSig = entry.signature;
  state.agentTraceTail = entry.tail;
  state.agentTraceLoadState = "ready";
  return true;
}

const traceUnavailableNote = () => t("chat.noTrace");

function emptySpec(working: boolean): AgentEmptySpec {
  const note = state.agentTraceNote;
  if (state.agentTraceLoadState === "error" && note && note !== traceUnavailableNote()) {
    return { kind: "error", title: note };
  }
  if (working) return { kind: "working", title: t("trace.running") };
  if (state.agentTraceLoadState === "cold" || state.agentTraceLoadState === "loading") {
    return { kind: "loading", title: t("chat.readingProcess") };
  }
  if (note === traceUnavailableNote()) return { kind: "empty", title: t("chat.noChat"), sub: t("chat.willWrite") };
  if (note) return { kind: "empty", title: t("chat.noChat"), sub: note };
  return {
    kind: "empty",
    title: t("chat.noChat"),
    sub: canSend() ? t("chat.sendBelow") : t("chat.cantSend"),
  };
}

function traceLatencyBucket(ms: number): string {
  if (ms < 100) return "lt_100ms";
  if (ms < 500) return "lt_500ms";
  if (ms < 2_000) return "lt_2s";
  return "gte_2s";
}

function olderButton(): HTMLButtonElement {
  const btn = button(t("hist.loadEarlier"), "btn btn-small agent-older", () => {
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
  el.textContent = state.agentTraceBusy && more ? t("chat.readingOlder") : t("hist.loadEarlier");
}

export function stickAgentStream(): void {
  const stream = streamEl();
  if (stream && state.agentTraceFollow) stream.scrollTop = stream.scrollHeight;
}

function syncAgentJump(): void {
  const jump = app.querySelector(".agent-jump") as HTMLElement | null;
  if (jump) jump.hidden = state.agentTraceFollow || !state.agentTraceUnread;
}

function jumpToLatest(): void {
  haptic(6);
  state.agentTraceFollow = true;
  state.agentTraceUnread = false;
  stickAgentStream();
  syncAgentJump();
}

function sizeChatCompose(field: HTMLTextAreaElement): void {
  field.style.height = "auto";
  field.style.height = `${Math.min(Math.max(field.scrollHeight, COMPOSE_MIN_PX), COMPOSE_MAX_PX)}px`;
}

const agentPromptLimitNotice = () => t("chat.limit");

function syncAgentDraft(input: HTMLTextAreaElement, hint: HTMLElement): void {
  const fitted = fitOperationPrompt(input.value);
  state.composeDraft = fitted.text;
  input.value = fitted.text;
  hint.hidden = !fitted.truncated;
  hint.textContent = fitted.truncated ? agentPromptLimitNotice() : "";
  sizeChatCompose(input);
  syncChatCompose();
}

function absorbPending(items: AgentTraceItem[]): void {
  const pending = state.agentTracePending.trim();
  if (!pending) return;
  const boundary = pendingBoundary(items);
  if (items.slice(boundary).some((item) => item.type === "user" && item.text === pending)) {
    state.agentTracePending = "";
    state.agentTracePendingBase = [];
  }
}

/** Tool outputs and live text may grow in place without moving the event itself. */
function sameTracePosition(before: AgentTraceItem, after: AgentTraceItem): boolean {
  if (before.type !== after.type) return false;
  if (before.type === "tool" && after.type === "tool") {
    return before.name === after.name && before.input === after.input && before.text === after.text;
  }
  const left = before.text || "";
  const right = after.text || "";
  return left === right || ((before.type === "assistant" || before.type === "thinking") && right.startsWith(left));
}

function pendingBoundary(items: AgentTraceItem[]): number {
  const baseline = state.agentTracePendingBase;
  let index = 0;
  while (index < baseline.length && index < items.length && sameTracePosition(baseline[index], items[index])) {
    index += 1;
  }
  return index;
}

function visibleItems(): AgentTraceItem[] {
  const pending = state.agentTracePending.trim();
  if (!pending) return state.agentTraceItems;
  const boundary = pendingBoundary(state.agentTraceItems);
  return [
    ...state.agentTraceItems.slice(0, boundary),
    { type: "user", text: pending },
    ...state.agentTraceItems.slice(boundary),
  ];
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
  if (!older) {
    state.agentTraceNote = "";
    state.agentTraceTruncated = false;
  }
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
      if (page.truncated) state.agentTraceTruncated = true;
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
      state.agentTraceTruncated = false;
      state.agentTraceNote = state.agentTracePending ? "" : traceUnavailableNote();
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
    state.agentTraceUnread = false;
    render();
    void refreshAgentTrace();
    queueMicrotask(() => composeEl()?.focus({ preventScroll: true }));
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
  state.agentTracePendingBase = [];
  if (opts?.paint !== false) render();
}

async function copyAgentReply(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    haptic(6);
    showStatus(t("chat.copiedReply"));
  } catch {
    showError(t("err.copyDenied"));
  }
  const root = app.querySelector(".agent-chat-root");
  if (root instanceof HTMLElement) paintChatNotice(root);
}

function paintItems(items: AgentTraceItem[], working: boolean, stream: HTMLElement | null): HTMLElement {
  const paneId = state.paneId;
  const next = paintAgentStream({
    items,
    working,
    empty: emptySpec(working),
    busy: state.agentTraceBusy || (!state.agentTraceItems.length && state.agentTraceLoadState === "cold"),
    kept: readDetailsState(stream),
    onRetry: () => {
      if (!state.agentTraceBusy) void refreshAgentTrace();
    },
    onNeedOlder: () => {
      if (state.agentTraceNext && !state.agentTraceBusy) void refreshAgentTrace(true);
    },
    onFollow: (follow) => {
      if (follow) state.agentTraceUnread = false;
      syncAgentJump();
    },
    onCopyReply: copyAgentReply,
    toolDetail: (item) => paneId && item.detailRef ? toolDetailView(paneId, item.detailRef) : { status: "ready" },
    onNeedToolDetail: (detailRef) => {
      if (!paneId) return;
      loadToolDetail(paneId, detailRef, () => {
        if (!patchAgentChat()) render();
      });
    },
    truncated: state.agentTraceTruncated,
  });
  next.querySelector(".agent-stream-inner")?.prepend(olderButton());
  return next;
}

function syncChatCompose(agent = selectedAgent()): void {
  const input = composeEl();
  const send = app.querySelector(".agent-dock .send-btn");
  if (!(input instanceof HTMLTextAreaElement) || !(send instanceof HTMLButtonElement)) return;
  const allowed = canSend(agent);
  input.placeholder = allowed ? t("chat.placeholder") : t("chat.cantSend");
  input.disabled = !allowed || state.operationBusy;
  send.disabled = !allowed || state.operationBusy || !state.composeDraft.trim();
}

function confirmBar(): HTMLElement {
  const bar = node("div", "agent-confirm");
  bar.append(node("p", "agent-confirm-copy", t("chat.waitingConfirm")));
  const go = button(t("chat.goConfirm"), "btn btn-small", () => leaveAgentChat());
  go.type = "button";
  bar.append(go);
  return bar;
}

function chatDockNotice(): Notice | null {
  const fromApp = visibleNotice();
  if (fromApp) return fromApp;
  if (!(state.agentTraceItems.length || state.agentTracePending) || !state.agentTraceNote) return null;
  return { text: state.agentTraceNote, tone: state.agentTraceLoadState === "error" ? "error" : "status" };
}

function paintChatNotice(root: HTMLElement): void {
  const want = chatDockNotice();
  const existing = root.querySelector(":scope > [data-app-notice]");
  if (!want) {
    existing?.remove();
    return;
  }
  if (
    existing instanceof HTMLElement &&
    existing.textContent === want.text &&
    existing.classList.contains(`notice-${want.tone}`)
  ) {
    return;
  }
  existing?.remove();
  const note = feedbackNode(want);
  note.setAttribute("data-app-notice", "");
  const chrome = root.querySelector(":scope > .chrome");
  if (chrome?.nextSibling) root.insertBefore(note, chrome.nextSibling);
  else root.prepend(note);
}

function syncChatDock(agent = selectedAgent()): void {
  syncChatCompose(agent);
  const dock = app.querySelector(".agent-dock");
  if (dock instanceof HTMLElement) {
    const blocked = agent?.status === "blocked";
    const existing = dock.querySelector(".agent-confirm");
    if (blocked && !existing) dock.prepend(confirmBar());
    else if (!blocked && existing) existing.remove();
  }
  const root = app.querySelector(".agent-chat-root");
  if (root instanceof HTMLElement) paintChatNotice(root);
}

function patchChatChrome(chrome: HTMLElement, selected: ReturnType<typeof selectedAgent>): void {
  const name = chrome.querySelector(".chrome-name");
  if (name) name.textContent = selected ? chromeName(selected) : t("mode.agent");
  const meta = chrome.querySelector(".chrome-meta-text");
  if (meta) meta.textContent = selected ? statusLabel(selected.status) : "";
  const dot = chrome.querySelector(".agent-dot");
  if (dot && selected) dot.className = `agent-dot agent-${selected.status}`;
  const title = chrome.querySelector(".chrome-title");
  if (title instanceof HTMLElement && selected) {
    const line = statusLabel(selected.status);
    title.title = [chromeName(selected), line].filter(Boolean).join(" · ");
    title.setAttribute(
      "aria-label",
      line
        ? t("chrome.switchAriaMeta", { title: chromeName(selected), line })
        : t("chrome.switchAria", { title: chromeName(selected) }),
    );
  }
  syncChromeStop(chrome, canInterruptAgent(selected?.status ?? ""), () => {
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
  const items = visibleItems();
  const sig = streamSig(items, working);
  const follow = opts?.follow ?? (state.agentTraceFollow && atBottom(stream));
  const prevTop = opts?.top ?? stream.scrollTop;
  const prevHeight = opts?.height ?? stream.scrollHeight;
  patchChatChrome(chrome, selected);
  syncChatDock(selected);
  syncOlderButton();
  if (!opts?.older && stream.dataset.sig === sig) {
    if (follow) {
      state.agentTraceFollow = true;
      state.agentTraceUnread = false;
      stream.scrollTop = stream.scrollHeight;
    }
    syncAgentJump();
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
    state.agentTraceUnread = false;
    painted.scrollTop = painted.scrollHeight;
  } else {
    painted.scrollTop = prevTop;
    state.agentTraceUnread = true;
  }
  syncAgentJump();
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
  input.placeholder = selectedHasAgent ? t("chat.placeholder") : t("chat.cantSend");
  const initial = fitOperationPrompt(state.composeDraft);
  state.composeDraft = initial.text;
  input.value = initial.text;
  if (initial.truncated) {
    hint.hidden = false;
    hint.textContent = agentPromptLimitNotice();
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
  const send = button(t("compose.send"), "send-btn", () => void submitAgentPrompt());
  send.disabled = !selectedHasAgent || state.operationBusy || !state.composeDraft.trim();
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitAgentPrompt();
  });
  form.append(input, send);
  if (selectedAgent()?.status === "blocked") dock.append(confirmBar());
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
  state.agentTracePendingBase = state.agentTraceItems.map((item) => ({ ...item }));
  state.agentTracePending = text;
  state.agentTraceFollow = true;
  const field = composeEl();
  if (field) {
    field.value = "";
    sizeChatCompose(field);
  }
  syncChatDock(selected);
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
    state.agentTracePendingBase = [];
    state.agentTraceNote = messageOf(error);
    const restore = composeEl();
    if (restore) {
      restore.value = text;
      sizeChatCompose(restore);
    }
    if (!patchAgentChat({ follow: true })) render();
  } finally {
    state.operationBusy = false;
    syncChatDock();
    stickAgentStream();
    composeEl()?.focus({ preventScroll: true });
  }
}

function chatChrome(
  onBack: () => void,
  includeBack: boolean,
  onWorkspace: () => void,
  onMenu: () => void,
  onSwitch: () => void,
  selected: ReturnType<typeof selectedAgent>,
): HTMLElement {
  const chrome = node("header", "chrome");
  if (includeBack) {
    chrome.append(backButton(onBack, t("chrome.backList")));
  }
  const title = node("button", "chrome-title");
  title.type = "button";
  title.addEventListener("click", onSwitch);
  if (selected) {
    title.append(node("span", "chrome-name", chromeName(selected)));
    const meta = node("span", "chrome-meta");
    const line = statusLabel(selected.status);
    meta.append(node("span", `agent-dot agent-${selected.status}`), node("span", "chrome-meta-text", line));
    title.append(meta);
    title.title = [chromeName(selected), line].filter(Boolean).join(" · ");
    title.setAttribute(
      "aria-label",
      line
        ? t("chrome.switchAriaMeta", { title: chromeName(selected), line })
        : t("chrome.switchAria", { title: chromeName(selected) }),
    );
  } else {
    title.append(node("span", "chrome-name", t("mode.agent")));
  }
  chrome.append(title, chromeActionCluster(onWorkspace, onMenu));
  syncChromeStop(chrome, canInterruptAgent(selected?.status ?? ""), () => {
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
  onWorkspace: () => void,
  onMenu: () => void,
  onSwitch: () => void,
): HTMLTextAreaElement {
  const selected = selectedAgent();
  const working = selected?.status === "working";
  const items = visibleItems();
  const stream = paintItems(items, working, null);
  const { dock, input } = chatCompose(canSend(selected));
  stream.dataset.sig = streamSig(items, working);
  container.dataset.back = includeBack ? "1" : "0";
  const wrap = node("div", "agent-stream-wrap");
  const jump = node("button", "agent-jump", t("chat.newReply"));
  jump.type = "button";
  jump.hidden = state.agentTraceFollow || !state.agentTraceUnread;
  jump.addEventListener("click", jumpToLatest);
  wrap.append(stream, jump);
  container.append(chatChrome(onBack, includeBack, onWorkspace, onMenu, onSwitch, selected), wrap, dock);
  paintChatNotice(container);
  sizeChatCompose(input);
  if (!state.agentTraceBusy && state.agentTraceLoadState === "cold") void refreshAgentTrace();
  if (state.agentTraceFollow) requestAnimationFrame(stickAgentStream);
  return input;
}

export function renderAgentChat(onBack: () => void, onWorkspace: () => void, onMenu: () => void, onSwitch: () => void): void {
  const root = node("div", "pane-root agent-chat-root");
  fillAgentChat(root, onBack, true, onWorkspace, onMenu, onSwitch);
  app.replaceChildren(root);
}
