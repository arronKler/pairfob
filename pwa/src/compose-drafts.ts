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
  bumpDraftRevision,
  bumpViewIncarnation as bumpStoredViewIncarnation,
  clearDraftStore,
  currentViewIncarnation as storedViewIncarnation,
  dropPromptLocks,
  holdPromptLock,
  nextPromptLockId,
  readStoredDraft,
  releasePromptLock as releaseStoredLock,
  unstickPromptBusy,
  writeStoredDraft,
} from "./state-drafts";
import { captureNoticeScope, noticeScopeIsCurrent, state } from "./state";

export type PromptRequestOwner = {
  session: object;
  viewIncarnation: number;
  lockId: number;
  revision: number;
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
  const stored = readStoredDraft(scope);
  if (state.composeDraft === stored.text) {
    writeStoredDraft(scope, { text: state.composeDraft });
    return;
  }
  writeStoredDraft(scope, {
    text: state.composeDraft,
    error: "",
    revision: stored.revision + 1,
  });
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

export function currentViewIncarnation(): number {
  return storedViewIncarnation();
}

export function bumpViewIncarnation(): number {
  if (unstickPromptBusy()) state.operationBusy = false;
  return bumpStoredViewIncarnation();
}

/** Park the visible draft, then advance the view so in-flight UI is no longer live. */
export function parkComposeView(): void {
  captureComposeDraft();
  bumpViewIncarnation();
}

export function switchComposeView(mutate: () => void): void {
  captureComposeDraft();
  bumpViewIncarnation();
  mutate();
  applyComposeDraft();
}

function beginPromptAttempt(scope: ComposeDraftScope): number {
  const revision = bumpDraftRevision(scope);
  writeStoredDraft(scope, { text: "", error: "", revision });
  return revision;
}

export function recoverComposeDraft(scope: ComposeDraftScope, text: string, revision: number): boolean {
  const fitted = fitOperationPrompt(text).text;
  if (!fitted) return false;
  const stored = readStoredDraft(scope);
  if (stored.revision !== revision) return false;
  const current = currentComposeDraftScope();
  if (current && sameComposeDraftScope(current, scope)) {
    if (state.composeDraft.trim()) return false;
    state.composeDraft = fitted;
    writeStoredDraft(scope, { text: fitted, revision });
    return true;
  }
  if (stored.text.trim()) return false;
  writeStoredDraft(scope, { text: fitted, revision });
  return true;
}

export function acquirePromptLock(): number | null {
  if (state.operationBusy) return null;
  const id = nextPromptLockId();
  holdPromptLock(id);
  state.operationBusy = true;
  return id;
}

export function releasePromptLock(id: number): boolean {
  const result = releaseStoredLock(id);
  if (!result.owned) return false;
  if (result.clearedBusy) state.operationBusy = false;
  return true;
}

export function capturePromptRequest(session: object, paneId: string, text: string): PromptRequestOwner | null {
  const lockId = acquirePromptLock();
  if (lockId === null) return null;
  const noticeScope = captureNoticeScope();
  const mode = currentComposeInputMode() ?? "agent";
  const draftScope = composeDraftScopeFromNotice({ ...noticeScope, paneId }, mode);
  const revision = beginPromptAttempt(draftScope);
  return {
    session,
    viewIncarnation: storedViewIncarnation(),
    lockId,
    revision,
    noticeScope: { ...noticeScope, paneId },
    draftScope,
    text,
  };
}

export function promptRequestIsLive(owner: PromptRequestOwner): boolean {
  const scope = currentComposeDraftScope();
  return (
    state.live === owner.session &&
    storedViewIncarnation() === owner.viewIncarnation &&
    noticeScopeIsCurrent(owner.noticeScope) &&
    Boolean(scope && sameComposeDraftScope(scope, owner.draftScope))
  );
}

export function promptRequestOwnsComputer(owner: PromptRequestOwner): boolean {
  return state.live === owner.session && (state.credential?.daemonId ?? null) === owner.draftScope.daemonId;
}

function ownsStoredAttempt(owner: PromptRequestOwner): boolean {
  return readStoredDraft(owner.draftScope).revision === owner.revision;
}

function captureNewerVisibleDraft(owner: PromptRequestOwner): void {
  const current = currentComposeDraftScope();
  if (!current || !sameComposeDraftScope(current, owner.draftScope)) return;
  if (!state.composeDraft.trim() || state.composeDraft === owner.text) return;
  captureComposeDraft();
}

export function settlePromptFailure(owner: PromptRequestOwner, error: unknown): { unknownOutcome: boolean; message: string } {
  const unknownOutcome = error instanceof ProtocolError && error.code === "unknown_outcome";
  const message = messageOf(error);
  captureNewerVisibleDraft(owner);
  if (!ownsStoredAttempt(owner)) return { unknownOutcome, message };
  writeStoredDraft(owner.draftScope, { error: message, revision: owner.revision });
  if (!unknownOutcome) recoverComposeDraft(owner.draftScope, owner.text, owner.revision);
  return { unknownOutcome, message };
}

export function settlePromptSuccess(owner: PromptRequestOwner): void {
  captureNewerVisibleDraft(owner);
  if (!ownsStoredAttempt(owner)) return;
  writeStoredDraft(owner.draftScope, { text: "", error: "", revision: owner.revision + 1 });
}

export function resetComposeDrafts(): void {
  clearDraftStore();
  dropPromptLocks();
}
