import type { AgentTraceItem } from "./operations";

export type AgentTraceCacheEntry = {
  items: AgentTraceItem[];
  nextCursor: string | null;
  note: string;
  signature: string;
  tail: number;
};

const MAX_CACHED_PANES = 6;
const entries = new Map<string, AgentTraceCacheEntry>();

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
}

export function clearAgentTraceCache(): void {
  entries.clear();
}
