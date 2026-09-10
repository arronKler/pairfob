import { useDomain } from "../../shared/react/use-domain";
import { composeStore } from "./compose-store";
import { chatStore } from "./chat/trace-store";
import { sessionStore } from "./session-store";

/** React snapshots for the session/compose/chat domains. Owned by the session feature. */
export function useSession() {
  return useDomain(sessionStore);
}

export function useCompose() {
  return useDomain(composeStore);
}

export function useChat() {
  return useDomain(chatStore);
}
