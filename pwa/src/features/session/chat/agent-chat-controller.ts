import { createPromptProgress } from "./prompt-progress";
import { capabilityEnabled, operationBusy } from "../../operations/capabilities-store";
import {
  applyTrace,
  applyTracePage as adoptTracePage,
  chatSnapshot,
  clearPendingTurn,
  currentTraceOwnerVersion,
  followTrace,
  retireAgentTraceReads,
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
import { currentDaemonId, liveSession } from "../../computers/catalog-store";
import { phase } from "../../connection/connection-store";
import { batch } from "../../../app/domain-publication";
import { isAgentChat, isFullTerminal, openPaneId, setAgentChat, setFullTerminal } from "../session-store";
import { liveAgents, markPaneSubmitted, selectedAgent } from "../../dashboard/catalog-store";
import { setPaneTermMode } from "../../settings/preferences-store";
import { commitView } from "../../../app/host";
import { appRoot } from "../../../app/dom-root";
import { haptic } from "../../../lib/dom";
import { canPromptAgent } from "../../../lib/dashboard";
import { t } from "../../../lib/i18n";
import { firstTurnNeedsUser, isTurnHead, mergeAgentTraceSegments, submittedText } from "../../../lib/agent-trace-view";
import {
  agentTraceDetailRevision,
  cacheAgentTrace,
  cachedAgentTrace,
  cacheAgentTracePosture,
  cacheAgentTraceViewport,
  forgetAgentTraceViewport,
  type AgentTraceViewport,
} from "../../../lib/agent-trace-cache";
import { isTraceMarker, type AgentTraceItem, type AgentTracePage } from "../../../lib/operations";
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
import { captureTraceViewport, restoreTraceViewport } from "./viewport";

function fingerprint(items: readonly AgentTraceItem[]): string {
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

/** Cache/read owner: daemon + runtime session + pane + terminal agent occupant. */
export function currentAgentTraceOwnerKey(): string {
  const session = liveSession();
  const paneId = openPaneId();
  if (!session || !paneId) return "";
  const agent = liveAgents().find((item) => item.paneId === paneId);
  return JSON.stringify([
    currentDaemonId(),
    agent?.runtimeSession || "",
    paneId,
    agent?.terminalId || "",
    agent?.agentInstanceId || "",
  ]);
}

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
  const current = chatSnapshot();
  // A terminal page is the complete authoritative history. In particular, a
  // branch/reset must not retain an older prefix loaded for the prior history.
  if (page.nextCursor === null) {
    const changed = fingerprint(current.agentTraceItems) !== sig || current.agentTraceNext !== null;
    applyTrace({
      agentTraceItems: [...page.items],
      agentTraceTail: page.items.length,
      agentTraceSig: sig,
      agentTraceNext: null,
    });
    absorbPending(page.items);
    return changed;
  }
  if (sig === current.agentTraceSig) {
    const changed = current.agentTraceItems.length === current.agentTraceTail && current.agentTraceNext !== page.nextCursor;
    if (current.agentTraceItems.length === current.agentTraceTail) applyTrace({ agentTraceNext: page.nextCursor });
    absorbPending(page.items);
    return changed;
  }
  const kept = Math.max(0, current.agentTraceItems.length - current.agentTraceTail);
  const priorTail = current.agentTraceItems.slice(kept);
  const prefix = kept > 0 && traceSegmentsOverlap(priorTail, page.items)
    ? current.agentTraceItems.slice(0, kept)
    : [];
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

function rememberTrace(paneId: string, ownerKey = currentAgentTraceOwnerKey(), viewport?: AgentTraceViewport): void {
  cacheAgentTrace(paneId, {
    items: [...chatSnapshot().agentTraceItems],
    nextCursor: chatSnapshot().agentTraceNext,
    note: chatSnapshot().agentTraceNote,
    truncated: chatSnapshot().agentTraceTruncated,
    signature: chatSnapshot().agentTraceSig,
    tail: chatSnapshot().agentTraceTail,
    ownerKey,
    viewport,
  });
}

export function rememberAgentViewport(stream: HTMLElement, paneId = openPaneId(), ownerKey = currentAgentTraceOwnerKey()): void {
  if (!paneId || !ownerKey) return;
  const snapshot = chatSnapshot();
  cacheAgentTraceViewport(paneId, ownerKey, captureTraceViewport(stream, snapshot.agentTraceFollow, snapshot.agentTraceUnread));
}

/**
 * A stream being unmounted may already have lost its layout (its page is
 * leaving), so only the posture is saved; scrolling keeps the place current.
 */
export function rememberAgentPosture(paneId: string, ownerKey: string, posture: { follow: boolean; unread: boolean }): void {
  if (paneId && ownerKey) cacheAgentTracePosture(paneId, ownerKey, posture);
}

export function restoreAgentViewport(stream: HTMLElement, paneId = openPaneId(), ownerKey = currentAgentTraceOwnerKey()): boolean {
  if (!paneId || !ownerKey) return false;
  const viewport = cachedAgentTrace(paneId, ownerKey)?.viewport;
  return viewport ? restoreTraceViewport(stream, viewport) : false;
}

export function restoreAgentReadingPosition(): void {
  const stream = streamEl();
  if (stream && !restoreAgentViewport(stream)) stickAgentStream();
}

/**
 * Opening a pane paints its last transcript at once. The reading place does not
 * outlive the visit: every entry starts at the latest turn.
 */
export function restoreAgentTrace(paneId: string): boolean {
  const entry = cachedAgentTrace(paneId, currentAgentTraceOwnerKey());
  if (!entry) return false;
  forgetAgentTraceViewport(paneId);
  adoptTracePage(entry);
  followTrace();
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
      cantSend: selectedAgent()?.launchPending ? t("chat.startingHint") : t("chat.cantSend"),
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
  const pending = submittedText(chatSnapshot().agentTracePending);
  if (!pending) return;
  const boundary = pendingBoundary(items);
  if (items.slice(boundary).some((item) => isTurnHead(item) && submittedText(item.text || "") === pending)) {
    const progress = chatSnapshot().promptProgress;
    if (progress) applyTrace({ promptProgress: { ...progress, phase: "recorded" } });
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

function traceSegmentsOverlap(before: readonly AgentTraceItem[], after: readonly AgentTraceItem[]): boolean {
  for (let left = 0; left < before.length; left += 1) {
    for (let right = 0; right < after.length; right += 1) {
      let count = 0;
      let agentEvent = false;
      let marker = false;
      while (
        left + count < before.length && right + count < after.length &&
        sameTracePosition(before[left + count], after[right + count])
      ) {
        const item = before[left + count];
        agentEvent ||= !isTurnHead(item) && !isTraceMarker(item.type);
        marker ||= isTraceMarker(item.type);
        count += 1;
      }
      // Repeated prompts and textless markers ("/compact" then a compaction)
      // recur after a branch/reset. A matching agent event, or two adjacent
      // prompts, prove continuity strongly enough to keep the loaded prefix.
      if (agentEvent || (count >= 2 && !marker)) return true;
    }
  }
  return false;
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
    { type: "user", text: pending, pending: true },
    ...chatSnapshot().agentTraceItems.slice(boundary),
  ];
}

/**
 * Agents every daemon reads (internal/journal), so their chat opens even before a new session has written
 * a transcript. Cursor, Hermes and opencode are read only by daemons that know them and open on
 * historyAvailable alone.
 */
const CHAT_AGENT_KINDS = new Set(["claude", "codex", "grok", "pi"]);

export function canEnterAgentChat(
  agent: { historyAvailable?: boolean; hasAgent?: boolean; agent?: string } | null | undefined = selectedAgent(),
): boolean {
  return Boolean(agent && capabilityEnabled("history")
    && (agent.historyAvailable || (agent.hasAgent && CHAT_AGENT_KINDS.has(agent.agent ?? ""))));
}

export function canSend(agent = selectedAgent()): boolean {
  return Boolean(agent && canPromptAgent(agent) && capabilityEnabled("prompt_agent"));
}

function ownerIsCurrent(session: NonNullable<ReturnType<typeof liveSession>>, paneId: string): boolean {
  return liveSession() === session && openPaneId() === paneId && isAgentChat();
}

function retiredTrace(
  request: number,
  ownerVersion: number,
  session: NonNullable<ReturnType<typeof liveSession>>,
  paneId: string,
): boolean {
  return request !== traceRequest || ownerVersion !== currentTraceOwnerVersion() || !ownerIsCurrent(session, paneId);
}

type TraceRefreshLane = {
  session: NonNullable<ReturnType<typeof liveSession>>;
  paneId: string;
  ownerKey: string;
  ownerVersion: number;
  trailing: boolean;
  promise: Promise<boolean>;
};

let traceLane: TraceRefreshLane | null = null;

function laneIsCurrent(lane: TraceRefreshLane): boolean {
  return lane.session === liveSession() && lane.paneId === openPaneId() && lane.ownerKey === currentAgentTraceOwnerKey()
    && lane.ownerVersion === currentTraceOwnerVersion() && isAgentChat();
}

/** Preserve cached content but prevent a hidden/disconnected read from publishing after recovery. */
export function retireAgentTraceRefreshes(): void {
  traceRequest += 1;
  retireAgentTraceReads();
  if (traceLane) traceLane.trailing = false;
}

/**
 * Tail invalidations share one owner lane. Bursts during a read collapse to one
 * trailing read; a replacement owner gets a fresh lane and never inherits it.
 * Older-page requests remain explicit and are never replayed automatically.
 */
export async function refreshAgentTrace(older = false): Promise<boolean> {
  const session = liveSession();
  const paneId = openPaneId();
  const ownerKey = currentAgentTraceOwnerKey();
  if (!session || !paneId || !ownerKey || !isAgentChat() || !session.isConnected()) return Promise.resolve(false);
  const current = traceLane;
  if (current && current.session === session && current.paneId === paneId && current.ownerKey === ownerKey
    && current.ownerVersion === currentTraceOwnerVersion()) {
    if (!older) current.trailing = true;
    return older ? Promise.resolve(false) : current.promise;
  }
  const lane: TraceRefreshLane = {
    session,
    paneId,
    ownerKey,
    ownerVersion: currentTraceOwnerVersion(),
    trailing: false,
    promise: Promise.resolve(false),
  };
  let resolve!: (changed: boolean) => void;
  lane.promise = new Promise<boolean>((done) => { resolve = done; });
  traceLane = lane;
  void (async () => {
    let changed = false;
    try {
      changed = await performAgentTraceRefresh(older);
      if (lane.trailing && laneIsCurrent(lane)) {
        lane.trailing = false;
        changed = (await performAgentTraceRefresh(false)) || changed;
      }
    } catch {
      // Expected RPC failures are handled by the reader; a UI callback must not
      // strand every coalesced caller if an unexpected publication throws.
    } finally {
      resolve(changed);
      if (traceLane === lane) traceLane = null;
    }
  })();
  return lane.promise;
}

async function performAgentTraceRefresh(older = false): Promise<boolean> {
  const session = liveSession();
  const paneId = openPaneId();
  if (!session || !paneId || !isAgentChat() || !session.isConnected()) return false;
  if (chatSnapshot().agentTraceBusy) return false;
  if (older && !chatSnapshot().agentTraceNext) return false;
  const request = ++traceRequest;
  const ownerVersion = currentTraceOwnerVersion();
  const measureColdLoad = !older && chatSnapshot().agentTraceLoadState === "cold" && !chatSnapshot().agentTraceItems.length;
  const startedAt = Date.now();
  let measured = false;
  batch(() => {
    setTraceBusy(true);
    if (!older && !chatSnapshot().agentTraceItems.length && !chatSnapshot().agentTracePending) setTraceLoadState("loading");
    if (!older) applyTrace({ agentTraceNote: "", agentTraceTruncated: false });
  });
  if (retiredTrace(request, ownerVersion, session, paneId)) return false;
  syncOlderButton();
  if (retiredTrace(request, ownerVersion, session, paneId)) return false;
  let changed = false;
  try {
    let cursor: string | null = older ? chatSnapshot().agentTraceNext : null;
    let pulls = 0;
    const filling = !older;
    while (pulls < (filling ? OLDER_FILL_MAX : 1)) {
      const page = await session.agentTrace(paneId, cursor, TRACE_PAGE);
      if (retiredTrace(request, ownerVersion, session, paneId)) return false;
      if (measureColdLoad && !measured) {
        track("pwa_agent_trace", {
          result: page.items.length ? "content" : "empty",
          extra: traceLatencyBucket(Date.now() - startedAt),
        });
        measured = true;
      }
      const beforeStream = streamEl();
      const beforeSnapshot = chatSnapshot();
      // Read the posture at publication time: the reader may have scrolled up
      // while this RPC was in flight.
      const pageFollow = !older && (!beforeStream || atBottom(beforeStream));
      const viewport = beforeStream
        ? captureTraceViewport(beforeStream, pageFollow, beforeSnapshot.agentTraceUnread, cursor === null ? "start" : "end")
        : undefined;
      let applied = false;
      batch(() => {
        applied = applyTracePage(page, cursor !== null);
        applyTrace({
          agentTraceLoadState: "ready",
          ...(page.truncated ? { agentTraceTruncated: true } : {}),
        });
      });
      if (retiredTrace(request, ownerVersion, session, paneId)) return false;
      changed = applied || changed;
      pulls += 1;
      rememberTrace(paneId);
      if (applied || pulls === 1) {
        const current = streamEl();
        if (!patchAgentChat({
          follow: pageFollow,
          older: cursor !== null,
          top: current?.scrollTop ?? 0,
          height: current?.scrollHeight ?? 0,
          viewport,
        })) commitView();
        if (retiredTrace(request, ownerVersion, session, paneId)) return false;
      }
      if (cursor !== null && !applied) break;
      if (!filling || !firstTurnNeedsUser(chatSnapshot().agentTraceItems, chatSnapshot().agentTraceNext) || !chatSnapshot().agentTraceNext) break;
      cursor = chatSnapshot().agentTraceNext;
    }
    setTraceLoadState("ready");
    if (retiredTrace(request, ownerVersion, session, paneId)) return false;
    rememberTrace(paneId);
    syncOlderButton();
    if (retiredTrace(request, ownerVersion, session, paneId)) return false;
    return changed;
  } catch (error) {
    if (retiredTrace(request, ownerVersion, session, paneId)) return false;
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
      if (retiredTrace(request, ownerVersion, session, paneId)) return false;
      if (!patchAgentChat({ follow: true })) commitView();
      return false;
    }
    applyTrace({ agentTraceLoadState: "error", agentTraceNote: messageOf(error, "read") });
    if (retiredTrace(request, ownerVersion, session, paneId)) return false;
    const currentStream = streamEl();
    const errorFollow = !older && (!currentStream || atBottom(currentStream));
    if (!patchAgentChat({ follow: errorFollow })) commitView();
    return false;
  } finally {
    if (!retiredTrace(request, ownerVersion, session, paneId)) {
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
      forgetAgentTraceViewport(openPaneId());
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
    retireAgentTraceRefreshes();
    batch(() => {
      setAgentChat(false);
      setTraceBusy(false);
      clearPendingTurn();
    });
  });
  if (opts?.paint !== false) commitView();
}

export async function copyAgentReply(text: string, what: "reply" | "code" = "reply"): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    haptic(6);
    showStatus(t(what === "code" ? "chat.copiedCode" : "chat.copiedReply"));
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

export function patchAgentChat(opts?: {
  follow?: boolean;
  older?: boolean;
  top?: number;
  height?: number;
  viewport?: AgentTraceViewport;
}): boolean {
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
  const viewport = opts?.viewport ?? captureTraceViewport(
    stream,
    follow,
    chatSnapshot().agentTraceUnread,
  );
  batch(() => {
    if (follow) followTrace();
    else if (!opts?.older && !unchanged) setTraceUnread(true);
  });
  publishAgentChatUI();
  // followTrace notifies now; a subscriber may leave or remount another stream.
  if (!ownerIsCurrent(session, paneId) || currentViewIncarnation() !== incarnation) return true;
  const painted = streamEl();
  if (!painted || painted !== stream) return true;
  if (follow) painted.scrollTop = painted.scrollHeight;
  else if (!unchanged || opts?.older) {
    const restored = restoreTraceViewport(painted, viewport);
    if (!restored && opts?.older) painted.scrollTop = painted.scrollHeight - previousHeight + previousTop;
    else if (!restored) painted.scrollTop = viewport.scrollTop;
  }
  rememberAgentViewport(painted, paneId, currentAgentTraceOwnerKey());
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

type PromptOccupant = Pick<NonNullable<ReturnType<typeof selectedAgent>>, "runtimeSession" | "terminalId" | "agentInstanceId">;

function promptOccupant(agent: PromptOccupant): PromptOccupant {
  return { runtimeSession: agent.runtimeSession, terminalId: agent.terminalId, agentInstanceId: agent.agentInstanceId };
}

function promptOccupantIsCurrent(paneId: string, captured: PromptOccupant): boolean {
  const current = liveAgents().find((agent) => agent.paneId === paneId);
  if (!current) return false;
  const now = promptOccupant(current);
  const capturedRich = Boolean(captured.runtimeSession || captured.terminalId || captured.agentInstanceId);
  const currentRich = Boolean(now.runtimeSession || now.terminalId || now.agentInstanceId);
  if (!capturedRich && !currentRich) return true;
  return captured.runtimeSession === now.runtimeSession &&
    captured.terminalId === now.terminalId &&
    captured.agentInstanceId === now.agentInstanceId;
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
  const occupant = promptOccupant(selected);
  const progress = createPromptProgress(selected);
  const notice = visibleNotice();
  batch(() => {
    setComposeDraft("");
    setPendingTurn(text, chatSnapshot().agentTraceItems);
    applyTrace({ promptProgress: progress });
    followTrace();
  });
  restoreOwnerComposeField();
  paintPromptOwner();
  try {
    await session.promptAgent({ pane_id: owner.draftScope.paneId, text: owner.text });
    if (promptRequestOwnsComputer(owner) && !promptOccupantIsCurrent(owner.draftScope.paneId, occupant)) return;
    if (promptRequestOwnsComputer(owner)) markPaneSubmitted(owner.draftScope.paneId);
    settlePromptSuccess(owner);
    if (promptRequestIsLive(owner)) {
      if (visibleNotice() === notice) clearNoticeForScope(owner.noticeScope);
      if (chatSnapshot().promptProgress?.startedAt === progress.startedAt && chatSnapshot().promptProgress?.phase === "sending")
        applyTrace({ promptProgress: { ...progress, phase: "submitted" } });
      haptic(8);
      paintPromptOwner();
      await refreshAgentTrace();
    }
  } catch (error) {
    if (promptRequestOwnsComputer(owner) && !promptOccupantIsCurrent(owner.draftScope.paneId, occupant)) return;
    const { unknownOutcome, message, restoredVisible } = settlePromptFailure(owner, error);
    if (promptRequestIsLive(owner)) {
      batch(() => {
        clearPendingTurn();
        applyTrace({ agentTraceNote: message, promptProgress: unknownOutcome ? { ...progress, phase: "unknown" } : null });
      });
      if (restoredVisible) restoreOwnerComposeField();
      showError(message, owner.noticeScope, true);
      paintPromptOwner();
      if (unknownOutcome) {
        await reconcileAmbiguousMutation(session, error, undefined, () => promptRequestIsLive(owner) && !composeIME());
        if (promptRequestIsLive(owner)) await refreshAgentTrace();
      }
    } else if (unknownOutcome) {
      // The mutation owner is stale, but its read-only reconciliation still
      // updates the current computer (and can remove a pane that disappeared).
      await reconcileAmbiguousMutation(session, error);
    } else if (restoredVisible) {
      restoreOwnerComposeField();
    }
  } finally {
    releasePromptOwner(owner, promptOccupantIsCurrent(owner.draftScope.paneId, occupant) && promptRequestIsLive(owner));
  }
}
