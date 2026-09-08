import { node } from "../lib/dom";
import { render } from "../paint";
import { applyComposeDraft, parkComposeView } from "../compose-drafts";
import { app, leavePaneScreen, resetPaneView, selectedAgent, state } from "../state";
import { enterWorkspace } from "../workspace";
import { armSwipeHint, initSwipeBack as bindSwipeBack } from "./pane-swipe";
import { morphingPane, nextTransition, queuedKind, shareOpening } from "./transition";
import { openPaneMenu, openPaneSwitcher } from "./pane-menu";
import { dropQueuedKeys, fillSession, finishSessionPaint, sessionScroll, type SessionHandlers } from "./session-view";
import { leaveAgentChat, renderAgentChat } from "./agent-chat";
import { leaveFullTerminal, renderFullTerminal } from "./full-terminal";

export { openPaneMenu, openPaneSwitcher };

export async function openSelectedWorkspace(): Promise<void> {
  parkComposeView();
  const returnView = state.fullTerminal ? "full" : state.agentChat ? "agent" : "guided";
  if (state.fullTerminal) await leaveFullTerminal({ rememberGuided: false, paint: false });
  if (state.agentChat) leaveAgentChat({ rememberGuided: false, paint: false });
  await enterWorkspace(state.paneId, returnView);
}

export function goBackFromPane(): void {
  // Every path out of here lands on the screen the pane was opened from. Coming
  // from the board, the pane collapses back into its tile instead of sliding off.
  if (state.boardReturn) {
    shareOpening(app.querySelector<HTMLElement>(".pane-root"));
    nextTransition("expand", state.paneId);
  } else nextTransition("pop", state.paneId);
  parkComposeView();
  if (state.fullTerminal) {
    void leaveFullTerminal({ rememberGuided: false, paint: false }).then(() => {
      if (state.phase !== "live") return;
      dropQueuedKeys();
      leavePaneScreen();
      resetPaneView();
      applyComposeDraft();
      render();
    });
    return;
  }
  if (state.agentChat) {
    leaveAgentChat({ rememberGuided: false, paint: false });
    dropQueuedKeys();
    leavePaneScreen();
    resetPaneView();
    applyComposeDraft();
    render();
    return;
  }
  dropQueuedKeys();
  leavePaneScreen();
  resetPaneView();
  applyComposeDraft();
  render();
}

export function sessionHandlers(): SessionHandlers {
  return {
    onBack: goBackFromPane,
    onMenu: openPaneMenu,
    onSwitch: openPaneSwitcher,
    onWorkspace: () => void openSelectedWorkspace(),
  };
}

export function renderPane(): void {
  if (state.fullTerminal) {
    renderFullTerminal(goBackFromPane, () => void openSelectedWorkspace(), openPaneMenu);
    return;
  }
  if (state.agentChat) {
    renderAgentChat(goBackFromPane, () => void openSelectedWorkspace(), openPaneMenu, openPaneSwitcher);
    return;
  }
  const scroll = sessionScroll();
  const paneRoot = node("div", "pane-root");
  const input = fillSession(paneRoot, selectedAgent(), true, sessionHandlers());
  if (queuedKind() === "expand" && morphingPane() === state.paneId) shareOpening(paneRoot);
  armSwipeHint(paneRoot);
  app.replaceChildren(paneRoot);
  finishSessionPaint(scroll, input);
}

export function initSwipeBack(): void {
  bindSwipeBack(goBackFromPane);
}
