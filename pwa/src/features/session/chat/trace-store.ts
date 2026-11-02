import type { AgentStatus } from "../../../lib/ranking";
import type { AgentTraceItem } from "../../../lib/operations";
import { forgetAgentTrace } from "../../../lib/agent-trace-cache";
import { createDomain, detach, type Immutable } from "../../../shared/model/domain-store";

/**
 * Chat domain: the structured agent transcript of the open pane — paged items,
 * the optimistic user turn, and the reader's follow/unread posture.
 *
 * The transcript cache and merge rules stay in `lib/agent-trace-cache` /
 * `lib/protocol/agent-trace`; this domain owns what the chat view shows.
 */
export type AgentTraceLoadState = "cold" | "loading" | "ready" | "error";

export type PromptProgressPhase = "sending" | "submitted" | "processing" | "recorded" | "unknown";
export type PromptProgress = {
  owner: string;
  startedAt: number;
  phase: PromptProgressPhase;
  baselineStatus: AgentStatus;
  baselineSeq?: number;
};
/** One earlier session of the pane's chain; never merged with another session or cached. */
export type OlderSegment = {
  /** `session_index` of the segment (1 = the session before the current one). */
  index: number;
  items: AgentTraceItem[];
  next: string | null;
  hasEarlier: boolean;
};
export type ChatRecord = {
  promptProgress: PromptProgress | null;
  agentTraceItems: AgentTraceItem[];
  agentTraceNext: string | null;
  /** The last current-session page said the pane has an earlier session. */
  agentTraceHasEarlier: boolean;
  /** Loaded earlier sessions, nearest first (ascending `index`). */
  agentTraceOlder: OlderSegment[];
  agentTraceBusy: boolean;
  agentTraceNote: string;
  /** Some visible trace payload was clipped to fit the bounded response. */
  agentTraceTruncated: boolean;
  agentTraceSig: string;
  agentTraceLoadState: AgentTraceLoadState;
  agentTraceTail: number;
  /** User bubble shown before the transcript has caught up. */
  agentTracePending: string;
  /** Trace snapshot immediately before the optimistic user turn was submitted. */
  agentTracePendingBase: AgentTraceItem[];
  /** Pin the stream to the newest turn unless the reader scrolls up. */
  agentTraceFollow: boolean;
  /** True when the transcript advanced while the reader was scrolled up. */
  agentTraceUnread: boolean;
};

let traceOwnerVersion = 0;

export function currentTraceOwnerVersion(): number {
  return traceOwnerVersion;
}

/** Retire asynchronous reads without discarding the currently visible transcript. */
export function retireAgentTraceReads(): void {
  traceOwnerVersion += 1;
  setTraceBusy(false);
}

/** Retire cached reads for a replaced pane and active reads for the open pane. */
export function invalidateAgentTraceOwner(paneId: string, active = true): void {
  forgetAgentTrace(paneId);
  if (!active) return;
  traceOwnerVersion += 1;
  resetTrace();
}

const chatDomain = createDomain<ChatRecord>("chat", {
  promptProgress: null,
  agentTraceItems: [],
  agentTraceNext: null,
  agentTraceHasEarlier: false,
  agentTraceOlder: [],
  agentTraceBusy: false,
  agentTraceNote: "",
  agentTraceTruncated: false,
  agentTraceSig: "",
  agentTraceLoadState: "cold",
  agentTraceTail: 0,
  agentTracePending: "",
  agentTracePendingBase: [],
  agentTraceFollow: true,
  agentTraceUnread: false,
});
export const chatStore = chatDomain.store;
const { read, write, stage } = chatDomain.controller;

/**
 * Published transcript: the cached frozen snapshot, not the live record.
 *
 * Later session merge reads this after `applyTrace` in the same batch (items,
 * then tail from the new length). Chat is never composition-staged, so an
 * ordinary write updates this snapshot immediately and `batch` only defers
 * notify. A composition hold on another domain must not stall that read. If
 * chat itself ever stages, merge needs an explicit action-time selector —
 * do not silently keep returning the previous published page.
 */
