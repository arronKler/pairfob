import { canPromptAgent } from "../lib/dashboard";
import { t } from "../lib/i18n";
import { firstTurnNeedsUser, mergeAgentTraceSegments } from "../lib/agent-trace-view";
import { agentTraceDetailRevision, cacheAgentTrace, cachedAgentTrace } from "../lib/agent-trace-cache";
import type { AgentTraceItem, AgentTracePage } from "../lib/operations";
import { ProtocolError } from "../lib/protocol/errors";
import { messageOf } from "../lib/notices";
import { track } from "../lib/telemetry";
import { render } from "../paint";
import { reconcileAmbiguousMutation } from "../mutations";
import {
  capturePromptRequest,
  promptRequestIsLive,
  promptRequestOwnsComputer,
  releasePromptLock,
  settlePromptFailure,
  settlePromptSuccess,
  switchComposeView,
} from "../compose-drafts";
import {
  COMPOSE_MAX_PX,
  COMPOSE_MIN_PX,
  app,
  clearNoticeForScope,
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
import { leaveFullTerminal } from "./full-terminal";
import type { AgentEmptySpec } from "./agent-chat-stream";
import { publishAgentChatUI } from "./agent-chat-ui";

function fingerprint(items: AgentTraceItem[]): string {
  return JSON.stringify(items);
}

export function streamEl(): HTMLElement | null {
  return app.querySelector(".agent-stream");
}

export function composeEl(): HTMLTextAreaElement | null {
  const field = app.querySelector(".agent-dock textarea");
  return field instanceof HTMLTextAreaElement ? field : null;
}

function atBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 32;
}

const TRACE_PAGE = 200;
const OLDER_FILL_MAX = 4;
let traceRequest = 0;

