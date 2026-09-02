import { node } from "../lib/dom";
import { labEnabled } from "../lib/labs";
import { render } from "../paint";
import { app, haptic, resetPaneView, selectedAgent, state } from "../state";
import { enterWorkspace } from "../workspace";
import { isDesk } from "../viewport";
import { openPaneMenu, openPaneSwitcher } from "./pane-menu";
import { dropQueuedKeys, fillSession, finishSessionPaint, sessionScroll, type SessionHandlers } from "./session-view";
import { leaveAgentChat, renderAgentChat } from "./agent-chat";
import { leaveFullTerminal, renderFullTerminal } from "./full-terminal";

export { openPaneMenu, openPaneSwitcher };

export async function openSelectedWorkspace(): Promise<void> {
  if (!labEnabled("workspace")) return;
  const returnView = state.fullTerminal ? "full" : state.agentChat ? "agent" : "guided";
  if (state.fullTerminal) await leaveFullTerminal({ rememberGuided: false, paint: false });
  if (state.agentChat) leaveAgentChat({ rememberGuided: false, paint: false });
  await enterWorkspace(state.paneId, returnView);
}

export function goBackFromPane(): void {
  if (state.fullTerminal) {
    void leaveFullTerminal({ rememberGuided: false, paint: false }).then(() => {
      if (state.phase !== "live") return;
      dropQueuedKeys();
      state.screen = "home";
      resetPaneView();
      render();
    });
    return;
  }
  if (state.agentChat) {
    leaveAgentChat({ rememberGuided: false, paint: false });
    dropQueuedKeys();
    state.screen = "home";
    resetPaneView();
    render();
    return;
  }
  dropQueuedKeys();
  state.screen = "home";
  resetPaneView();
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
  app.replaceChildren(paneRoot);
  finishSessionPaint(scroll, input);
}

export function initSwipeBack(): void {
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let tracking = false;
  let engaged = false;
  let root: HTMLElement | null = null;
  app.addEventListener(
    "touchstart",
    (event) => {
      if (state.phase !== "live" || state.screen !== "pane" || isDesk()) return;
      if (event.touches.length !== 1) return;
      if ((event.target as Element | null)?.closest?.(".full-terminal-pan")) return;
      const touch = event.touches[0];
      if (touch.clientX > 28) return;
      tracking = true;
      engaged = false;
      startX = touch.clientX;
      startY = touch.clientY;
      dx = 0;
      root = app.querySelector(".pane-root");
    },
    { passive: true },
  );
  app.addEventListener(
    "touchmove",
    (event) => {
      if (!tracking || !root) return;
      const touch = event.touches[0];
      const nx = touch.clientX - startX;
      const ny = touch.clientY - startY;
      if (!engaged) {
        if (Math.abs(nx) < 14 || Math.abs(nx) < Math.abs(ny) * 1.2) return;
        if (nx <= 0) {
          tracking = false;
          return;
        }
        engaged = true;
        root.classList.add("dragging");
      }
      event.preventDefault();
      dx = Math.max(0, nx);
      root.style.transform = `translateX(${dx * 0.85}px)`;
    },
    { passive: false },
  );
  const finish = () => {
    if (!tracking || !root) {
      tracking = false;
      return;
    }
    const element = root;
    tracking = false;
    if (!engaged) return;
    engaged = false;
    element.classList.remove("dragging");
    element.style.transform = "";
    if (dx > 90) {
      haptic(8);
      goBackFromPane();
    }
    dx = 0;
  };
  app.addEventListener("touchend", finish);
  app.addEventListener("touchcancel", finish);
}
