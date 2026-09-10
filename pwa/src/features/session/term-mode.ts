import { connectionStore } from "../connection/connection-store";
import { isAgentChat, isFullTerminal, openPaneId } from "./session-store";
import { resolveTermMode, type ActiveTermMode, type TermMode } from "../../lib/terminal-mode";
import { paneTermMode, setPaneTermMode } from "../settings/preferences-store";
import { canEnterAgentChat, enterAgentChat, leaveAgentChat } from "./chat/agent-chat-controller";
import { enterFullTerminal, leaveFullTerminal } from "./full-terminal/full-terminal";
import { fullTerminalSupported } from "./full-terminal/full-terminal-loader";

export function resolvedPaneTermMode(preference: TermMode = paneTermMode(openPaneId())): ActiveTermMode {
  const p2p = connectionStore.get().sessionTransport === "p2p";
  return resolveTermMode(preference, {
    p2p,
    fullTerminalAvailable: p2p && fullTerminalSupported(),
  });
}

/** Persist one preference and move the open pane to its effective view without replaying terminal input. */
export async function selectPaneTermMode(preference: TermMode): Promise<void> {
  const paneId = openPaneId();
  if (!paneId) return;
  const active = resolvedPaneTermMode(preference);
  setPaneTermMode(paneId, preference);

  if (active === "guided") {
    if (isFullTerminal()) await leaveFullTerminal({ rememberGuided: false });
    else if (isAgentChat()) leaveAgentChat({ rememberGuided: false });
    return;
  }
  if (active === "full") {
    if (isAgentChat()) leaveAgentChat({ rememberGuided: false, paint: false });
    if (!isFullTerminal()) enterFullTerminal();
    // enterFullTerminal records an explicit choice; restore Auto when it made this decision.
    setPaneTermMode(paneId, preference);
    return;
  }
  if (canEnterAgentChat()) enterAgentChat();
}
