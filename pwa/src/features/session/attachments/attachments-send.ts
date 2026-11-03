/**
 * Contract between the attachment tray and the compose send path (session page v2).
 *
 * Attachments are part of the message, not text in the draft: on send, the
 * compose controller appends `readyPaths` (one per line) after the draft text.
 * Owned by the attachments workstream; the compose workstream only consumes it.
 */
import { composeDraft, composeStore } from "../compose-store";
import { sessionStore } from "../session-store";
import { attachmentP2PReady, currentAttachmentScope } from "./attachments-context";
import type { AttachmentScope } from "./attach-model";
import { subscribeAttachmentP2P } from "./attachments-connection";
import { removeItem } from "./attachments-controller";
import { attachmentScopeKey, attachmentsStore } from "./attachments-store";
import { summarizeForSend } from "./attachments-tray-model";
import {
  acceptPasted,
  blockedRowIds,
  continueBlocked,
  discardAttachments,
  subscribeTrayState,
  visibleItems,
} from "./attachments-tray-actions";

export type SendAttachmentsState = {
  /** Workspace paths of uploaded attachments not already placed in the draft body, tray order. */
  readyPaths: readonly string[];
  /** Attachments still preparing or uploading. */
  pending: number;
  /** Mean progress 0–100 of the pending ones (100 when none). */
  pendingPercent: number;
  /** Attachments that cannot finish without the reader (failed, paused, waiting for P2P). */
  blocked: number;
  /** Display names of the blocked ones, for the "not finished" prompt. */
  blockedNames: readonly string[];
  /** True when every blocked item is only waiting for a direct connection. */
  waitingP2P: boolean;
  /** Items in the tray. */
  total: number;
};

const EMPTY: SendAttachmentsState = Object.freeze({
  readyPaths: Object.freeze([]), pending: 0, pendingPercent: 100, blocked: 0,
  blockedNames: Object.freeze([]), waitingP2P: false, total: 0,
});

let cached: SendAttachmentsState = EMPTY;
let cachedSignature = "";

/** Snapshot for the open pane's attachment scope. Stable identity while unchanged. */
export function sendAttachmentsState(): SendAttachmentsState {
  const scope = currentAttachmentScope();
  const items = scope ? visibleItems(attachmentScopeKey(scope)) : [];
  if (!items.length) {
    cached = EMPTY;
    cachedSignature = "";
    return EMPTY;
  }
  const summary = summarizeForSend(items, { p2pReady: attachmentP2PReady(), draft: composeDraft() });
  const signature = JSON.stringify(summary);
  if (signature === cachedSignature) return cached;
  cachedSignature = signature;
  cached = Object.freeze({
    ...summary,
    readyPaths: Object.freeze(summary.readyPaths),
    blockedNames: Object.freeze(summary.blockedNames),
  });
  return cached;
}

/**
 * Fires on anything that can change the snapshot: the queue, the tray's
 * hidden rows, the direct connection, the open pane and the draft (a path
 * placed in the body stops being appended). Listeners compare snapshots, so
 * spurious calls are cheap.
 */
export function subscribeSendAttachments(listener: () => void): () => void {
  const stops = [
    attachmentsStore.subscribe(listener),
    subscribeTrayState(listener),
    subscribeAttachmentP2P(listener),
    sessionStore.subscribe(listener),
    composeStore.subscribe(listener),
  ];
  return () => stops.forEach((stop) => stop());
}

/** After a successful send: drop the sent items from the tray (uploaded files stay on the computer). */
export function markAttachmentsSent(scope: AttachmentScope | null = currentAttachmentScope()): void {
  if (!scope) return;
  for (const item of visibleItems(attachmentScopeKey(scope))) {
    // Committed rows are terminal on the computer: removal only drops the row.
    if (item.status === "committed") void removeItem(scope, item.localId);
  }
}

/** Retry failed / resume paused items; connect P2P when that is what they wait for. */
export function retryBlockedAttachments(): void {
  const scope = currentAttachmentScope();
  if (scope) void continueBlocked(scope);
}

/** Remove blocked items from the tray so the message can go without them. */
export function dropBlockedAttachments(): void {
  const scope = currentAttachmentScope();
  if (!scope) return;
  discardAttachments(scope, blockedRowIds(attachmentScopeKey(scope), attachmentP2PReady()));
}

/**
 * Files pasted into the compose field. Returns true when they were taken into the
 * tray (the caller then prevents the default paste). Wired by the compose workstream.
 */
export function acceptPastedFiles(files: readonly File[]): boolean {
  return acceptPasted(files);
}
