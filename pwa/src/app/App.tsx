import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { bindSystemBack } from "./system-back";
import { langRevision, subscribeLang } from "../lib/i18n";
import { BootScreen } from "../pages/boot/boot-screen";
import { ReadingFrame } from "../pages/boot/reading-frame";
import { BootRecovery } from "../pages/boot/boot-recovery";
import { ConnectScreen } from "../pages/connect/connect-page";
import { useBootBlocked } from "../features/connection/hooks";
import { TabBarView } from "./layout/tab-bar-view";
import { getAppFrame, subscribeAppFrame, type FrameSnapshot } from "./frame";
import { useAppShell, type ShellLayout } from "./shell";
import { connectedPresentation, requireConnectedPresentation, subscribePresentation } from "./presentation";

/** One App/root for the page lifetime; modules load before connected navigation. */
export function App() {
  useEffect(bindSystemBack, []);
  const frame = useSyncExternalStore(subscribeAppFrame, getAppFrame);
  const connected = useSyncExternalStore(subscribePresentation, connectedPresentation);
  useSyncExternalStore(subscribeLang, langRevision);
  useAppShell(frame.layout);
  const layout = frame.layout;
  if (!layout) return null;
  const Tabs = connected?.TabBar ?? TabBarView;
  const Prompt = connected?.NotificationPrompt;
  return <>{pageFor(layout, frame)}{layout.shell.tabs ? <Tabs mode={layout.mode} /> : null}{Prompt && <Prompt />}</>;
}

function ReadingBoot() {
  const bootBlocked = useBootBlocked();
  return bootBlocked ? <div className="page herd-page boot-shell"><BootRecovery block={bootBlocked} /></div> : <ReadingFrame />;
}

/** Pure composition of the synchronously prepared frame. */
export function pageFor(layout: ShellLayout, frame: FrameSnapshot): ReactNode {
  if (layout.mode === "connect") return <ConnectScreen />;
  const connected = connectedPresentation();
  if (connected) return connected.pageFor(layout, frame);
  if (layout.mode === "boot") return layout.shell.booting ? <BootScreen /> : <ReadingBoot />;
  return requireConnectedPresentation().pageFor(layout, frame);
}
