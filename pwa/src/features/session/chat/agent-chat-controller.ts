import { capabilityEnabled, operationBusy } from "../../operations/capabilities-store";
import {
  applyTrace,
  applyTracePage as adoptTracePage,
  chatSnapshot,
  clearPendingTurn,
  followTrace,
  setPendingTurn,
  setTraceBusy,
  setTraceLoadState,
  setTraceUnread,
  type ChatRecord,
} from "./trace-store";
import {
  COMPOSE_MAX_PX, COMPOSE_MIN_PX, composeDraft, composeFocused, composeIME, setComposeDraft,
} from "../compose-store";
import { clearNoticeForScope, showError, showStatus, visibleNotice, type Notice } from "../../../app/notices-store";
import { liveSession } from "../../computers/catalog-store";
import { phase } from "../../connection/connection-store";
import { batch } from "../../../app/domain-publication";
import { isAgentChat, isFullTerminal, openPaneId, setAgentChat, setFullTerminal } from "../session-store";
import { markPaneSubmitted, selectedAgent } from "../../dashboard/catalog-store";
import { setPaneTermMode } from "../../settings/preferences-store";
import { commitView } from "../../../app/host";
import { appRoot } from "../../../app/dom-root";
import { haptic } from "../../../lib/dom";
import { canPromptAgent } from "../../../lib/dashboard";
import { t } from "../../../lib/i18n";
import { firstTurnNeedsUser, mergeAgentTraceSegments } from "../../../lib/agent-trace-view";
import { agentTraceDetailRevision, cacheAgentTrace, cachedAgentTrace } from "../../../lib/agent-trace-cache";
import type { AgentTraceItem, AgentTracePage } from "../../../lib/operations";
import { ProtocolError } from "../../../lib/protocol/errors";
import { messageOf } from "../../../lib/notices";
import { track } from "../../../lib/telemetry";
import { reconcileAmbiguousMutation } from "../../connection/mutations";
import {
  capturePromptRequest,
  currentViewIncarnation,
  promptRequestIsLive,
  promptRequestOwnsComputer,
  releasePromptLock,
  settlePromptFailure,
  settlePromptSuccess,
  switchComposeView,
} from "../drafts/compose-drafts";
import { leaveFullTerminal } from "../full-terminal/full-terminal";
import { agentEmptySpec, agentStreamSignature, type AgentEmptySpec } from "./model";
import { publishAgentChatUI } from "./agent-chat-ui";

function fingerprint(items: AgentTraceItem[]): string {
  return JSON.stringify(items);
}

export function streamEl(): HTMLElement | null {
  return appRoot().querySelector(".agent-stream");
}

export function composeEl(): HTMLTextAreaElement | null {
  const field = appRoot().querySelector(".agent-dock textarea");
  return field instanceof HTMLTextAreaElement ? field : null;
}

function atBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 32;
}

const TRACE_PAGE = 200;
const OLDER_FILL_MAX = 4;
let traceRequest = 0;

export function streamSig(items: AgentTraceItem[], working: boolean): string {
  return agentStreamSignature(
    items,
    working,
    chatSnapshot().agentTraceLoadState,
    chatSnapshot().agentTraceTruncated,
    agentTraceDetailRevision(),
  );
}

function applyTracePage(page: AgentTracePage, older: boolean): boolean {
  if (older) {
    if (!page.items.length) {
      const changed = chatSnapshot().agentTraceNext !== page.nextCursor;
      if (changed) applyTrace({ agentTraceNext: page.nextCursor });
      return changed;
    }
    const tailWasWholeView = chatSnapshot().agentTraceItems.length === chatSnapshot().agentTraceTail;
    const merged = mergeAgentTraceSegments(page.items, chatSnapshot().agentTraceItems);
    const patch: Partial<ChatRecord> = {
      agentTraceItems: merged.items,
      agentTraceNext: page.nextCursor,
    };
    if (tailWasWholeView) patch.agentTraceTail = Math.max(0, chatSnapshot().agentTraceTail - merged.overlap);
    applyTrace(patch);
    absorbPending(chatSnapshot().agentTraceItems);
    return true;
  }
  const sig = fingerprint(page.items);
  if (sig === chatSnapshot().agentTraceSig) {
    const changed = chatSnapshot().agentTraceItems.length === chatSnapshot().agentTraceTail && chatSnapshot().agentTraceNext !== page.nextCursor;
    if (chatSnapshot().agentTraceItems.length === chatSnapshot().agentTraceTail) applyTrace({ agentTraceNext: page.nextCursor });
    absorbPending(page.items);
    return changed;
  }
  const kept = Math.max(0, chatSnapshot().agentTraceItems.length - chatSnapshot().agentTraceTail);
  const prefix = kept > 0 ? chatSnapshot().agentTraceItems.slice(0, kept) : [];
  const merged = mergeAgentTraceSegments(prefix, page.items);
  const patch: Partial<ChatRecord> = {
    agentTraceItems: merged.items,
    agentTraceTail: page.items.length - merged.overlap,
    agentTraceSig: sig,
  };
  if (prefix.length === 0) patch.agentTraceNext = page.nextCursor;
  applyTrace(patch);
  absorbPending(chatSnapshot().agentTraceItems);
  return true;
}

