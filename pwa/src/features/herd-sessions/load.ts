import { liveSession } from "../computers/catalog-store";
import { beginHerdSessionRead, herdSessionReadIsCurrent, setHerdSessionList } from "./store";

/**
 * Herdr-session discovery. It sits apart from `actions.ts` so the connection
 * controller can run it after every runtime refresh (connect, reconnect,
 * foreground, switch) without importing the switch action back.
 *
 * Discovery is quiet: an old daemon (`unknown_op`), a daemon without
 * PAIRFOB_MULTI_SESSION (`unsupported`) and a transient failure all hide the
 * switcher until the next read. Both outcomes publish only if this read is still
 * the newest one on the connection it started on.
 */
export async function loadHerdSessions(): Promise<void> {
  const session = liveSession();
  if (!session?.listHerdSessions || !session.isConnected()) return;
  const token = beginHerdSessionRead(session);
  let sessions: Awaited<ReturnType<NonNullable<typeof session.listHerdSessions>>> | null;
  try {
    sessions = await session.listHerdSessions();
  } catch {
    sessions = null;
  }
  if (!herdSessionReadIsCurrent(session, token)) return;
  setHerdSessionList(session, sessions);
}
