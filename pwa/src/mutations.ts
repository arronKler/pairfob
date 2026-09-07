import {
  herdSignature,
  type SnapshotWire as Snapshot,
} from "./lib/dashboard";
import { nextTouchedAt } from "./lib/ranking";
import { reconcileMutationFailure, type ListWorktreesInput } from "./lib/operations";
import { type LiveSession } from "./lib/protocol/client";
import { render } from "./paint";
import { leavePaneScreen, messageOf, replaceAgentsFromSnapshot, savePaneTouched, showError, state } from "./state";

/** Refresh data even when the initiating view no longer owns a repaint. */
export async function refreshSnapshotOnly(session: LiveSession, shouldPaint: () => boolean = () => true): Promise<void> {
  if (state.live !== session || !session.isConnected()) return;
  const snapshot = (await session.snapshot()) as Snapshot;
  if (state.live !== session) return;
  const previous = replaceAgentsFromSnapshot(snapshot);
  state.paneTouched = nextTouchedAt(previous, state.agents, state.paneTouched);
  savePaneTouched();
  state.lastHerdSig = herdSignature(state.agents);
  const paneGone = Boolean(state.paneId && !state.agents.some((agent) => agent.paneId === state.paneId));
  if (paneGone) {
    state.paneId = "";
    state.paneText = "";
    state.paneHash = "";
    if (state.screen === "pane") leavePaneScreen();
  }
  // A removed pane has no live composer to preserve; paint the resulting navigation.
  if (paneGone || shouldPaint()) render();
}

export async function reconcileAmbiguousMutation(
  session: LiveSession,
  error: unknown,
  worktrees?: ListWorktreesInput,
  shouldPaint?: () => boolean,
): Promise<void> {
  await reconcileMutationFailure(error, {
    snapshot: () => refreshSnapshotOnly(session, shouldPaint),
    ...(worktrees ? { listWorktrees: () => session.listWorktrees(worktrees) } : {}),
  });
}

export async function reportMutationError(session: LiveSession, error: unknown): Promise<void> {
  await reconcileAmbiguousMutation(session, error);
  showError(messageOf(error));
  render();
}