function rememberTrace(paneId: string): void {
  cacheAgentTrace(paneId, {
    items: [...chatSnapshot().agentTraceItems],
    nextCursor: chatSnapshot().agentTraceNext,
    note: chatSnapshot().agentTraceNote,
    truncated: chatSnapshot().agentTraceTruncated,
    signature: chatSnapshot().agentTraceSig,
    tail: chatSnapshot().agentTraceTail,
  });
}

export function restoreAgentTrace(paneId: string): boolean {
  const entry = cachedAgentTrace(paneId);
  if (!entry) return false;
  adoptTracePage(entry);
  return true;
}

const traceUnavailableNote = () => t("chat.noTrace");

export function emptySpec(working: boolean): AgentEmptySpec {
  return agentEmptySpec({
    working,
    loadState: chatSnapshot().agentTraceLoadState,
    note: chatSnapshot().agentTraceNote,
    unavailableNote: traceUnavailableNote(),
    canSend: canSend(),
    copy: {
      running: t("trace.running"),
      reading: t("chat.readingProcess"),
      noChat: t("chat.noChat"),
      terminalHint: t("chat.terminalHint"),
      sendBelow: t("chat.sendBelow"),
      cantSend: t("chat.cantSend"),
    },
  });
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
  if (stream && chatSnapshot().agentTraceFollow) stream.scrollTop = stream.scrollHeight;
}

function syncAgentJump(): void { publishAgentChatUI(); }

export function jumpToLatest(): void {
  haptic(6);
  followTrace();
  stickAgentStream();
  syncAgentJump();
}

export function sizeChatCompose(field: HTMLTextAreaElement): void {
  field.style.height = "auto";
  field.style.height = `${Math.min(Math.max(field.scrollHeight, COMPOSE_MIN_PX), COMPOSE_MAX_PX)}px`;
  stickAgentStream();
}

