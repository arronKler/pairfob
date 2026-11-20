import { type ReactNode } from "react";
import { AgentChatPane } from "../features/session/chat/agent-chat";
import { SessionPane } from "../features/session/guided/session-pane";
import { FullTerminalRoute } from "../features/session/full-terminal/full-terminal-route";
import { BoardPage as BoardScreen } from "../pages/board";
import { BootScreen, BootShell, UnreachableDesk, UnreachableShell } from "../pages/boot";
import { ComputersScreen } from "../pages/computers/computers-page";
import { ConnectScreen } from "../pages/connect/connect-page";
import { HomePage } from "../pages/home";
import { QuotaScreen } from "../pages/quota/quota-page";
import { SettingsScreen } from "../pages/settings/settings-page";
import { WorkspaceScreen } from "../pages/workspace/screen";
import { sessionHandlers } from "../features/session/pane-actions";
import { leaveWorkspaceInspector } from "../features/workspace/inspector";
import { DesktopRoute } from "./desktop-route";
import { DeskShell } from "./layout/desk";
export { TabBar } from "./layout/tab-bar";
import { type FrameSnapshot, type SessionScroll } from "./frame";
import { type ShellLayout } from "./shell";


/** Stable handler identity: these are module functions, not per-render closures. */
const handlers = sessionHandlers();
/** With the list hidden behind the inspector, the session's back button returns to it. */
const railHiddenHandlers = { ...handlers, onBack: leaveWorkspaceInspector };

const NO_SCROLL: SessionScroll = { top: 0, left: 0, bottom: true };

function scrollOf(frame: FrameSnapshot): SessionScroll {
  return frame.scroll ?? NO_SCROLL;
}

/** The page for a composition. Pure: it only reads the prepared frame. */
export function pageFor(layout: ShellLayout, frame: FrameSnapshot): ReactNode {
  switch (layout.mode) {
    case "boot":
      // Off the phone, a boot inside the desk shell is the "cannot reach" page's own retry.
      return layout.shell.booting ? <BootScreen /> : layout.shell.desk ? <UnreachableDesk retrying /> : <BootShell />;
    case "connect":
      return <ConnectScreen />;
    case "pick":
      if (!layout.shell.unreachable) return <ComputersScreen />;
      return layout.shell.desk ? <UnreachableDesk /> : <UnreachableShell />;
    case "workspace":
      return <WorkspaceScreen />;
    case "board":
      return <BoardScreen />;
    case "desktop":
      return <DesktopRoute />;
    case "settings":
      return <SettingsScreen />;
    case "quota":
      return <QuotaScreen />;
    case "computers":
      return <ComputersScreen />;
    case "home":
      return <HomePage />;
    case "desk":
      return <DeskShell deskPage={layout.deskPage} inspector={layout.shell.inspector} railHidden={layout.shell.railHidden}
        onReturn={layout.deskReturn === "board" ? handlers.onBack : undefined}>
        {deskChild(layout, frame)}
      </DeskShell>;
    case "chat":
      return <AgentChatPane includeBack handlers={handlers} />;
    case "pane":
      return <SessionPane includeBack handlers={handlers} scroll={scrollOf(frame)} />;
    case "full-terminal":
      // Declarative composition: the feature route assembles FullTerminalScreen
      // with the stable session handlers and controller ports. Engine attach is
      // owned by FullTerminalHost's layout effect; preparation already ran.
      return <FullTerminalRoute />;
  }
}

function deskChild(layout: ShellLayout, frame: FrameSnapshot): ReactNode {
  // The desk session has no back of its own; it gains one only while the list
  // has given its column to the inspector.
  const back = layout.shell.railHidden;
  const own = back ? railHiddenHandlers : handlers;
  if (layout.deskChild === "full") return <FullTerminalRoute includeBack={back} onBack={back ? leaveWorkspaceInspector : undefined} />;
  if (layout.deskChild === "chat") return <AgentChatPane includeBack={back} handlers={own} />;
  if (layout.deskChild === "session") {
    return <SessionPane includeBack={back} handlers={own} scroll={scrollOf(frame)} />;
  }
  return undefined;
}
