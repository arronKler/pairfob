import { liveSession } from "../computers/catalog-store";
import { capabilityEnabled } from "../operations/capabilities-store";
import type { HerdSessionSummary } from "../../lib/protocol/session-types";
import { beginHerdSessionRead, herdSessionReadIsCurrent, setHerdSessionList } from "./store";

/**
 * Herdr-session discovery. It sits apart from `actions.ts` so the connection
 * controller can run it after every runtime refresh (connect, reconnect,
 * foreground, switch) without importing the switch action back.
 *
 * GetConfig's list_sessions grant is authoritative; absent or false clears
 * this connection's list without probing. A transient failure also hides it
 * until the next read. Only the newest read on its connection may publish.
 */
export async function loadHerdSessions(): Promise<void> {
  const session = liveSession();
  if (!session) return;
  const token = beginHerdSessionRead(session);
  if (!capabilityEnabled("list_sessions") || !session.listHerdSessions) {
    setHerdSessionList(session, null);
    return;
  }
  if (!session.isConnected()) return;
  let sessions: HerdSessionSummary[] | null;
  try {
    sessions = await session.listHerdSessions();
  } catch {
    sessions = null;
  }
  if (!herdSessionReadIsCurrent(session, token)) return;
  setHerdSessionList(session, sessions);
}