function absorbPending(items: readonly AgentTraceItem[]): void {
  const pending = chatSnapshot().agentTracePending.trim();
  if (!pending) return;
  const boundary = pendingBoundary(items);
  if (items.slice(boundary).some((item) => item.type === "user" && item.text === pending)) {
    clearPendingTurn();
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

function pendingBoundary(items: readonly AgentTraceItem[]): number {
  const baseline = chatSnapshot().agentTracePendingBase;
  let index = 0;
  while (index < baseline.length && index < items.length && sameTracePosition(baseline[index], items[index])) {
    index += 1;
  }
  return index;
}

export function visibleItems(): AgentTraceItem[] {
  const pending = chatSnapshot().agentTracePending.trim();
  if (!pending) return [...chatSnapshot().agentTraceItems];
  const boundary = pendingBoundary(chatSnapshot().agentTraceItems);
  return [
    ...chatSnapshot().agentTraceItems.slice(0, boundary),
    { type: "user", text: pending },
    ...chatSnapshot().agentTraceItems.slice(boundary),
  ];
}

export function canEnterAgentChat(agent: { historyAvailable?: boolean; hasAgent?: boolean } | null | undefined = selectedAgent()): boolean {
  return Boolean(agent && capabilityEnabled("history") && (agent.historyAvailable || agent.hasAgent));
}

export function canSend(agent = selectedAgent()): boolean {
  return Boolean(agent && canPromptAgent(agent) && capabilityEnabled("prompt_agent"));
}

function ownerIsCurrent(session: NonNullable<ReturnType<typeof liveSession>>, paneId: string): boolean {
  return liveSession() === session && openPaneId() === paneId && isAgentChat();
}

function retiredTrace(
  request: number,
  session: NonNullable<ReturnType<typeof liveSession>>,
  paneId: string,
): boolean {
  return request !== traceRequest || !ownerIsCurrent(session, paneId);
}

export async function refreshAgentTrace(older = false): Promise<boolean> {
  const session = liveSession();
  const paneId = openPaneId();
  if (!session || !paneId || !isAgentChat() || !session.isConnected()) return false;
  if (chatSnapshot().agentTraceBusy) return false;
  if (older && !chatSnapshot().agentTraceNext) return false;
  const request = ++traceRequest;
  const measureColdLoad = !older && chatSnapshot().agentTraceLoadState === "cold" && !chatSnapshot().agentTraceItems.length;
  const startedAt = Date.now();
  let measured = false;
  const stream = streamEl();
  const follow = !older && (!stream || atBottom(stream));
  const top = stream?.scrollTop ?? 0;
  const height = stream?.scrollHeight ?? 0;
  batch(() => {
    setTraceBusy(true);
    if (!older && !chatSnapshot().agentTraceItems.length && !chatSnapshot().agentTracePending) setTraceLoadState("loading");
    if (!older) applyTrace({ agentTraceNote: "", agentTraceTruncated: false });
  });
  if (retiredTrace(request, session, paneId)) return false;
  syncOlderButton();
  if (retiredTrace(request, session, paneId)) return false;
  let changed = false;
  try {
    let cursor: string | null = older ? chatSnapshot().agentTraceNext : null;
    let pulls = 0;
    const filling = !older;
    while (pulls < (filling ? OLDER_FILL_MAX : 1)) {
      const page = await session.agentTrace(paneId, cursor, TRACE_PAGE);
      if (retiredTrace(request, session, paneId)) return false;
      if (measureColdLoad && !measured) {
        track("pwa_agent_trace", {
          result: page.items.length ? "content" : "empty",
          extra: traceLatencyBucket(Date.now() - startedAt),
        });
        measured = true;
      }
      let applied = false;
      batch(() => {
        applied = applyTracePage(page, cursor !== null);
        applyTrace({
          agentTraceLoadState: "ready",
          ...(page.truncated ? { agentTraceTruncated: true } : {}),
        });
      });
      if (retiredTrace(request, session, paneId)) return false;
      changed = applied || changed;
      pulls += 1;
      rememberTrace(paneId);
      if (applied || pulls === 1) {
        const current = streamEl();
        const pageTop = cursor === null ? top : current?.scrollTop ?? top;
        const pageHeight = cursor === null ? height : current?.scrollHeight ?? height;
        if (!patchAgentChat({ follow, older: cursor !== null, top: pageTop, height: pageHeight })) commitView();
        if (retiredTrace(request, session, paneId)) return false;
      }
      if (cursor !== null && !applied) break;
      if (!filling || !firstTurnNeedsUser(chatSnapshot().agentTraceItems, chatSnapshot().agentTraceNext) || !chatSnapshot().agentTraceNext) break;
      cursor = chatSnapshot().agentTraceNext;
    }
    setTraceLoadState("ready");
    if (retiredTrace(request, session, paneId)) return false;
    rememberTrace(paneId);
    syncOlderButton();
    if (retiredTrace(request, session, paneId)) return false;
    return changed;
  } catch (error) {
    if (retiredTrace(request, session, paneId)) return false;
    const code = error instanceof ProtocolError ? error.code : "";
    if (measureColdLoad && !measured) {
      track("pwa_agent_trace", { result: code || "failed", extra: traceLatencyBucket(Date.now() - startedAt) });
      measured = true;
    }
    if (code === "transcript_unavailable") {
      applyTrace({
        agentTraceLoadState: "error",
        agentTraceItems: [],
        agentTraceNext: null,
        agentTraceSig: "",
        agentTraceTail: 0,
        agentTraceTruncated: false,
        agentTraceNote: traceUnavailableNote(),
      });
      if (retiredTrace(request, session, paneId)) return false;
      if (!patchAgentChat({ follow: true })) commitView();
      return false;
    }
    applyTrace({ agentTraceLoadState: "error", agentTraceNote: messageOf(error, "read") });
    if (retiredTrace(request, session, paneId)) return false;
    if (!patchAgentChat({ follow })) commitView();
    return false;
  } finally {
    if (!retiredTrace(request, session, paneId)) {
      setTraceBusy(false);
      syncOlderButton();
    }
  }
}

export function enterAgentChat(): void {
  if (!liveSession() || !openPaneId() || isAgentChat()) return;
  const start = () => {
    haptic(8);
    switchComposeView(() => {
      setPaneTermMode(openPaneId(), "agent");
      batch(() => {
        setFullTerminal(false);
        setAgentChat(true);
        followTrace();
      });
    });
    commitView();
    void refreshAgentTrace();
    queueMicrotask(() => composeEl()?.focus({ preventScroll: true }));
  };
  if (isFullTerminal()) {
    void leaveFullTerminal({ rememberGuided: false, paint: false }).then(() => {
      if (phase() !== "live" || !openPaneId()) return;
      start();
    });
    return;
  }
  start();
}

export function leaveAgentChat(opts?: { rememberGuided?: boolean; paint?: boolean }): void {
  if (!isAgentChat()) return;
  switchComposeView(() => {
    if (opts?.rememberGuided !== false) setPaneTermMode(openPaneId(), "guided");
    traceRequest++;
    batch(() => {
      setAgentChat(false);
      setTraceBusy(false);
      clearPendingTurn();
    });
  });
  if (opts?.paint !== false) commitView();
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
  if (chatSnapshot().agentTraceNote === traceUnavailableNote()) return null;
  if (!(chatSnapshot().agentTraceItems.length || chatSnapshot().agentTracePending) || !chatSnapshot().agentTraceNote) return null;
  return { text: chatSnapshot().agentTraceNote, tone: chatSnapshot().agentTraceLoadState === "error" ? "error" : "status" };
}

function syncChatDock(): void { publishAgentChatUI(); }

export function patchAgentChat(opts?: { follow?: boolean; older?: boolean; top?: number; height?: number }): boolean {
  const root = appRoot().querySelector("[data-react-agent-chat]");
  const stream = streamEl();
  const session = liveSession();
  const paneId = openPaneId();
  const incarnation = currentViewIncarnation();
  if (!root || !stream || !session || !paneId || !isAgentChat()) return false;
  const working = selectedAgent()?.status === "working";
  const sig = streamSig(visibleItems(), working);
  const unchanged = !opts?.older && stream.dataset.sig === sig;
  const follow = opts?.follow ?? (chatSnapshot().agentTraceFollow && atBottom(stream));
  const previousTop = opts?.top ?? stream.scrollTop;
  const previousHeight = opts?.height ?? stream.scrollHeight;
  batch(() => {
    if (follow) followTrace();
    else if (!opts?.older && !unchanged) setTraceUnread(true);
  });
  publishAgentChatUI();
  // followTrace notifies now; a subscriber may leave or remount another stream.
  if (!ownerIsCurrent(session, paneId) || currentViewIncarnation() !== incarnation) return true;
  const painted = streamEl();
  if (!painted || painted !== stream) return true;
  if (opts?.older) painted.scrollTop = painted.scrollHeight - previousHeight + previousTop;
  else if (follow) painted.scrollTop = painted.scrollHeight;
  else if (!unchanged) painted.scrollTop = previousTop;
  return true;
}

function paintPromptOwner(): void {
  if (!patchAgentChat({ follow: true })) commitView();
}

function restoreOwnerComposeField(): void {
  if (composeIME()) return;
  const restore = composeEl();
  if (!restore) return;
  restore.value = composeDraft();
  sizeChatCompose(restore);
}

function releasePromptOwner(owner: { lockId: number }, live: boolean): void {
  const released = releasePromptLock(owner.lockId);
  if (!released || !live) return;
  appRoot().setAttribute("aria-busy", operationBusy() ? "true" : "false");
  syncChatDock();
  stickAgentStream();
  if (!composeFocused()) composeEl()?.focus({ preventScroll: true });
}

export async function submitAgentPrompt(): Promise<void> {
  const session = liveSession();
  const selected = selectedAgent();
  const text = composeDraft().trim();
  if (!session || !selected || !text || !canSend(selected) || operationBusy()) return;
  const owner = capturePromptRequest(session, selected.paneId, text);
  if (!owner) return;
  const notice = visibleNotice();
  batch(() => {
    setComposeDraft("");
    setPendingTurn(text, chatSnapshot().agentTraceItems);
    followTrace();
  });
  restoreOwnerComposeField();
  paintPromptOwner();
  try {
    await session.promptAgent({ pane_id: owner.draftScope.paneId, text: owner.text });
    if (promptRequestOwnsComputer(owner)) markPaneSubmitted(owner.draftScope.paneId);
    settlePromptSuccess(owner);
    if (promptRequestIsLive(owner)) {
      if (visibleNotice() === notice) clearNoticeForScope(owner.noticeScope);
      haptic(8);
      paintPromptOwner();
      await refreshAgentTrace();
    }
  } catch (error) {
    const { unknownOutcome, message, restoredVisible } = settlePromptFailure(owner, error);
    if (promptRequestIsLive(owner)) {
      batch(() => {
        clearPendingTurn();
        applyTrace({ agentTraceNote: message });
      });
      if (restoredVisible) restoreOwnerComposeField();
      showError(message, owner.noticeScope, true);
      paintPromptOwner();
      if (unknownOutcome) {
        await reconcileAmbiguousMutation(session, error, undefined, () => promptRequestIsLive(owner) && !composeIME());
        if (promptRequestIsLive(owner)) await refreshAgentTrace();
      }
    } else if (unknownOutcome) {
      await reconcileAmbiguousMutation(session, error, undefined, () => promptRequestIsLive(owner) && !composeIME());
    } else if (restoredVisible) {
      restoreOwnerComposeField();
    }
  } finally {
    releasePromptOwner(owner, promptRequestIsLive(owner));
  }
}
