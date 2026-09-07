import {
  composeDraftScopeFromNotice,
  sameComposeDraftScope,
  type ComposeDraftScope,
  type ComposeInputMode,
} from "./lib/compose-draft-scope";
import type { NoticeScope } from "./lib/notice-scope";
import { fitOperationPrompt } from "./lib/operations";
import { ProtocolError } from "./lib/protocol/errors";
import { messageOf } from "./lib/notices";
import {
  bumpViewGeneration as bumpStoredViewGeneration,
  clearDraftStore,
  currentViewGeneration as storedViewGeneration,
  dropPromptLocks,
  holdPromptLock,
  nextPromptLockId,
  readStoredDraft,
  releasePromptLock as releaseStoredLock,
  writeStoredDraft,
} from "./state-drafts";
import { captureNoticeScope, noticeScopeIsCurrent, state } from "./state";

export type PromptRequestOwner = {
  session: object;
  viewGeneration: number;
  lockId: number;
  noticeScope: NoticeScope;
  draftScope: ComposeDraftScope;
  text: string;
};

export function currentComposeInputMode(): ComposeInputMode | null {
  if (state.phase !== "live" || state.screen !== "pane" || !state.paneId) return null;
  if (state.agentChat) return "agent";
  if (state.fullTerminal) return "full";
  return "guided";
}

export function currentComposeDraftScope(): ComposeDraftScope | null {
  const mode = currentComposeInputMode();
  if (!mode) return null;
  return {
    daemonId: state.credential?.daemonId ?? null,
    paneId: state.paneId,
    mode,
  };
}

export function captureComposeDraft(): void {
  const scope = currentComposeDraftScope();
  if (!scope) return;
  writeStoredDraft(scope, { text: state.composeDraft });
}

export function clearCurrentComposeDraft(): void {
  state.composeDraft = "";
  const scope = currentComposeDraftScope();
  if (scope) writeStoredDraft(scope, { text: "", error: "" });
}

export function applyComposeDraft(): void {
  const scope = currentComposeDraftScope();
  if (!scope) {
    state.composeDraft = "";
    return;
  }
  const entry = readStoredDraft(scope);
  state.composeDraft = entry.text;
  if (scope.mode === "agent" && entry.error) state.agentTraceNote = entry.error;
}

export function switchComposeView(mutate: () => void): void {
  captureComposeDraft();
  mutate();
  applyComposeDraft();
}

/**
 * Put failed prompt text back on the originating scope only. Visible or stored
 * edits on that scope win; the original text is otherwise kept for later restore.
 */
export function recoverComposeDraft(scope: ComposeDraftScope, text: string): boolean {
  const fitted = fitOperationPrompt(text).text;
  if (!fitted) return false;
  const current = currentComposeDraftScope();
  if (current && sameComposeDraftScope(current, scope)) {
    if (state.composeDraft.trim()) return false;
    state.composeDraft = fitted;
    writeStoredDraft(scope, { text: fitted });
    return true;
  }
  if (readStoredDraft(scope).text.trim()) return false;
  writeStoredDraft(scope, { text: fitted });
  return true;
}

export function rememberPromptError(scope: ComposeDraftScope, message: string): void {
  writeStoredDraft(scope, { error: message });
}

export function clearPromptError(scope: ComposeDraftScope): void {
  writeStoredDraft(scope, { error: "" });
}

export function currentViewGeneration(): number {
  return storedViewGeneration();
}

export function bumpViewGeneration(): number {
  dropPromptLocks();
  return bumpStoredViewGeneration();
}

export function acquirePromptLock(): number | null {
  if (state.operationBusy) return null;
  const id = nextPromptLockId();
  holdPromptLock(id);
  state.operationBusy = true;
  return id;
}

export function releasePromptLock(id: number): boolean {
  if (!releaseStoredLock(id)) return false;
  state.operationBusy = false;
  return true;
}

export function capturePromptRequest(session: object, paneId: string, text: string): PromptRequestOwner | null {
  const lockId = acquirePromptLock();
  if (lockId === null) return null;
  const noticeScope = captureNoticeScope();
  const mode = currentComposeInputMode() ?? "agent";
  return {
    session,
    viewGeneration: storedViewGeneration(),
    lockId,
    noticeScope: { ...noticeScope, paneId },
    draftScope: composeDraftScopeFromNotice({ ...noticeScope, paneId }, mode),
    text,
  };
}

export function promptRequestIsLive(owner: PromptRequestOwner): boolean {
  const scope = currentComposeDraftScope();
  return (
    state.live === owner.session &&
    storedViewGeneration() === owner.viewGeneration &&
    noticeScopeIsCurrent(owner.noticeScope) &&
    Boolean(scope && sameComposeDraftScope(scope, owner.draftScope))
  );
}

export function settlePromptFailure(owner: PromptRequestOwner, error: unknown): { unknownOutcome: boolean; message: string } {
  const unknownOutcome = error instanceof ProtocolError && error.code === "unknown_outcome";
  const message = messageOf(error);
  rememberPromptError(owner.draftScope, message);
  if (!unknownOutcome) recoverComposeDraft(owner.draftScope, owner.text);
  return { unknownOutcome, message };
}

export function settlePromptSuccess(owner: PromptRequestOwner): void {
  clearPromptError(owner.draftScope);
  const current = currentComposeDraftScope();
  if (current && sameComposeDraftScope(current, owner.draftScope)) {
    writeStoredDraft(owner.draftScope, { text: state.composeDraft });
    return;
  }
  const stored = readStoredDraft(owner.draftScope).text;
  if (!stored.trim() || stored === owner.text) writeStoredDraft(owner.draftScope, { text: "" });
}

export function resetComposeDrafts(): void {
  clearDraftStore();
  dropPromptLocks();
}
