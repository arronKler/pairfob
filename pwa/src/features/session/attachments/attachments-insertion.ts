/**
 * Draft insertion duty for the attachment feature: turning committed absolute
 * paths into THIS compose view's local draft. It never sends keys, never
 * submits a form, and never truncates. Split from the orchestration controller
 * so each duty stays small and readable.
 */
import { isFullTerminal, openPaneId } from "../session-store";
import { composeDraft, composeLive, setComposeDraft } from "../compose-store";
import { composeField, setComposeLive as setGuidedComposeLive } from "../guided/compose";
import { setFullTerminalInputMode } from "../full-terminal/full-terminal-compose";
import { setPaneComposeLive } from "../../settings/preferences-store";
import {
  currentComposeDraftScope,
  currentViewIncarnation,
} from "../drafts/compose-drafts";
import type { ComposeDraftScope } from "../../../lib/compose-draft-scope";
import { sameComposeDraftScope } from "../../../lib/compose-draft-scope";
import { scopeMatches as scopeLive } from "./attachments-context";
import { hasOpenDialog, haptic } from "../../../lib/dom";
import { attachT } from "./attach-copy";
import {
  insertPathsAt,
  insertionTextFits,
  safeCommittedPath,
  type AttachmentScope,
} from "./attach-model";
import {
  attachmentScopeKey,
  clearInserted,
  markInserted,
  queueSnapshot,
  setQueueNotice,
} from "./attachments-store";

type InsertionView = {
  scope: ComposeDraftScope;
  incarnation: number;
};

/** One insert operation per pane queue; claimed synchronously, held across awaits. */
const insertLocks = new Set<string>();

function captureInsertionView(): InsertionView | null {
  const scope = currentComposeDraftScope();
  if (!scope) return null;
  return { scope, incarnation: currentViewIncarnation() };
}

/** Same compose view: daemon+pane+mode unchanged, view incarnation unchanged. */
function insertionViewStillLive(view: InsertionView): boolean {
  const current = currentComposeDraftScope();
  return current !== null
    && sameComposeDraftScope(current, view.scope)
    && currentViewIncarnation() === view.incarnation;
}

async function ensureBatchDraft(): Promise<void> {
  if (!composeLive()) return;
  if (isFullTerminal()) {
    // Full terminal mounts its batch field reactively when the flag flips.
    const paneId = openPaneId();
    if (paneId) setPaneComposeLive(paneId, false);
    setFullTerminalInputMode(false, () => true, () => {});
    return;
  }
  await setGuidedComposeLive(false);
}

function insertIntoField(text: string, caret: number): void {
  const field = composeField();
  if (!field || !field.isConnected) {
    // The field is not mounted (mode chrome swapping this frame); the stored
    // draft is the source each bound field adopts on mount.
    setComposeDraft(text);
    return;
  }
  field.value = text;
  field.setSelectionRange(caret, caret);
  setComposeDraft(text);
  const EventCtor = field.ownerDocument.defaultView?.Event;
  if (EventCtor) field.dispatchEvent(new EventCtor("input", { bubbles: true }));
  // The attachment sheet stays open while inserting: keep the exact draft,
  // value and selection, but never pull focus to the background compose field
  // behind the modal (focus returns on explicit close, and nothing is
  // auto-submitted).
  if (!hasOpenDialog()) field.focus({ preventScroll: true });
}

/**
 * Explicitly insert committed absolute paths into THIS compose view's local
 * draft. Never sends keys, never submits, never truncates. A double tap is
 * claimed once (synchronous lock) and the ready rows are re-read after the
 * live->batch switch, so no path is inserted twice.
 */
export async function insertPaths(scope: AttachmentScope, localIds?: readonly string[]): Promise<boolean> {
  const key = attachmentScopeKey(scope);
  if (!scopeLive(scope)) {
    setQueueNotice(key, attachT("err.insertScope"));
    return false;
  }
  // Synchronous claim before the first await.
  if (insertLocks.has(key)) return false;
  const view = captureInsertionView();
  if (!view || view.scope.paneId !== scope.paneId || view.scope.daemonId !== scope.daemonId
      || (view.scope.herdSession ?? null) !== (scope.herdSession ?? null)) {
    setQueueNotice(key, attachT("err.insertScope"));
    return false;
  }
  const wanted = localIds ? new Set(localIds) : null;
  const selected = (queueSnapshot(key)?.items ?? []).filter((item) =>
    item.status === "committed" && safeCommittedPath(item.path) && !item.inserted
    && (wanted === null || wanted.has(item.localId)));
  if (!selected.length) return false;
  insertLocks.add(key);
  try {
    // The expected same-view transition: live typing -> batch draft.
    await ensureBatchDraft();
    // The live-input pump must really be stopped before any draft/field
    // mutation: a flush that aborted mid-await leaves the live field typing
    // into the PTY. No automatic retry of the transition here.
    if (composeLive()) {
      setQueueNotice(key, attachT("err.insertScope"));
      return false;
    }
    if (!scopeLive(scope) || !insertionViewStillLive(view)) {
      setQueueNotice(key, attachT("err.insertScope"));
      return false;
    }
    // Re-read the queue after the await: another tap or a state change may
    // already have inserted or invalidated rows.
    const ready = (queueSnapshot(key)?.items ?? []).filter((item) =>
      item.status === "committed" && safeCommittedPath(item.path) && !item.inserted
      && (wanted === null || wanted.has(item.localId)));
    if (!ready.length) return false;

    const field = composeField();
    const connected = field?.isConnected === true;
    const base = connected ? field!.value : composeDraft();
    const start = connected ? (field!.selectionStart ?? base.length) : base.length;
    const end = connected ? (field!.selectionEnd ?? start) : start;
    const before = base.slice(0, start);
    const after = base.slice(end);

    // One exact final assembly, validated as a whole before any mutation.
    const paths = ready.map((item) => item.path);
    const assembled = insertPathsAt(before, after, paths);
    if (!insertionTextFits(assembled.text)) {
      setQueueNotice(key, attachT("err.draftFull"));
      haptic(2);
      return false;
    }
    insertIntoField(assembled.text, assembled.caret);
    for (const item of ready) markInserted(key, item.localId);
    setQueueNotice(key, attachT("attach.done"));
    haptic(8);
    return true;
  } finally {
    insertLocks.delete(key);
  }
}

/**
 * Take one in-body path back out of the draft (the tray's "移出正文"). The
 * first occurrence goes, with one separating space, so the sentence around it
 * closes up; the row is then appended on send again. A path the reader
 * already deleted by hand only clears the mark.
 */
export function removePathFromDraft(scope: AttachmentScope, localId: string): boolean {
  const key = attachmentScopeKey(scope);
  const item = queueSnapshot(key)?.items.find((row) => row.localId === localId);
  if (!item || !item.inserted) return false;
  clearInserted(key, localId);
  if (!scopeLive(scope) || composeLive() || !item.path) return true;
  const field = composeField();
  const connected = field?.isConnected === true;
  const base = connected ? field!.value : composeDraft();
  const text = withoutPath(base, item.path);
  if (text === base) return true;
  insertIntoField(text, Math.min(connected ? (field!.selectionStart ?? text.length) : text.length, text.length));
  return true;
}

/** Remove the first `path` and one adjacent space; exported for tests. */
export function withoutPath(text: string, path: string): string {
  const at = text.indexOf(path);
  if (at < 0) return text;
  let start = at;
  let end = at + path.length;
  if (text[end] === " ") end += 1;
  else if (start > 0 && text[start - 1] === " ") start -= 1;
  return text.slice(0, start) + text.slice(end);
}
