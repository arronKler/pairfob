import { useDomain } from "../../shared/react/use-domain";
import { herdSessionsStore } from "./herd-session-store";

/** React snapshot for the herd-sessions domain. Owned by the herd-sessions feature. */
export function useHerdSessions() {
  return useDomain(herdSessionsStore);
}
