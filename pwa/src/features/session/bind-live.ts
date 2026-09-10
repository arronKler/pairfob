import type { LiveSession } from "../../lib/protocol/client";
import { liveSession } from "../computers/catalog-store";
import { openPaneId } from "./session-store";
import { currentViewIncarnation } from "./drafts/state-drafts";
import { adoptChatDetailsOwner } from "./chat/details";
import { adoptSessionOwner, type SessionOwner } from "./identity";

/**
 * Bind owner from domain selectors. liveSession() is the opaque handle
 * (identity, never a copy). Do not call from React render: this allocates
 * WeakMap session ids and resets shared details when the owner key changes.
 * Call from a controller transition before JSX: renderDesk, renderAgentChat,
 * prepareSessionPaint, paintFullTerminalScreen.
 */
export function bindSessionOwnerFromLive(): SessionOwner {
  const owner = adoptSessionOwner({
    session: liveSession(),
    paneId: openPaneId(),
    viewIncarnation: currentViewIncarnation(),
  });
  adoptChatDetailsOwner(owner.key);
  return owner;
}

/**
 * Bind owner from the prepared frame description the App seam supplied.
 *
 * The commit pipeline describes the displayed session before React renders —
 * pane, view incarnation and the live handle it prepared — and hands that frozen
 * description over. This adoption binds exactly those values instead of re-reading
 * the live domains, so a callback that runs after a later publication cannot
 * capture a replacement session. Do not call from React render for the same
 * reasons as the live binding above.
 */
export function bindSessionOwnerFromPreparedFrame(
  session: Readonly<{ paneId: string; incarnation: number }>,
  owner: LiveSession | null,
): SessionOwner {
  const bound = adoptSessionOwner({
    session: owner,
    paneId: session.paneId,
    viewIncarnation: session.incarnation,
  });
  adoptChatDetailsOwner(bound.key);
  return bound;
}
