import { applySnapshot, dashboardStore } from "../dashboard/catalog-store";
import type { SnapshotWire } from "../../lib/dashboard";
import { currentScreen, leavePaneScreen } from "../../app/navigation-store";
import { applyHerdTouches } from "../settings/preferences-store";
import { applyPaneRead, openPaneId, selectPane } from "../session/session-store";
import { liveSession } from "../computers/catalog-store";
import { reconcileMutationFailure, type ListWorktreesInput } from "../../lib/operations";
import { type LiveSession } from "../../lib/protocol/client";
import { commitView } from "../../app/host";
import { messageOf } from "../../lib/notices";
import { showError } from "../../app/notices-store";
import { liveView } from "./generations";

function dropGonePane(): void {
  selectPane("");
  applyPaneRead("", "");
}

/** Refresh data even when the initiating view no longer owns a repaint. */
export async function refreshSnapshotOnly(session: LiveSession, shouldPaint: () => boolean = () => true): Promise<void> {
  const viewVersion = liveView();
  if (liveSession() !== session || !session.isConnected()) return;
  const snapshot = (await session.snapshot()) as SnapshotWire;
  if (liveSession() !== session || liveView() !== viewVersion) return;
  if (!shouldPaint()) return;
  const { previous } = applySnapshot(snapshot);
  applyHerdTouches(previous, dashboardStore.get().agents);
  const paneGone = Boolean(openPaneId() && !dashboardStore.get().agents.some((agent) => agent.paneId === openPaneId()));
  if (paneGone) {
    dropGonePane();
    if (currentScreen() === "pane") leavePaneScreen();
  }
  // A removed pane has no live composer to preserve; paint the resulting navigation.
  if (paneGone || shouldPaint()) commitView();
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
  const viewVersion = liveView();
  await reconcileAmbiguousMutation(session, error);
  if (liveSession() !== session || liveView() !== viewVersion) return;
  showError(messageOf(error));
  commitView();
}
