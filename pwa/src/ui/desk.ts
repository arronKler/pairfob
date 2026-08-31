import { node } from "../lib/dom";
import { app, selectedAgent, state } from "../state";
import { fillAgentChat } from "./agent-chat";
import { renderRail } from "./home";
import { sessionHandlers } from "./pane";
import { fillSession, finishSessionPaint, sessionScroll } from "./session-view";
import { fillComputers } from "./computers";
import { fillSettings } from "./settings";

export function renderDesk(): void {
  const scroll = sessionScroll();
  const root = document.createDocumentFragment();
  root.append(renderRail());
  const main = node("section", "main");
  let input: HTMLTextAreaElement | undefined;
  if (state.screen === "settings") {
    main.classList.add("main-settings");
    fillSettings(main, true);
  } else if (state.screen === "computers") {
    main.classList.add("main-settings");
    fillComputers(main, true);
  } else {
    const selected = selectedAgent();
    const handlers = sessionHandlers();
    if (selected && state.paneId && state.agentChat) {
      const chat = node("div", "pane-root agent-chat-root");
      input = fillAgentChat(chat, handlers.onBack, false, handlers.onMenu, handlers.onSwitch);
      main.append(chat);
    } else if (selected && state.paneId) {
      const pane = node("div", "pane-root");
      input = fillSession(pane, selected, false, handlers);
      main.append(pane);
    } else {
      const empty = node("div", "main-empty");
      empty.append(node("p", "empty-title", "选择一个会话"), node("p", "empty-sub", "从左侧的列表点一个，这里会显示电脑上的终端画面。"));
      main.append(empty);
    }
  }
  root.append(main);
  app.replaceChildren(root);
  finishSessionPaint(scroll, input);
}
