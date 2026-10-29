import { composeStore, stageResetComposeField } from "./compose-store";
import { chatStore, stageResetTrace } from "./chat/trace-store";
import { createDomain } from "../../shared/model/domain-store";
import { composeTransaction } from "../../shared/model/compose-transaction";

/**
 * Session domain: what the open pane shows right now. The buffer text and its
 * hash, the reader's scroll/unread posture, terminal selection, and which pane
 * controller is mounted (guided snapshot, complete terminal, agent chat).
 *
 * The live session object and credential live in `computers.ts`; the agent
 * transcript in `chat.ts`; the input draft in `compose.ts`. Snapshot queue,
 * snapshot time and pane-read flight flags are named observation actions on
 * this record (captain-authorized overlap); they are not a generic patch bag.
 */
export type SessionRecord = {
  paneId: string;
  /** Raw Herdr ANSI controller is mounted instead of the guided pane view. */
  fullTerminal: boolean;
  /** Structured agent-execution view instead of the snapshot terminal. */
  agentChat: boolean;
  paneText: string;
  paneHash: string;
  /**
   * A screen read has landed for this open, even if it returned nothing. Until
   * then the guided terminal has no screen to show, whatever text it carries.
   */
  paneLoaded: boolean;
  snapshotPending: boolean;
  /** When the last Snapshot landed, so a pane change can pull status forward. */
  snapshotAt: number;
  paneReadBusy: boolean;
  paneReadPending: boolean;
  /** Terminal is pinned to the newest row; cleared when the reader scrolls up. */
  paneFollow: boolean;
  paneUnread: boolean;
  /** Index of the terminal row whose action bar is open, or null. */
  paneRow: number | null;
  termSelect: boolean;
};

const sessionDomain = createDomain<SessionRecord>("session", {
  paneId: "",
  fullTerminal: false,
  agentChat: false,
  paneText: "",
  paneHash: "",
  paneLoaded: false,
  snapshotPending: false,
  snapshotAt: 0,
  paneReadBusy: false,
  paneReadPending: false,
  paneFollow: true,
  paneUnread: false,
  paneRow: null,
  termSelect: false,
});
export const sessionStore = sessionDomain.store;
const { read, write, stage } = sessionDomain.controller;


export function openPaneId(): string {
  return read().paneId;
}

/** The complete-terminal controller is mounted instead of the guided pane view. */
export function isFullTerminal(): boolean {
  return read().fullTerminal;
}

/** The structured agent-execution view is mounted instead of the snapshot terminal. */
export function isAgentChat(): boolean {
  return read().agentChat;
}

/** Live canonical buffer. Use with applyPaneRead so a facade dirty write cannot hide behind the published snapshot. */
export function livePaneText(): string {
  return read().paneText;
}

export function livePaneHash(): string {
  return read().paneHash;
}

export function termSelect(): boolean {
  return read().termSelect;
}

export function paneFollow(): boolean {
  return read().paneFollow;
}

export function paneUnread(): boolean {
  return read().paneUnread;
}

export function paneRow(): number | null {
  return read().paneRow;
}

/** Point the session view at another pane and clear everything the old one owned. */
export function selectPane(paneId: string): void {
  if (read().paneId === paneId) return;
  // Which pane is open decides the session page and the desk main column.
  composeTransaction([sessionStore], () => {
    stage((record) => {
      record.paneId = paneId;
    });
  });
}

/** Whether a screen read has landed for this open. */
export function paneLoaded(): boolean {
  return read().paneLoaded;
}

/** A successful terminal read replaced the buffer. */
export function applyPaneRead(text: string, hash: string): void {
  const live = read();
  const published = sessionStore.get();
  if (
    live.paneLoaded && published.paneLoaded
    && live.paneText === text && live.paneHash === hash
    && published.paneText === text && published.paneHash === hash
  ) return;
  write((record) => {
    record.paneText = text;
    record.paneHash = hash;
    record.paneLoaded = true;
  });
}

/**
 * Bring the published buffer up to the live one without claiming a screen has
 * been read: a staged transition's buffer is republished this way when the pane
 * is painted, and the wait for its own read must survive the repaint.
 */
export function publishPaneBuffer(): void {
  const live = read();
  const published = sessionStore.get();
  if (
    published.paneText === live.paneText && published.paneHash === live.paneHash
    && published.paneLoaded === live.paneLoaded
  ) return;
  write((record) => {
    record.paneText = live.paneText;
    record.paneHash = live.paneHash;
    record.paneLoaded = live.paneLoaded;
  });
}

/**
 * Paint the screen this pane had when it was last open, before its read lands
 * (the pane-buffer cache owns where that comes from). An empty screen has
 * nothing to paint and stays unloaded, so the read decides what it shows.
 */
