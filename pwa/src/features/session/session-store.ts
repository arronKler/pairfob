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
 * transcript in `chat.ts`; the input draft in `compose.ts`.
 *
 * What is rendered is here; what only steers the poll lanes is not. The Snapshot
 * queue and the pane-read flight flags never reach a render, so they live
 * outside the record: publishing them would deep-copy the buffer and repaint
 * every session subscriber to say a read started or ended. Snapshot time stays
 * on the record: its publication is a reentry point a subscriber may retire the
 * session from, which the poll checks before applying what it read.
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
  /** When the last Snapshot landed, so a pane change can pull status forward. */
  snapshotAt: number;
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
  snapshotAt: 0,
  paneFollow: true,
  paneUnread: false,
  paneRow: null,
  termSelect: false,
});
export const sessionStore = sessionDomain.store;
const { read, write, stage } = sessionDomain.controller;

/**
 * Observation bookkeeping for the poll lanes. No screen renders it, so it never
 * enters a published snapshot: a pane read that starts and ends must not
 * republish the buffer.
 */
const observation = {
  snapshotPending: false,
  paneReadBusy: false,
  paneReadPending: false,
};


export function openPaneId(): string {
  return read().paneId;
}

/**
 * What a screen that only names the open session renders from this domain, as a
 * scalar: the pane. The domain publishes a read or a keystroke at a time, and
 * none of that moves a screen that is not the session's own.
 */
export function herdSessionKey(snapshot: object): string {
  return (snapshot as { paneId: string }).paneId;
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
  return observation.snapshotPending;
}

/** Queue another Snapshot after the in-flight one. Does not start a fetch. */
export function queueSnapshot(): void {
  observation.snapshotPending = true;
}

export function clearSnapshotPending(): void {
  observation.snapshotPending = false;
}

/** Consume a queued Snapshot. Returns whether one was waiting. */
export function takeQueuedSnapshot(): boolean {
  if (!observation.snapshotPending) return false;
  observation.snapshotPending = false;
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
  return observation.paneReadBusy;
}

export function setPaneReadBusy(busy: boolean): void {
  observation.paneReadBusy = busy;
}

export function paneReadPending(): boolean {
  return observation.paneReadPending;
}

export function setPaneReadPending(pending: boolean): void {
  observation.paneReadPending = pending;
}

/** Drop observation flags with the session that queued them. Not a generic patch. */
export function resetObservationLifecycle(): void {
  observation.snapshotPending = false;
  observation.paneReadBusy = false;
  observation.paneReadPending = false;
  if (read().snapshotAt === 0) return;
  write((record) => {
    record.snapshotAt = 0;
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
