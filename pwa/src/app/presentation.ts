import type { ReactNode } from "react";
import type { FrameSnapshot, SessionScroll } from "./frame";
import type { ShellLayout } from "./shell";
import type { LayoutMode } from "./layout";

/** Feature code is ready before a connected composition enters the synchronous commit. */
export type ConnectedPresentation = {
  pageFor(layout: ShellLayout, frame: FrameSnapshot): ReactNode;
  TabBar(props: { mode: LayoutMode }): ReactNode;
  NotificationPrompt?: () => ReactNode;
  consumeHerdAttention(): void;
  prepareSessionPaint(): SessionScroll;
  prepareFullTerminal(): void;
  systemBackAction(): (() => void | Promise<void>) | null;
  subscribeBack(listener: () => void): () => void;
};
let connected: ConnectedPresentation | null = null;
const listeners = new Set<() => void>();
export const connectedPresentation = () => connected;
export function subscribePresentation(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function installConnectedPresentation(value: ConnectedPresentation): void {
  if (connected === value) return;
  connected = value;
  for (const listener of [...listeners]) listener();
}
export function requireConnectedPresentation(): ConnectedPresentation {
  if (!connected) throw new Error("Connected features must be loaded before navigation");
  return connected;
}
