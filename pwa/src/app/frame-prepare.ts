import { currentViewIncarnation } from "../features/session/drafts/compose-drafts";
import { prepareFullTerminal } from "../features/session/full-terminal/full-terminal";
import { presentHerdView } from "../pages/home/herd-bridge";
import { prepareSessionPaint } from "../features/session/guided/view";
import {
  adoptPreparedFrame, displayedSession, notifySessionOwnerPreparer,
  type FrameSnapshot,
} from "./frame";
import { refreshLayout } from "./layout-store";
import { liveSession } from "../features/computers/catalog-store";
import { openPaneId } from "../features/session/session-store";
import { detach } from "../shared/model/domain-store";

/**
 * Imperative frame preparation.
 *
 * The commit pipeline calls this before React renders: herd attention is consumed
 * once, the guided pane's scroll is read from the outgoing DOM, and the session
 * description is handed to its owner. The published snapshot itself lives in
 * `frame.ts`.
 */
export function prepareFrame(): FrameSnapshot {
  const layout = refreshLayout();
  const desk = layout.mode === "desk";
  const showsHerd = layout.mode === "home" || desk;
  const showsGuided = layout.mode === "pane" || layout.deskChild === "session";
  // Home and its desktop rail subscribe to their feature-owned view and attention.
  // Preparation still consumes attention once, before either route renders.
  if (showsHerd) presentHerdView();
  const scroll = showsGuided ? prepareSessionPaint() : null;
  const kind = displayedSession(layout);
  const described = kind
    ? { kind, paneId: openPaneId(), incarnation: currentViewIncarnation() }
    : null;
  const session = described ? detach(described) : null;
  const sessionOwner = session ? liveSession() : null;
  if (described) notifySessionOwnerPreparer(Object.freeze(detach(described)), sessionOwner);
  if (layout.mode === "full-terminal") {
    // The full-terminal screen is composed declaratively by <App/> via
    // FullTerminalRoute. Preparation (document mode, renderer reset, status,
    // initial view) runs here before React renders; it creates no screen.
    prepareFullTerminal();
  }

  // A preparer may write ordinary shell fields (font, busy) without requesting
  // another composition pass. Adopt the derived layout as it stands now so the
  // first notification already matches the shell.
  return adoptPreparedFrame({
    layout: refreshLayout(),
    scroll,
    session,
    sessionOwner,
  });
}
