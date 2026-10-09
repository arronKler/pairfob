import { currentDaemonId, liveSession } from "../../computers/catalog-store";
import { type ComposeDraftScope, type ComposeInputMode } from "../../../lib/compose-draft-scope";
import { fitOperationPrompt } from "../../../lib/operations";
import { type LiveSession } from "../../../lib/protocol/client";
import { currentViewIncarnation } from "../drafts/compose-drafts";
import { nextDraftRevision, parkStoredDraft, readStoredDraft, writeStoredDraft } from "../drafts/state-drafts";
import { composeDraftMode } from "../model";
import { isAgentChat, isFullTerminal, openPaneId } from "../session-store";

/**
 * Identity of the pane that owns a live field when its text is transferred.
 * `setComposeDraft("")` inside the transfer publishes synchronously, and a
 * subscriber can replace the pane (switchComposeView) before the transfer
 * resumes. Carrying this identity lets the continuation recheck the owner
 * instead of enqueueing the retired field's text into the replacement.
 */
export type LiveComposeOwner = {
  session: LiveSession | null;
  paneId: string;
  incarnation: number;
  daemonId: string | null;
  mode: ComposeInputMode;
};

export function liveOwnerMoved(owner: LiveComposeOwner): boolean {
  return (
    liveSession() !== owner.session
    || openPaneId() !== owner.paneId
    || currentViewIncarnation() !== owner.incarnation
  );
}

/**
 * The owner pane was replaced while its live field's text was being
 * transferred. The text belongs to the pane that owned the field, never to
 * the replacement now on screen: park it in that pane's stored draft so
 * returning to the pane restores it, without sending anything or touching
 * the replacement's visible draft. The park mark keeps the replacement's
 * next empty-draft capture from erasing this text before it is ever shown.
 */
export function parkLiveComposeText(text: string, owner: LiveComposeOwner): void {
  const fitted = fitOperationPrompt(text).text;
  if (!fitted) return;
  const scope: ComposeDraftScope = {
    daemonId: owner.daemonId,
    paneId: owner.paneId,
    mode: owner.mode,
  };
  const merged = fitOperationPrompt(fitted + readStoredDraft(scope).text).text;
  if (!merged) return;
  writeStoredDraft(scope, { text: merged, revision: nextDraftRevision() });
  parkStoredDraft(scope);
}

/** The pane on screen now, as the owner of a live field about to hand its text over. */
export function liveComposeOwner(): LiveComposeOwner {
  return {
    session: liveSession(),
    paneId: openPaneId(),
    incarnation: currentViewIncarnation(),
    daemonId: currentDaemonId(),
    mode: composeDraftMode({ agentChat: isAgentChat(), fullTerminal: isFullTerminal() }),
  };
}
