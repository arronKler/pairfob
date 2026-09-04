import type { AgentTraceDetail, AgentTraceItem } from "./operations";

export type AgentTraceCacheEntry = {
  items: AgentTraceItem[];
  nextCursor: string | null;
  note: string;
  truncated: boolean;
  signature: string;
  tail: number;
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
  return { ...entry, items: entry.items.map((item) => ({ ...item })) };
}

/** Short-lived screen cache only; daemon changes clear it before another computer can reuse a pane id. */
export function cacheAgentTrace(paneId: string, entry: AgentTraceCacheEntry): void {
  if (!paneId) return;
  entries.delete(paneId);
  entries.set(paneId, copy(entry));
  while (entries.size > MAX_CACHED_PANES) {
    const oldest = entries.keys().next().value;
    if (typeof oldest !== "string") break;
    entries.delete(oldest);
    if (details.delete(oldest)) detailRevision += 1;
  }
}

export function cachedAgentTrace(paneId: string): AgentTraceCacheEntry | null {
  const entry = entries.get(paneId);
  if (!entry) return null;
  entries.delete(paneId);
  entries.set(paneId, entry);
  return copy(entry);
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
