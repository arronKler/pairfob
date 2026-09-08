import { createElement } from "react";
import { renderReactScreen } from "./react/root";
import { AgentChatPane } from "./react/agent-chat";

export { canEnterAgentChat, enterAgentChat, leaveAgentChat, patchAgentChat, refreshAgentTrace, restoreAgentTrace, stickAgentStream } from "./agent-chat-controller";

export function renderAgentChat(onBack: () => void, onWorkspace: () => void, onMenu: () => void, onSwitch: () => void): void {
  renderReactScreen(createElement(AgentChatPane, { includeBack: true, handlers: { onBack, onWorkspace, onMenu, onSwitch } }));
}
