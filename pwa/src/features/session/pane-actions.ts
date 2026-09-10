import { appRoot } from "../../app/dom-root";
import { commitView } from "../../app/host";
import { phase } from "../connection/connection-store";
import { boardReturn } from "../board/layout-store";
import { isAgentChat, isFullTerminal, openPaneId, resetPaneView } from "./session-store";
import { leavePaneScreen } from "../../app/navigation-store";
import { applyComposeDraft, parkComposeView } from "./drafts/compose-drafts";
import { enterWorkspace } from "../../features/workspace";
import { initSwipeBack as bindSwipeBack } from "./guided/pane-swipe";
import { nextTransition, shareOpening } from "../../app/transition";
import { openPaneMenu } from "./guided/pane-menu";
import { openPaneSwitcher } from "./guided/pane-switcher";
import { dropQueuedKeys } from "../../features/session/guided/keys";
import { type SessionHandlers } from "../../features/session/guided/view";
import { leaveAgentChat } from "./chat/agent-chat-controller";
import { leaveFullTerminal } from "./full-terminal/full-terminal";

/**
 * Pane navigation actions.
 *
 * The intents a reader can have on the pane screen — back, workspace, menu,
 * switcher — that `<App/>` hands to the session, chat and terminal routes. They
 * use named domain readers/actions and the App commit seam.
 */

export { openPaneMenu, openPaneSwitcher };

export async function openSelectedWorkspace(): Promise<void> {
  parkComposeView();
  const returnView = isFullTerminal() ? "full" : isAgentChat() ? "agent" : "guided";
  if (isFullTerminal()) await leaveFullTerminal({ rememberGuided: false, paint: false });
  if (isAgentChat()) leaveAgentChat({ rememberGuided: false, paint: false });
  await enterWorkspace(openPaneId(), returnView);
}

export function goBackFromPane(): void {
  // Every path out of here lands on the screen the pane was opened from. Coming
  // from the board, the pane collapses back into its tile instead of sliding off.
  if (boardReturn()) {
    shareOpening(appRoot().querySelector<HTMLElement>(".pane-root"));
    nextTransition("expand", openPaneId());
  } else nextTransition("pop", openPaneId());
  parkComposeView();
  if (isFullTerminal()) {
    void leaveFullTerminal({ rememberGuided: false, paint: false }).then(() => {
      if (phase() !== "live") return;
      dropQueuedKeys();
      leavePaneScreen();
      resetPaneView();
      applyComposeDraft();
      commitView();
    });
    return;
  }
  if (isAgentChat()) {
    leaveAgentChat({ rememberGuided: false, paint: false });
    dropQueuedKeys();
    leavePaneScreen();
    resetPaneView();
    applyComposeDraft();
    commitView();
    return;
  }
  dropQueuedKeys();
  leavePaneScreen();
  resetPaneView();
  applyComposeDraft();
  commitView();
}

export function sessionHandlers(): SessionHandlers {
  return {
    onBack: goBackFromPane,
    onMenu: openPaneMenu,
    onSwitch: openPaneSwitcher,
    onWorkspace: () => void openSelectedWorkspace(),
  };
}

/** Bind edge swipe-back for the page lifetime; returns its release. */
export function initSwipeBack(): () => void {
  return bindSwipeBack(goBackFromPane);
}
