import { useSyncExternalStore, type ReactNode } from "react";
import { langRevision, subscribeLang } from "../lib/i18n";
import { AgentChatPane } from "../features/session/chat/agent-chat";
import { SessionPane } from "../features/session/guided/session-pane";
import { FullTerminalRoute } from "../features/session/full-terminal/full-terminal-route";
import { BoardPage as BoardScreen } from "../pages/board";
import { BootScreen } from "../pages/boot";
import { ComputersScreen } from "../pages/computers/computers-page";
import { ConnectScreen } from "../pages/connect/connect-page";
import { HomePage } from "../pages/home";
import { QuotaScreen } from "../pages/quota/quota-page";
import { SettingsScreen } from "../pages/settings/settings-page";
import { WorkspaceScreen } from "../pages/workspace/screen";
import { sessionHandlers } from "../features/session/pane-actions";
import { DeskShell } from "./layout/desk";
import { getAppFrame, subscribeAppFrame, type FrameSnapshot, type SessionScroll } from "./frame";
import { useAppShell, type ShellLayout } from "./shell";

/**
 * The mounted application.
 *
 * One `<App/>` is mounted for the lifetime of the page and composes pages
 * declaratively from the frame the commit pipeline prepared. A navigation is a
 * domain action plus a commit; nothing calls `root.render(screen)` any more, and
 * the shell classes belong to this component's lifecycle.
 *
 * Routes import the actual page/feature they show: pages under `pages/`, the
 * session/chat presentations under `features/session`. The desk shell lives in
 * `app/layout/desk.tsx` and the boot page in `pages/boot`.
 *
 * Typed shell inputs (busy, font) update the prepared layout on the frame
 * without a second `prepareFrame`, so this component does not need a global
 * domain subscription or a manual root repaint.
 */

/** Stable handler identity: these are module functions, not per-render closures. */
const handlers = sessionHandlers();

const NO_SCROLL: SessionScroll = { top: 0, left: 0, bottom: true };

export function App() {
  const frame = useSyncExternalStore(subscribeAppFrame, getAppFrame);
  // Locale composition boundary: every mounted copy — the rail beside the main
  // column, the quota/computers labels, the boot screen — re-renders on the
  // scalar language revision through this one subscription. Copy changes never
  // navigate and never repaint imperatively; nothing else reads the revision.
  useSyncExternalStore(subscribeLang, langRevision);
  useAppShell(frame.layout);

  const layout = frame.layout;
  if (!layout) return null;
  return <>{pageFor(layout, frame)}</>;
}

function scrollOf(frame: FrameSnapshot): SessionScroll {
  return frame.scroll ?? NO_SCROLL;
}

/** The page for a composition. Pure: it only reads the prepared frame. */
export function pageFor(layout: ShellLayout, frame: FrameSnapshot): ReactNode {
  switch (layout.mode) {
    case "boot":
      return <BootScreen />;
    case "connect":
      return <ConnectScreen />;
    case "pick":
      return <ComputersScreen />;
    case "workspace":
      return <WorkspaceScreen />;
    case "board":
      return <BoardScreen />;
    case "settings":
      return <SettingsScreen />;
    case "quota":
      return <QuotaScreen />;
    case "computers":
      return <ComputersScreen />;
    case "home":
      return <HomePage />;
    case "desk":
      return <DeskShell deskPage={layout.deskPage}>{deskChild(layout, frame)}</DeskShell>;
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
  if (layout.deskChild === "chat") return <AgentChatPane includeBack={false} handlers={handlers} />;
  if (layout.deskChild === "session") {
    return <SessionPane includeBack={false} handlers={handlers} scroll={scrollOf(frame)} />;
  }
  return undefined;
}
