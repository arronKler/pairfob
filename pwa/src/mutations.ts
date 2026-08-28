import {
  herdSignature,
  type SnapshotWire as Snapshot,
} from "./lib/dashboard";
import { nextTouchedAt } from "./lib/ranking";
import { reconcileMutationFailure, type ListWorktreesInput } from "./lib/operations";
import { type LiveSession } from "./lib/protocol/client";
import { render } from "./paint";
import { messageOf, replaceAgentsFromSnapshot, savePaneTouched, showError, state } from "./state";

export async function refreshSnapshotOnly(session: LiveSession): Promise<void> {
  if (state.live !== session || !session.isConnected()) return;
  const snapshot = (await session.snapshot()) as Snapshot;
  if (state.live !== session) return;
  const previous = replaceAgentsFromSnapshot(snapshot);
  state.paneTouched = nextTouchedAt(previous, state.agents, state.paneTouched);
  savePaneTouched();
  state.lastHerdSig = herdSignature(state.agents);
  if (state.paneId && !state.agents.some((agent) => agent.paneId === state.paneId)) {
    state.paneId = "";
    state.paneText = "";
    state.paneHash = "";
    if (state.screen === "pane") state.screen = "home";
  }
  render();
}

export async function reconcileAmbiguousMutation(
  session: LiveSession,
  error: unknown,
  worktrees?: ListWorktreesInput,
): Promise<void> {
  await reconcileMutationFailure(error, {
    snapshot: () => refreshSnapshotOnly(session),
    ...(worktrees ? { listWorktrees: () => session.listWorktrees(worktrees) } : {}),
  });
}

export async function reportMutationError(session: LiveSession, error: unknown): Promise<void> {
  await reconcileAmbiguousMutation(session, error);
  showError(messageOf(error));
  render();
}
