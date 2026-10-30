import "../connected.scss";
import { pageFor, TabBar } from "./connected-pages";
import { systemBackAction, subscribeConnectedBack } from "./connected-back";
import { prepareFullTerminal } from "../features/session/full-terminal/full-terminal";
import { consumeHerdAttention } from "../pages/home/herd-bridge";
import { prepareSessionPaint } from "../features/session/guided/view";
import type { ConnectedPresentation } from "./presentation";
import { NotificationPrompt } from "../pages/settings/notification-prompt";

/** Ready as a unit before entering the first connected composition. */
export const presentation: ConnectedPresentation = {
  NotificationPrompt,
  pageFor, TabBar, prepareFullTerminal, consumeHerdAttention, prepareSessionPaint,
  systemBackAction, subscribeBack: subscribeConnectedBack,
};
export { registerSessionView } from "../features/session/register";
export { preloadFullTerminalXterm } from "../features/session/full-terminal/full-terminal-loader";
export { handleFullTerminalVisibility } from "../features/session/full-terminal/full-terminal";
export { initSwipeBack } from "../features/session/pane-actions";
export { restoreAgentReadingPosition } from "../features/session/chat/agent-chat-controller";
export { revealCaretRow, stickBottom } from "../features/session/guided/term";
export { resumeComputer, switchComputer } from "../features/computers/actions";
export {
  reconnectLiveSessions, recoverVisibleSession, retireAgentTraceRefreshes, setLiveNetworkAvailable,
  startPolling, stopPolling, refreshFromSession,
} from "../features/connection/controller";
export { bindPaneKeys } from "./pane-keys";
