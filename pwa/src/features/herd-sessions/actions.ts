import { track } from "../../lib/telemetry";
import { liveSession } from "../computers/catalog-store";
import { currentScreen, goToScreen } from "../../app/navigation-store";
import { commitView } from "../../app/host";
import { parkComposeView } from "../session/drafts/compose-drafts";
import { refreshFromSession } from "../connection/controller";
import { currentHerdSession, setCurrentHerdSession, setHerdSessions, setHerdSessionsUnsupported } from "./herd-session-store";

/**
 * Discover the Herdr sessions the connected daemon can see. Any failure -
 * ProtocolError "unknown_op" (an old daemon that predates ListSessions),
 * "unsupported" (a daemon that has not opted into PAIRFOB_MULTI_SESSION), or
 * anything else (a transient disconnect) - collapses to the same "not
 * supported right now" state. This is a discovery call for an optional
 * switcher, not a user-requested action, so none of those cases should ever
 * surface an error toast; a later successful call (e.g. after reconnecting)
 * recovers on its own.
 */
export async function loadHerdSessions(): Promise<void> {
  const session = liveSession();
  if (!session?.listSessions) {
    setHerdSessionsUnsupported();
    return;
  }
  try {
    const { sessions } = await session.listSessions();
    setHerdSessions(sessions);
  } catch {
    setHerdSessionsUnsupported();
  }
}

/**
 * Switch which Herdr session subsequent session-scoped RPCs target. Unlike
 * `switchComputer`, this never re-pairs: it is the same daemon connection,
 * just pointed at a different socket on its side. A pane open from the
 * outgoing session has no meaning in the new one, so leaving the pane screen
 * mirrors `openComputers`'s park-then-navigate step, minus the return
 * ceremony - there is nothing to come back to.
 */
export function switchHerdSession(name: string | null): void {
  const session = liveSession();
  if (!session?.setSession || currentHerdSession() === name) return;
  const onPane = currentScreen() === "pane";
  if (onPane) parkComposeView();
  session.setSession(name);
  setCurrentHerdSession(name);
  track("pwa_switch_herd_session");
  if (onPane) goToScreen("board");
  commitView();
  void refreshFromSession();
}
