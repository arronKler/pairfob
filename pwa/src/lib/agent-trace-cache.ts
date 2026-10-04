import type { AgentTraceDetail, AgentTraceItem } from "./operations";

export type AgentTraceViewport = {
  /** Stable rendered-message content key, never a DOM node. */
  anchor: string;
  /** Duplicate occurrence from the leading and trailing edges. */
  ordinal?: number;
  ordinalFromEnd?: number;
  /** Which edge stays stable for the update being applied. */
  edge?: "start" | "end";
  /** Anchor top relative to the scrollport top. */
  offset: number;
  /** Fallback for old markup or an anchor no longer present. */
  scrollTop: number;
  follow: boolean;
  unread: boolean;
};

export type AgentTraceCacheEntry = {
  items: AgentTraceItem[];
  nextCursor: string | null;
  note: string;
  truncated: boolean;
  signature: string;
  tail: number;
  /** Full daemon/session/pane/occupant identity. Missing only on legacy callers. */
  ownerKey?: string;
  viewport?: AgentTraceViewport;
};

const MAX_CACHED_PANES = 6;
const MAX_DETAILS_PER_PANE = 32;
const entries = new Map<string, AgentTraceCacheEntry>();
const details = new Map<string, Map<string, AgentTraceDetailState>>();
let detailRevision = 0;

export type AgentTraceDetailState = {
  status: "idle" | "loading" | "ready" | "error";
  detail?: AgentTraceDetail;
  message?: string;
};

function copy(entry: AgentTraceCacheEntry): AgentTraceCacheEntry {
  return {
    ...entry,
    items: entry.items.map((item) => ({ ...item })),
    ...(entry.viewport ? { viewport: { ...entry.viewport } } : {}),
  };
}

/** Short-lived screen cache only; daemon changes clear it before another computer can reuse a pane id. */
export function cacheAgentTrace(paneId: string, entry: AgentTraceCacheEntry): void {
  if (!paneId) return;
  const previous = entries.get(paneId);
  const sameOwner = previous && entry.ownerKey === previous.ownerKey;
  const next = entry.viewport || !sameOwner || !previous?.viewport
    ? entry
    : { ...entry, viewport: previous.viewport };
  entries.delete(paneId);
  entries.set(paneId, copy(next));
  while (entries.size > MAX_CACHED_PANES) {
    const oldest = entries.keys().next().value;
    if (typeof oldest !== "string") break;
    entries.delete(oldest);
    if (details.delete(oldest)) detailRevision += 1;
  }
}

export function cachedAgentTrace(paneId: string, ownerKey?: string): AgentTraceCacheEntry | null {
  const entry = entries.get(paneId);
  if (!entry || (ownerKey && entry.ownerKey && entry.ownerKey !== ownerKey)) return null;
  entries.delete(paneId);
  entries.set(paneId, entry);
  return copy(entry);
}

export function cacheAgentTraceViewport(paneId: string, ownerKey: string, viewport: AgentTraceViewport): void {
  const entry = entries.get(paneId);
  if (!entry || (entry.ownerKey && entry.ownerKey !== ownerKey)) return;
  entries.delete(paneId);
  entries.set(paneId, copy({ ...entry, ownerKey, viewport }));
}

/** Update who is reading (follow, unread) without re-measuring a stream that may no longer be laid out. */
export function cacheAgentTracePosture(paneId: string, ownerKey: string, posture: { follow: boolean; unread: boolean }): void {
  const entry = entries.get(paneId);
  if (!entry?.viewport || (entry.ownerKey && entry.ownerKey !== ownerKey)) return;
  entry.viewport = { ...entry.viewport, follow: posture.follow, unread: posture.unread };
}

/** Keep the transcript but not the reading place: the next visit starts at the latest turn. */
export function forgetAgentTraceViewport(paneId: string): void {
  const entry = entries.get(paneId);
  if (entry) delete entry.viewport;
}

export function forgetAgentTrace(paneId: string): void {
  entries.delete(paneId);
  if (details.delete(paneId)) detailRevision += 1;
}

export function clearAgentTraceCache(): void {
  entries.clear();
  if (details.size) detailRevision += 1;
  details.clear();
}

export function agentTraceDetailRevision(): number {
  return detailRevision;
}

export function agentTraceDetailState(paneId: string, detailRef: string): AgentTraceDetailState {
  return details.get(paneId)?.get(detailRef) ?? { status: "idle" };
}

export function setAgentTraceDetailState(paneId: string, detailRef: string, value: AgentTraceDetailState): void {
  let pane = details.get(paneId);
  if (!pane) {
    pane = new Map();
    details.set(paneId, pane);
  }
  pane.delete(detailRef);
  pane.set(detailRef, value);
  while (pane.size > MAX_DETAILS_PER_PANE) {
    const oldest = pane.keys().next().value;
    if (typeof oldest !== "string") break;
    pane.delete(oldest);
  }
  detailRevision += 1;
}
