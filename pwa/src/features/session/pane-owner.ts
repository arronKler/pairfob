/**
 * Which terminal a pane id currently belongs to.
 *
 * A pane id is only unique inside one computer's runtime: another computer can
 * hand the same id to a different terminal, and a runtime restart reuses it.
 * Anything that remembers something about a pane across visits (the agent trace
 * viewport, the last screen read) keys it on this tuple, so a remembered screen
 * is never shown for an occupant that did not produce it.
 */
import { currentDaemonId, liveSession } from "../computers/catalog-store";
import { liveAgents } from "../dashboard/catalog-store";

/** Empty when there is no live session, or no pane open. */
export function paneOwnerKey(paneId: string): string {
  if (!paneId || !liveSession()) return "";
  const agent = liveAgents().find((item) => item.paneId === paneId);
  return JSON.stringify([
    currentDaemonId(),
    agent?.runtimeSession || "",
    paneId,
    agent?.terminalId || "",
    agent?.agentInstanceId || "",
  ]);
}
