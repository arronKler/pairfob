import { setOperationBusy, operationBusy } from "../../operations/capabilities-store";
import { setTraceNote } from "../chat/trace-store";
import { composeDraft, composeIME, setComposeDraft } from "../compose-store";
import { currentDaemonId, liveSession } from "../../computers/catalog-store";
import { phase } from "../../connection/connection-store";
import { currentScreen, setScreen } from "../../../app/navigation-store";
import { isAgentChat, isFullTerminal, openPaneId } from "../session-store";
import { batch } from "../../../shared/model/domain-store";
import { bindSessionOwnerFromLive } from "../bind-live";
import { composeDraftMode } from "../model";
import {
  composeDraftScopeFromNotice,
  sameComposeDraftScope,
  type ComposeDraftScope,
  type ComposeInputMode,
} from "../../../lib/compose-draft-scope";
import type { NoticeScope } from "../../../lib/notice-scope";
import { fitOperationPrompt } from "../../../lib/operations";
import { ProtocolError } from "../../../lib/protocol/errors";
import { messageOf } from "../../../lib/notices";
import { captureNoticeScope, noticeScopeIsCurrent } from "../../../app/notices-store";
import {
  bumpDraftRevision,
  bumpViewIncarnation as bumpStoredViewIncarnation,
  clearDraftStore,
  clearParkedDraft,
  currentViewIncarnation as storedViewIncarnation,
  dropPromptLocks,
  holdPromptLock,
  nextDraftRevision,
  nextPromptLockId,
  readStoredDraft,
  releasePromptLock as releaseStoredLock,
  storedDraftIsParked,
  unstickPromptBusy,
  writeStoredDraft,
} from "./state-drafts";

import { nextTransition, transitionFor } from "../../../app/transition";
import type { Screen } from "../../../app/navigation-store";

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
  if (phase() !== "live" || currentScreen() !== "pane" || !openPaneId()) return null;
  return composeDraftMode({ agentChat: isAgentChat(), fullTerminal: isFullTerminal() });
}

export function currentComposeDraftScope(): ComposeDraftScope | null {
  const mode = currentComposeInputMode();
  if (!mode) return null;
  return {
    daemonId: currentDaemonId(),
    paneId: openPaneId(),
    mode,
  };
}

export function captureComposeDraft(): void {
  const scope = currentComposeDraftScope();
  if (!scope) return;
  const draft = composeDraft();
  const stored = readStoredDraft(scope);
  if (draft === stored.text) {
    writeStoredDraft(scope, { text: draft });
    clearParkedDraft(scope);
    return;
  }
  // A retired live field parked this text. The replacement field is still
  // empty and never held it, so its empty draft must not overwrite the parked
  // text; the park survives until the pane opens again and applies it.
  if (!draft && storedDraftIsParked(scope)) return;
  writeStoredDraft(scope, {
    text: draft,
    error: "",
    revision: nextDraftRevision(),
  });
  clearParkedDraft(scope);
}

export function applyComposeDraft(): void {
  const scope = currentComposeDraftScope();
  if (!scope) {
    setComposeDraft("");
    return;
  }
  const entry = readStoredDraft(scope);
  // Retire the observed park BEFORE the publication below. A callback that
  // runs during it can park a newer same-scope transfer; that newer park owns
  // a fresh mark, which this older apply must never clear afterwards.
  if (storedDraftIsParked(scope)) clearParkedDraft(scope);
  setComposeDraft(entry.text);
  if (scope.mode === "agent" && entry.error) setTraceNote(entry.error);
}

export function currentViewIncarnation(): number {
  return storedViewIncarnation();
}

export function bumpViewIncarnation(): number {
  if (unstickPromptBusy()) setOperationBusy(false);
  return bumpStoredViewIncarnation();
}

/** Park the visible draft, then advance the view so in-flight UI is no longer live. */
export function parkComposeView(): void {
  captureComposeDraft();
  bumpViewIncarnation();
  bindSessionOwnerFromLive();
}

export function switchComposeView(mutate: () => void): void {
  captureComposeDraft();
  bumpViewIncarnation();
  batch(() => {
    mutate();
    bindSessionOwnerFromLive();
    applyComposeDraft();
  });
}

/** Park a pane composer when leaving it, and invalidate ownership when returning. */
export function adoptScreen(next: Screen): void {
  const from = currentScreen();
  if (from === next) return;
  nextTransition(transitionFor(from, next));
  if (from === "pane") parkComposeView();
  else if (next === "pane") bumpViewIncarnation();
  setScreen(next);
  if (next === "pane") {
    bindSessionOwnerFromLive();
    applyComposeDraft();
  }
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
    if (composeIME() || composeDraft().trim()) return false;
    setComposeDraft(fitted);
    writeStoredDraft(scope, { text: fitted, revision });
    return true;
  }
  if (stored.text.trim()) return false;
  writeStoredDraft(scope, { text: fitted, revision });
  return false;
}

export function acquirePromptLock(): number | null {
  if (operationBusy()) return null;
  const id = nextPromptLockId();
  holdPromptLock(id);
  setOperationBusy(true);
  return id;
}

export function releasePromptLock(id: number): boolean {
  const result = releaseStoredLock(id);
  if (!result.owned) return false;
  if (result.clearedBusy) setOperationBusy(false);
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
    liveSession() === owner.session &&
    storedViewIncarnation() === owner.viewIncarnation &&
    noticeScopeIsCurrent(owner.noticeScope) &&
    Boolean(scope && sameComposeDraftScope(scope, owner.draftScope))
  );
}

export function promptRequestOwnsComputer(owner: PromptRequestOwner): boolean {
  return liveSession() === owner.session && currentDaemonId() === owner.draftScope.daemonId;
}

function ownsStoredAttempt(owner: PromptRequestOwner): boolean {
  return readStoredDraft(owner.draftScope).revision === owner.revision;
}

function captureNewerVisibleDraft(owner: PromptRequestOwner): void {
  const current = currentComposeDraftScope();
  if (!current || !sameComposeDraftScope(current, owner.draftScope)) return;
  const draft = composeDraft();
  if (!draft.trim() || draft === owner.text) return;
  captureComposeDraft();
}

export function settlePromptFailure(owner: PromptRequestOwner, error: unknown): {
  unknownOutcome: boolean;
  message: string;
  restoredVisible: boolean;
} {
  const unknownOutcome = error instanceof ProtocolError && error.code === "unknown_outcome";
  const message = messageOf(error);
  captureNewerVisibleDraft(owner);
  if (!ownsStoredAttempt(owner)) return { unknownOutcome, message, restoredVisible: false };
  writeStoredDraft(owner.draftScope, { error: message, revision: owner.revision });
  const restoredVisible = !unknownOutcome && recoverComposeDraft(owner.draftScope, owner.text, owner.revision);
  return { unknownOutcome, message, restoredVisible };
}

export function settlePromptSuccess(owner: PromptRequestOwner): void {
  captureNewerVisibleDraft(owner);
  if (!ownsStoredAttempt(owner)) return;
  writeStoredDraft(owner.draftScope, { text: "", error: "", revision: nextDraftRevision() });
}

export function resetComposeDrafts(): void {
  clearDraftStore();
  dropPromptLocks();
}
