/**
 * openPane as one coordinated transition.
 *
 * Captures session, live-view generation, notice scope and view incarnation
 * before parking the previous terminal. Destination pane, compose, mode and
 * route are written in one batch so subscribers never see an empty draft
 * before restore. The owner is captured before any notification and never
 * recaptured after it: when the destination is committed the scope re-anchors
 * to the exact pane route this navigation is about to publish — never a route
 * a subscriber installed. A subscriber that completes a newer navigation or
 * leaves the pane route during publication ends this transition quietly, and
 * a stale generation does not refresh.
 */
import { rememberPane, paneComposeLive, paneTermMode } from "../settings/preferences-store";
import { setComposeDraft, setComposeLive } from "../session/compose-store";
import { setTraceNote } from "../session/chat/trace-store";
import { currentDaemonId } from "../computers/catalog-store";
import { setScreen } from "../../app/navigation-store";
import { readStoredDraft } from "../session/drafts/state-drafts";
import { acknowledgePaneCompletion } from "../dashboard/catalog-store";
import {
  resetPaneView,
  selectPane,
  setAgentChat,
  setFullTerminal,
} from "../session/session-store";
import { captureNoticeScope, clearNotice, noticeScopeIsCurrent, noticesStore } from "../../app/notices-store";
import { batch } from "../../shared/model/domain-store";
import { liveView, nextPaneNavigation, paneNavigationIsCurrent } from "./generations";
import type { LiveSession } from "../../lib/protocol/session-types";
import type { NoticeScope } from "../../lib/notice-scope";

export type PaneNavigation = {
  scope: NoticeScope;
  incarnation: number;
  isCurrent: () => boolean;
};

export type OpenPanePorts = {
  currentLive(): LiveSession | null;
  currentIncarnation(): number;
  parkComposeView(): void;
  dropQueuedKeys(): void;
  disposeGuidedScroll(): void;
  leaveFullTerminal(): Promise<{ from: number; to: number } | null>;
  restoreAgentTrace(paneId: string): void;
  canEnterAgentChat(agent: { paneId: string; historyAvailable?: boolean; hasAgent?: boolean } | undefined): boolean;
  resolvedTermMode(mode: ReturnType<typeof paneTermMode>): "full" | "agent" | "guided";
  queuedKind(): string;
  nextTransition(kind: string, paneId: string): void;
  transitionFor(from: string, to: string): string;
  currentScreen(): string;
  isFullTerminal(): boolean;
  findAgent(paneId: string): { paneId: string } | undefined;
  commitView(): void;
  refreshPane(): Promise<void>;
};

export async function openPaneWithOwner(paneId: string, ports: OpenPanePorts): Promise<PaneNavigation | null> {
  const request = nextPaneNavigation();
  const session = ports.currentLive();
  const viewVersion = liveView();
  const fromIncarnation = ports.currentIncarnation();
  // Owner captured once, before any notification. No publication below may
  // re-point this navigation at a newer route, session or notice world. The
  // scope moves once, to the intended destination, when this navigation
  // commits (see below).
  let scope = captureNoticeScope();
  ports.parkComposeView();
  let incarnation = ports.currentIncarnation();
  const ownerIsCurrent = () =>
    paneNavigationIsCurrent(request) &&
    ports.currentLive() === session &&
    liveView() === viewVersion &&
    ports.currentIncarnation() === incarnation &&
    noticeScopeIsCurrent(scope);
  const isCurrent = () => ownerIsCurrent() && ports.currentScreen() === "pane";
  ports.dropQueuedKeys();
  ports.disposeGuidedScroll();
  if (ports.isFullTerminal()) {
    const transition = await ports.leaveFullTerminal();
    if (!transition || (transition.from !== fromIncarnation && transition.from !== incarnation)) return null;
    incarnation = transition.to;
  }
  if (!ownerIsCurrent()) return null;
  // rememberPane publishes preferences: a subscriber completing a newer
  // openPane there must win; revalidate before touching the destination.
  rememberPane(paneId);
  if (!ownerIsCurrent()) return null;
  // Transfer source authority to the intended destination before publishing
  // it: only the screen (pane) and paneId this navigation is about to write
  // move, while phase and daemon stay the validated source owner's. The
  // destination is the route being published, never a re-read of whatever a
  // subscriber installed during publication.
  scope = { ...captureNoticeScope(), screen: "pane", paneId };
  batch(() => {
    selectPane(paneId);
    resetPaneView();
    setComposeLive(paneComposeLive(paneId));
    ports.restoreAgentTrace(paneId);
    if (ports.queuedKind() === "none") ports.nextTransition(ports.transitionFor(ports.currentScreen(), "pane"), paneId);
    setScreen("pane");
    const resolved = ports.resolvedTermMode(paneTermMode(paneId));
    const agent = ports.findAgent(paneId);
    // The effective mode follows the controller that actually mounts after
    // the agent-chat capability fallback. The restored draft is the draft the
    // pane really shows — never the stored preferred agent draft when chat
    // cannot enter — and an agent draft keeps its stored recovery error.
    const mode: "full" | "agent" | "guided" =
      resolved === "full" ? "full" : resolved === "agent" && ports.canEnterAgentChat(agent) ? "agent" : "guided";
    setFullTerminal(mode === "full");
    setAgentChat(mode === "agent");
    const draft = readStoredDraft({ daemonId: currentDaemonId(), paneId, mode });
    setComposeDraft(draft.text);
    if (mode === "agent" && draft.error) setTraceNote(draft.error);
    const raised = noticesStore.get().notice?.scope;
    if (!raised || !noticeScopeIsCurrent(raised)) clearNotice();
    acknowledgePaneCompletion(paneId);
  });
  // No recapture after the batch: the owner stands, now anchored to the exact
  // destination this navigation published. A subscriber that navigated away
  // during the batch (a different pane/screen/daemon) ends the transition.
  const navigation = { scope, incarnation, isCurrent };
  if (!isCurrent()) return null;
  ports.commitView();
  if (!isCurrent()) return null;
  await ports.refreshPane();
  return isCurrent() ? navigation : null;
}
