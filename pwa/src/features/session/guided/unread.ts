import { previewBars, unreadLines } from "../../../lib/term-unread";

/**
 * What the reader has actually seen in the pane on screen. This lives outside
 * `state` because it describes the current viewing session rather than the
 * snapshot: it keys off the pane id and starts over on its own when a different
 * pane is opened.
 */
let pane = "";
let seen: string[] = [];
let pending = 0;
let bars: number[] = [];

/** Past this it is simply "a lot" and the exact number stops helping. */
const MAX_REPORTED = 999;

function open(paneId: string): void {
  if (pane === paneId) return;
  pane = paneId;
  seen = [];
  pending = 0;
  bars = [];
}

export function noteSnapshot(paneId: string, next: string[], following: boolean): void {
  open(paneId);
  if (following) {
    seen = next;
    pending = 0;
    bars = [];
    return;
  }
  const fresh = unreadLines(seen, next);
  if (fresh > 0) {
    pending = Math.min(MAX_REPORTED, pending + fresh);
    bars = previewBars(next, fresh);
  }
  seen = next;
}

export function unreadCount(): number {
  return pending;
}

export function unreadBars(): number[] {
  return bars;
}

/** The reader caught up: whatever is on screen now counts as seen. */
export function markCaughtUp(paneId: string, next: string[]): void {
  open(paneId);
  seen = next;
  pending = 0;
  bars = [];
}
