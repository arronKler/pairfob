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
 *
 * Asking for the pane that is already on screen beside the list is not a
 * transition: see `chooseDisplayedPane`.
 */
import { rememberPane, paneComposeLive, paneTermMode } from "../settings/preferences-store";
import { setComposeDraft, setComposeLive } from "../session/compose-store";
import { setTraceNote } from "../session/chat/trace-store";
import { currentDaemonId } from "../computers/catalog-store";
import { getAppFrame } from "../../app/frame";
import { setScreen } from "../../app/navigation-store";
import { readStoredDraft } from "../session/drafts/state-drafts";
import { acknowledgePaneCompletion } from "../dashboard/catalog-store";
import { handKeyboardToSession } from "../session/keyboard-handover";
import {
  openPaneId,
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
  canEnterAgentChat(agent: { paneId: string; historyAvailable?: boolean; hasAgent?: boolean; agent?: string } | undefined): boolean;
  resolvedTermMode(mode: ReturnType<typeof paneTermMode>): "full" | "agent" | "guided";
  queuedKind(): string;
  nextTransition(kind: string, paneId: string): void;
  transitionFor(from: string, to: string): string;
  currentScreen(): string;
  isFullTerminal(): boolean;
  findAgent(paneId: string): { paneId: string } | undefined;
  /**
   * Commit the destination. A shared list → pane transition resolves once its
   * deferred commit ran; every other navigation commits synchronously.
   */
  commitView(): void | Promise<void>;
  refreshPane(): Promise<void>;
};

/**
 * The pane asked for is the one on screen beside the list: the committed frame
 * shows it in the desk's session column, in the view that is current, under the
 * live session that is current. A phone has the list on a screen of its own, so
 * a pane chosen there is never this one on screen.
 */
function paneIsDisplayed(paneId: string, ports: OpenPanePorts): boolean {
  const session = ports.currentLive();
  const frame = getAppFrame();
  return session !== null
    && ports.currentScreen() === "pane"
    && openPaneId() === paneId
    && frame.layout?.deskChild != null
    && frame.session?.paneId === paneId
    && frame.session.incarnation === ports.currentIncarnation()
    && frame.sessionOwner === session;
}

/**
 * Beside the list the open pane's own row is one click away, and choosing it
 * must not cost the session anything. Nothing is parked, left or re-resolved:
 * a complete terminal keeps its bridge, the mode stays what the reader made it
 * and the draft stays in its field. No navigation is started either, so one
 * still finishing for this pane is not superseded. The two things a click on
 * the row still means are kept: its completion is acknowledged, and the
 * session gets the keyboard, as it does when the row opens it.
 */
function chooseDisplayedPane(paneId: string, ports: OpenPanePorts): PaneNavigation {
  const session = ports.currentLive();
  const viewVersion = liveView();
  const incarnation = ports.currentIncarnation();
  const scope: NoticeScope = { ...captureNoticeScope(), screen: "pane", paneId };
  acknowledgePaneCompletion(paneId);
  handKeyboardToSession();
  const isCurrent = () =>
    ports.currentLive() === session &&
    liveView() === viewVersion &&
    ports.currentIncarnation() === incarnation &&
    noticeScopeIsCurrent(scope) &&
    ports.currentScreen() === "pane";
  return { scope, incarnation, isCurrent };
}

export async function openPaneWithOwner(paneId: string, ports: OpenPanePorts): Promise<PaneNavigation | null> {
  if (paneIsDisplayed(paneId, ports)) return chooseDisplayedPane(paneId, ports);
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
  const committed = ports.commitView();
  if (committed) await committed;
  if (!isCurrent()) return null;
  await ports.refreshPane();
  return isCurrent() ? navigation : null;
}
