import { createElement } from "react";
import { selectedAgent, state } from "../state";
import { sessionHandlers } from "./pane";
import { prepareSessionPaint } from "./session/view";
import { AgentChatPane } from "./react/agent-chat";
import { DeskScreen } from "./react/desk";
import { prepareHerdView } from "./react/home";
import { SessionPane } from "./react/session-pane";
import { renderReactScreen } from "./react/root";

export function renderDesk(): void {
  const pane = selectedAgent() && state.paneId;
  const page = state.screen === "settings" || state.screen === "quota" || state.screen === "computers";
  const children = pane && !page
    ? state.agentChat
      ? createElement(AgentChatPane, { includeBack: false, handlers: sessionHandlers() })
      : createElement(SessionPane, { includeBack: false, handlers: sessionHandlers(), scroll: prepareSessionPaint() })
    : undefined;
  renderReactScreen(createElement(DeskScreen, { view: prepareHerdView(), children }));
}
