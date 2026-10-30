import { useSyncExternalStore } from "react";
import { useDomain } from "../../shared/react/use-domain";
import { composeStore } from "./compose-store";
import { chatStore } from "./chat/trace-store";
import {
  isAgentChat, isFullTerminal, openPaneId, paneFollow, paneUnread, sessionStore, termSelect,
} from "./session-store";

/**
 * React snapshots for the session/compose/chat domains. Owned by the session feature.
 *
 * These are the whole domain: any field — a buffer, a keystroke, a row pick —
 * repaints the caller. A control that reads one field or one mode takes the
 * narrow read below instead.
 */
export function useSession() {
  return useDomain(sessionStore);
}

export function useCompose() {
  return useDomain(composeStore);
}

export function useChat() {
  return useDomain(chatStore);
}

/**
 * Narrow session reads for the typing surface.
 *
 * The session domain publishes a buffer, a read flag or a row selection at a
 * time. A control that names the open pane, or follows one view mode, must not
 * repaint for the rest: these subscribe with a scalar (or a stable card) so an
 * unrelated publish bails out in `useSyncExternalStore`.
 */
export function usePaneId(): string {
  return useSyncExternalStore(sessionStore.subscribe, openPaneId, openPaneId);
}

export function usePaneTermSelect(): boolean {
  return useSyncExternalStore(sessionStore.subscribe, termSelect, termSelect);
}

export function usePaneFollow(): boolean {
  return useSyncExternalStore(sessionStore.subscribe, paneFollow, paneFollow);
}

export function usePaneUnread(): boolean {
  return useSyncExternalStore(sessionStore.subscribe, paneUnread, paneUnread);
}

export function useAgentChatMode(): boolean {
  return useSyncExternalStore(sessionStore.subscribe, isAgentChat, isAgentChat);
}

export function useFullTerminalMode(): boolean {
  return useSyncExternalStore(sessionStore.subscribe, isFullTerminal, isFullTerminal);
}

/** The open pane's herd card lives with the dashboard domain; re-exported for this feature's screens. */
export { useAgentCard } from "../dashboard/hooks";

/** One chat field, as the value it is: unrelated transcript publishes bail out. */
export function useChatField<T>(select: (chat: ReturnType<typeof chatStore.get>) => T): T {
  return useSyncExternalStore(
    chatStore.subscribe,
    () => select(chatStore.get()),
    () => select(chatStore.get()),
  );
}

const composeLiveOf = () => composeStore.get().composeLive;
const composeFocusedOf = () => composeStore.get().composeFocused;
const composeDraftOf = () => composeStore.get().composeDraft;

/**
 * One compose field. The compose domain publishes the draft on every keystroke;
 * a control that only follows the live/batch choice or the field's focus must
 * not repaint with the text it does not draw.
 */
export function useComposeLive(): boolean {
  return useSyncExternalStore(composeStore.subscribe, composeLiveOf, composeLiveOf);
}

export function useComposeFocused(): boolean {
  return useSyncExternalStore(composeStore.subscribe, composeFocusedOf, composeFocusedOf);
}

/** The field's text as a value: what the send button and the line count follow. */
export function useComposeDraft(): string {
  return useSyncExternalStore(composeStore.subscribe, composeDraftOf, composeDraftOf);
}
