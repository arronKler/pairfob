import { appRoot } from "../../app/dom-root";
import { commitView } from "../../app/host";
import { phase } from "../connection/connection-store";
import { boardReturn } from "../board/layout-store";
import { isAgentChat, isFullTerminal, openPaneId, resetPaneView } from "./session-store";
import { currentScreen, leavePaneScreen } from "../../app/navigation-store";
import { applyComposeDraft, parkComposeView } from "./drafts/compose-drafts";
import { enterWorkspace } from "../../features/workspace";
import { initSwipeBack as bindSwipeBack } from "./guided/pane-swipe";
import { keyboardOpen, navigateWithTransition, nextTransition, settleKeyboard, shareOpening } from "../../app/transition";
import { openPaneMenu } from "./guided/pane-menu";
import { dropQueuedKeys } from "../../features/session/guided/keys";
import { type SessionHandlers } from "../../features/session/guided/view";
import { leaveAgentChat } from "./chat/agent-chat-controller";
import { leaveFullTerminal } from "./full-terminal/full-terminal";

/**
 * Pane navigation actions.
 *
 * The intents a reader can have on the pane screen — back, workspace, menu —
 * that `<App/>` hands to the session, chat and terminal routes. They use named
 * domain readers/actions and the App commit seam. The header identity is
 * display-only, so nothing here opens the session switcher any more.
 */

export { openPaneMenu };

export async function openSelectedWorkspace(): Promise<void> {
  parkComposeView();
  const returnView = isFullTerminal() ? "full" : isAgentChat() ? "agent" : "guided";
  if (isFullTerminal()) await leaveFullTerminal({ rememberGuided: false, paint: false });
  if (isAgentChat()) leaveAgentChat({ rememberGuided: false, paint: false });
  await enterWorkspace(openPaneId(), returnView);
}

/**
 * Leave the pane for the screen it was opened from. From the board the pane
 * collapses back into its tile; from the list it shrinks back into its card
 * (`navigateWithTransition`, which skips the flight when the card is gone or
 * off screen). `gesture` is the edge swipe: the finger already moved the page,
 * so it lands with the ordinary pop and no second motion.
 *
 * Resolves once the list is committed. Without an open keyboard or a native
 * view transition that happens before this returns.
 */
export function goBackFromPane(options: { gesture?: boolean } = {}): Promise<void> {
  const paneId = openPaneId();
  const morph = !options.gesture && !boardReturn();
  // An open keyboard resizes the visual viewport as it leaves. Let it go first
  // so the page captured for the transition is the settled one.
  if (morph && keyboardOpen()) {
    return settleKeyboard().then(() => {
      if (currentScreen() === "pane" && openPaneId() === paneId) return leavePane(paneId, morph);
    });
  }
  return leavePane(paneId, morph);
}

function leavePane(paneId: string, morph: boolean): Promise<void> {
  if (boardReturn()) {
    shareOpening(appRoot().querySelector<HTMLElement>(".pane-root"));
    nextTransition("expand", paneId);
  } else nextTransition("pop", paneId);
  const land = (): Promise<void> => navigateWithTransition(commitView, morph ? { direction: "close", paneId } : null);
  parkComposeView();
  if (isFullTerminal()) {
    return leaveFullTerminal({ rememberGuided: false, paint: false }).then(() => {
      if (phase() !== "live") return;
      dropQueuedKeys();
      leavePaneScreen();
      resetPaneView();
      applyComposeDraft();
      return land();
    });
  }
  if (isAgentChat()) leaveAgentChat({ rememberGuided: false, paint: false });
  dropQueuedKeys();
  leavePaneScreen();
  resetPaneView();
  applyComposeDraft();
  return land();
}

export function sessionHandlers(): SessionHandlers {
  return {
    onBack: () => void goBackFromPane(),
    onMenu: openPaneMenu,
    onWorkspace: () => void openSelectedWorkspace(),
  };
}

/** Bind edge swipe-back for the page lifetime; returns its release. */
export function initSwipeBack(): () => void {
  return bindSwipeBack(() => void goBackFromPane({ gesture: true }));
}
