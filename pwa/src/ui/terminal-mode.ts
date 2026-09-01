import { resolveTermMode, type ActiveTermMode, type TermMode } from "../lib/terminal-mode";
import { paneTermMode, setPaneTermMode, state } from "../state";
import { canEnterAgentChat, enterAgentChat, leaveAgentChat } from "./agent-chat";
import { enterFullTerminal, leaveFullTerminal } from "./full-terminal";
import { fullTerminalSupported } from "./full-terminal-loader";

export function resolvedPaneTermMode(preference: TermMode = paneTermMode(state.paneId)): ActiveTermMode {
  const p2p = state.sessionTransport === "p2p";
  return resolveTermMode(preference, {
    p2p,
    fullTerminalAvailable: p2p && fullTerminalSupported(),
  });
}

/** Persist one preference and move the open pane to its effective view without replaying terminal input. */
export async function selectPaneTermMode(preference: TermMode): Promise<void> {
  const paneId = state.paneId;
  if (!paneId) return;
  const active = resolvedPaneTermMode(preference);
  setPaneTermMode(paneId, preference);

  if (active === "guided") {
    if (state.fullTerminal) await leaveFullTerminal({ rememberGuided: false });
    else if (state.agentChat) leaveAgentChat({ rememberGuided: false });
    return;
  }
  if (active === "full") {
    if (state.agentChat) leaveAgentChat({ rememberGuided: false, paint: false });
    if (!state.fullTerminal) enterFullTerminal();
    // enterFullTerminal records an explicit choice; restore Auto when it made this decision.
    setPaneTermMode(paneId, preference);
    return;
  }
  if (canEnterAgentChat()) enterAgentChat();
}