export function chatSnapshot(): Immutable<ChatRecord> {
  return chatStore.get();
}

/**
 * One transcript update, published once. The chat controller folds several fields
 * per page; publishing per field would render the stream repeatedly.
 *
 * The patch is detached, so a caller that keeps the arrays it passed cannot edit
 * the transcript afterwards, and no callback ever sees the live record.
 * `chatSnapshot()` after this write is the merged page, including inside `batch`.
 */
export function applyTrace(patch: Partial<ChatRecord>): void {
  const owned = detach(patch) as Partial<ChatRecord>;
  write((record) => {
    Object.assign(record, owned);
  });
}

export type TracePageEntry = {
  items: AgentTraceItem[];
  nextCursor: string | null;
  note: string;
  truncated: boolean;
  signature: string;
  tail: number;
};

/**
 * Adopt a cached transcript page as the whole visible view. The page is
 * detached: the transcript cache keeps its own copy and cannot change what is
 * already published here.
 */
export function applyTracePage(entry: TracePageEntry): void {
  write((record) => {
    record.agentTraceItems = detach(entry.items);
    record.agentTraceNext = entry.nextCursor;
    record.agentTraceHasEarlier = false;
    record.agentTraceOlder = [];
    record.agentTraceNote = entry.note;
    record.agentTraceTruncated = entry.truncated;
    record.agentTraceSig = entry.signature;
    record.agentTraceTail = entry.tail;
    record.agentTraceLoadState = "ready";
  });
}

export function setTraceLoadState(loadState: AgentTraceLoadState): void {
  if (read().agentTraceLoadState === loadState) return;
  write((record) => {
    record.agentTraceLoadState = loadState;
  });
}

export function setTraceBusy(busy: boolean): void {
  if (read().agentTraceBusy === busy) return;
  write((record) => {
    record.agentTraceBusy = busy;
  });
}

export function setTraceNote(note: string): void {
  if (read().agentTraceNote === note) return;
  write((record) => {
    record.agentTraceNote = note;
  });
}

/** The reader is pinned to the newest turn, so nothing is unread. */
export function followTrace(): void {
  write((record) => {
    record.agentTraceFollow = true;
    record.agentTraceUnread = false;
  });
}

export function setTraceFollow(follow: boolean): void {
  if (read().agentTraceFollow === follow) return;
  write((record) => {
    record.agentTraceFollow = follow;
  });
}

export function setTraceUnread(unread: boolean): void {
  if (read().agentTraceUnread === unread) return;
  write((record) => {
    record.agentTraceUnread = unread;
  });
}

/** Show the submitted prompt before the transcript catches up. */
export function setPendingTurn(text: string, base: readonly AgentTraceItem[]): void {
  write((record) => {
    record.agentTracePending = text;
    record.agentTracePendingBase = detach([...base]);
  });
}

export function clearPendingTurn(): void {
  if (!read().agentTracePending && !read().agentTracePendingBase.length) return;
  write((record) => {
    record.agentTracePending = "";
    record.agentTracePendingBase = [];
  });
}

function clearTraceRecord(record: ChatRecord): void {
  record.promptProgress = null;
  record.agentTraceItems = [];
  record.agentTraceNext = null;
  record.agentTraceHasEarlier = false;
  record.agentTraceOlder = [];
  record.agentTraceBusy = false;
  record.agentTraceNote = "";
  record.agentTraceTruncated = false;
  record.agentTraceSig = "";
  record.agentTraceLoadState = "cold";
  record.agentTraceTail = 0;
  record.agentTracePending = "";
  record.agentTracePendingBase = [];
  record.agentTraceFollow = true;
  record.agentTraceUnread = false;
}

/** Drop the transcript when the pane or session goes away. */
export function resetTrace(): void {
  write(clearTraceRecord);
}

/** Staged form so a pane-view reset can publish the empty transcript with the new page. */
export function stageResetTrace(): void {
  stage(clearTraceRecord);
}