export function streamSig(items: AgentTraceItem[], working: boolean): string {
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

export function emptySpec(working: boolean): AgentEmptySpec {
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

function syncOlderButton(): void { publishAgentChatUI(); }

export function stickAgentStream(): void {
  const stream = streamEl();
  if (stream && state.agentTraceFollow) stream.scrollTop = stream.scrollHeight;
}

function syncAgentJump(): void { publishAgentChatUI(); }

export function jumpToLatest(): void {
  haptic(6);
  state.agentTraceFollow = true;
  state.agentTraceUnread = false;
  stickAgentStream();
  syncAgentJump();
}

export function sizeChatCompose(field: HTMLTextAreaElement): void {
  field.style.height = "auto";
  field.style.height = `${Math.min(Math.max(field.scrollHeight, COMPOSE_MIN_PX), COMPOSE_MAX_PX)}px`;
  stickAgentStream();
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

export function visibleItems(): AgentTraceItem[] {
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

export function canSend(agent = selectedAgent()): boolean {
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
      syncOlderButton();
    }
  }
}

export function enterAgentChat(): void {
  if (!state.live || !state.paneId || state.agentChat) return;
  const start = () => {
    haptic(8);
    switchComposeView(() => {
      setPaneTermMode(state.paneId, "agent");
      state.fullTerminal = false;
      state.agentChat = true;
      state.agentTraceFollow = true;
      state.agentTraceUnread = false;
    });
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
  switchComposeView(() => {
    if (opts?.rememberGuided !== false) setPaneTermMode(state.paneId, "guided");
    state.agentChat = false;
    traceRequest++;
    state.agentTraceBusy = false;
    state.agentTracePending = "";
    state.agentTracePendingBase = [];
  });
  if (opts?.paint !== false) render();
}

export async function copyAgentReply(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    haptic(6);
    showStatus(t("chat.copiedReply"));
  } catch {
    showError(t("err.copyDenied"));
  }
  publishAgentChatUI();
}

function syncChatCompose(): void { publishAgentChatUI(); }

export function chatDockNotice(): Notice | null {
  const fromApp = visibleNotice();
  if (fromApp) return fromApp;
  if (!(state.agentTraceItems.length || state.agentTracePending) || !state.agentTraceNote) return null;
  return { text: state.agentTraceNote, tone: state.agentTraceLoadState === "error" ? "error" : "status" };
}

function syncChatDock(): void { publishAgentChatUI(); }

export function patchAgentChat(opts?: { follow?: boolean; older?: boolean; top?: number; height?: number }): boolean {
  const root = app.querySelector("[data-react-agent-chat]");
  const stream = streamEl();
  if (!root || !stream || !state.agentChat) return false;
  const working = selectedAgent()?.status === "working";
  const sig = streamSig(visibleItems(), working);
  const unchanged = !opts?.older && stream.dataset.sig === sig;
  const follow = opts?.follow ?? (state.agentTraceFollow && atBottom(stream));
  const previousTop = opts?.top ?? stream.scrollTop;
  const previousHeight = opts?.height ?? stream.scrollHeight;
  if (follow) {
    state.agentTraceFollow = true;
    state.agentTraceUnread = false;
  } else if (!opts?.older && !unchanged) state.agentTraceUnread = true;
  publishAgentChatUI();
  const painted = streamEl();
  if (!painted) return true;
  if (opts?.older) painted.scrollTop = painted.scrollHeight - previousHeight + previousTop;
  else if (follow) painted.scrollTop = painted.scrollHeight;
  else if (!unchanged) painted.scrollTop = previousTop;
  return true;
}

function paintPromptOwner(): void {
  if (!patchAgentChat({ follow: true })) render();
}

function restoreOwnerComposeField(): void {
  if (state.composeIME) return;
  const restore = composeEl();
  if (!restore) return;
  restore.value = state.composeDraft;
  sizeChatCompose(restore);
}

function releasePromptOwner(owner: { lockId: number }, live: boolean): void {
  const released = releasePromptLock(owner.lockId);
  if (!released || !live) return;
  app.setAttribute("aria-busy", state.operationBusy ? "true" : "false");
  syncChatDock();
  stickAgentStream();
  if (!state.composeFocused) composeEl()?.focus({ preventScroll: true });
}

export async function submitAgentPrompt(): Promise<void> {
  const session = state.live;
  const selected = selectedAgent();
  const text = state.composeDraft.trim();
  if (!session || !selected || !text || !canSend(selected) || state.operationBusy) return;
  const owner = capturePromptRequest(session, selected.paneId, text);
  if (!owner) return;
  const notice = state.notice;
  state.composeDraft = "";
  state.agentTracePendingBase = state.agentTraceItems.map((item) => ({ ...item }));
  state.agentTracePending = text;
  state.agentTraceFollow = true;
  restoreOwnerComposeField();
  paintPromptOwner();
  try {
    await session.promptAgent({ pane_id: owner.draftScope.paneId, text: owner.text });
    if (promptRequestOwnsComputer(owner)) markPaneSubmitted(owner.draftScope.paneId);
    settlePromptSuccess(owner);
    if (promptRequestIsLive(owner)) {
      if (state.notice === notice) clearNoticeForScope(owner.noticeScope);
      haptic(8);
      paintPromptOwner();
      await refreshAgentTrace();
    }
  } catch (error) {
    const { unknownOutcome, message, restoredVisible } = settlePromptFailure(owner, error);
    if (promptRequestIsLive(owner)) {
      state.agentTracePending = "";
      state.agentTracePendingBase = [];
      state.agentTraceNote = message;
      if (restoredVisible) restoreOwnerComposeField();
      showError(message, owner.noticeScope, true);
      paintPromptOwner();
      if (unknownOutcome) {
        await reconcileAmbiguousMutation(session, error, undefined, () => promptRequestIsLive(owner) && !state.composeIME);
        if (promptRequestIsLive(owner)) await refreshAgentTrace();
      }
    } else if (unknownOutcome) {
      await reconcileAmbiguousMutation(session, error, undefined, () => promptRequestIsLive(owner) && !state.composeIME);
    } else if (restoredVisible) {
      restoreOwnerComposeField();
    }
  } finally {
    releasePromptOwner(owner, promptRequestIsLive(owner));
  }
}