export function seedPaneBuffer(text: string, hash: string): void {
  if (!text) return;
  const live = read();
  if (live.paneText === text && live.paneHash === hash && live.paneLoaded) return;
  composeTransaction([sessionStore], () => {
    stage((record) => {
      record.paneText = text;
      record.paneHash = hash;
      record.paneLoaded = true;
    });
  });
}

export function snapshotIsPending(): boolean {
  return read().snapshotPending;
}

/** Queue another Snapshot after the in-flight one. Does not start a fetch. */
export function queueSnapshot(): void {
  if (read().snapshotPending) return;
  write((record) => {
    record.snapshotPending = true;
  });
}

export function clearSnapshotPending(): void {
  if (!read().snapshotPending) return;
  write((record) => {
    record.snapshotPending = false;
  });
}

/** Consume a queued Snapshot. Returns whether one was waiting. */
export function takeQueuedSnapshot(): boolean {
  if (!read().snapshotPending) return false;
  write((record) => {
    record.snapshotPending = false;
  });
  return true;
}

export function lastSnapshotAt(): number {
  return read().snapshotAt;
}

export function noteSnapshotAt(ms: number): void {
  if (read().snapshotAt === ms) return;
  write((record) => {
    record.snapshotAt = ms;
  });
}

export function paneReadBusy(): boolean {
  return read().paneReadBusy;
}

export function setPaneReadBusy(busy: boolean): void {
  if (read().paneReadBusy === busy) return;
  write((record) => {
    record.paneReadBusy = busy;
  });
}

export function paneReadPending(): boolean {
  return read().paneReadPending;
}

export function setPaneReadPending(pending: boolean): void {
  if (read().paneReadPending === pending) return;
  write((record) => {
    record.paneReadPending = pending;
  });
}

/** Drop observation flags with the session that queued them. Not a generic patch. */
export function resetObservationLifecycle(): void {
  const record = read();
  if (!record.snapshotPending && record.snapshotAt === 0 && !record.paneReadBusy && !record.paneReadPending) return;
  write((next) => {
    next.snapshotPending = false;
    next.snapshotAt = 0;
    next.paneReadBusy = false;
    next.paneReadPending = false;
  });
}

export function setTermSelect(selecting: boolean): void {
  if (read().termSelect === selecting) return;
  write((record) => {
    record.termSelect = selecting;
  });
}

/** Mount the complete-terminal controller instead of the guided pane view. */
export function setFullTerminal(active: boolean): void {
  if (read().fullTerminal === active) return;
  composeTransaction([sessionStore], () => {
    stage((record) => {
      record.fullTerminal = active;
    });
  });
}

/** Mount the structured agent-execution view instead of the snapshot terminal. */
export function setAgentChat(active: boolean): void {
  if (read().agentChat === active) return;
  composeTransaction([sessionStore], () => {
    stage((record) => {
      record.agentChat = active;
    });
  });
}

export function setPaneFollow(follow: boolean): void {
  const live = read();
  // Idempotent: an already-following pane with no unread chip must not
  // publish an identical snapshot (a mounted layout effect calls this on
  // every arriving scroll). A follow=true write still clears the unread
  // chip, so the action never skips a needed unread retirement.
  if (live.paneFollow === follow && !(follow && live.paneUnread)) return;
  write((record) => {
    record.paneFollow = follow;
    if (follow) record.paneUnread = false;
  });
}

export function setPaneUnread(unread: boolean): void {
  if (read().paneUnread === unread) return;
  write((record) => {
    record.paneUnread = unread;
  });
}

export function setPaneRow(row: number | null): void {
  if (read().paneRow === row) return;
  write((record) => {
    record.paneRow = row;
  });
}

/**
 * Reset every per-pane view mode. Called whenever the open pane changes or the
 * pane screen is left.
 *
 * keysExpanded / padKind stay: they are keypad preferences, not per-pane view
 * modes. Collapsing on every switch put Ctrl+C and 换行 two taps away.
 */
export function resetPaneView(): void {
  // agentChat / fullTerminal select the session page. Stage session, compose and
  // chat together so no subscriber observes an empty transcript while the
  // published session is still the old chat page.
  composeTransaction([sessionStore, composeStore, chatStore], () => {
    stage((record) => {
      record.paneText = "";
      record.paneHash = "";
      record.paneLoaded = false;
      record.paneFollow = true;
      record.paneUnread = false;
      record.paneRow = null;
      record.termSelect = false;
      record.fullTerminal = false;
      record.agentChat = false;
    });
    stageResetComposeField();
    stageResetTrace();
  });
}
