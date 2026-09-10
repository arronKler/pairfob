import type { LiveSession } from "../../lib/protocol/client";
import { bindSessionOwnerFromLive, bindSessionOwnerFromPreparedFrame } from "./bind-live";
import type { SessionOwner } from "./ports";

/**
 * App / desk / pane controllers call this once before createElement of the
 * displayed session child. Never from a React render function.
 *
 * The App session-owner seam calls the bound form with the frozen frame
 * description and the live handle that commit prepared, so the adoption binds
 * exactly the values the frame published instead of re-reading a replacement
 * after a later publication. The no-argument form keeps the controller
 * transition contract for callers that bind directly from the live domains.
 */
export function registerSessionView(
  session?: Readonly<{ paneId: string; incarnation: number }>,
  owner?: LiveSession | null,
): SessionOwner {
  if (session) return bindSessionOwnerFromPreparedFrame(session, owner ?? null);
  return bindSessionOwnerFromLive();
}
