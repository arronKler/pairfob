/**
 * The screen a pane had when it was last read.
 *
 * Opening a session reads its screen from the computer, and that round trip is
 * the whole wait between the tap and the first row. The pane is a terminal, so
 * until the read lands there is nothing to paint but its bare ground. Keeping
 * the last screen of a pane hands the reader that screen at once, in the same
 * way agent chat opens on its cached transcript, and the read that follows
 * replaces it — the poll would have done the same a moment later.
 *
 * A cache, not state: nothing here is published, the entries are bounded, and
 * an entry only answers for the occupant it was read from (another computer or
 * another Herdr session can hand the same pane id a different terminal).
 */
import { paneOwnerKey } from "./pane-owner";
import { seedPaneBuffer } from "./session-store";

type PaneBuffer = { text: string; hash: string; ownerKey: string };

const MAX_CACHED_PANES = 6;
const buffers = new Map<string, PaneBuffer>();

/** Keep the screen a read just returned, for the next visit to this pane. */
export function rememberPaneBuffer(paneId: string, text: string, hash: string): void {
  // A screen with no text has nothing to paint: the next visit reads it too.
  if (!text) return;
  const key = paneOwnerKey(paneId);
  if (!key) return;
  buffers.delete(paneId);
  buffers.set(paneId, { text, hash, ownerKey: key });
  while (buffers.size > MAX_CACHED_PANES) {
    const oldest = buffers.keys().next().value;
    if (typeof oldest !== "string") break;
    buffers.delete(oldest);
  }
}

/**
 * Paint the screen this pane had last time. Returns whether there was one:
 * with nothing cached the pane stays unloaded until its own read lands.
 */
export function restorePaneBuffer(paneId: string): boolean {
  const entry = buffers.get(paneId);
  const key = paneOwnerKey(paneId);
  if (!entry || !key || entry.ownerKey !== key) return false;
  buffers.delete(paneId);
  buffers.set(paneId, entry);
  seedPaneBuffer(entry.text, entry.hash);
  return true;
}

/** Drop every screen: none of them belongs to the session being retired. */
export function clearPaneBufferCache(): void {
  buffers.clear();
}
