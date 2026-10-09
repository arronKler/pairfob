import { commitView } from "../../app/host";
import { currentScreen, navigationStore } from "../../app/navigation-store";
import { isRoomy } from "../../app/viewport";
import { adoptDiffNoteScope } from "../../lib/diff-notes";
import type { LiveSession } from "../../lib/protocol/client";
import { computersStore, liveSession } from "../computers/catalog-store";
import { leaveAgentChat } from "../session/chat/agent-chat-controller";
import { parkComposeView } from "../session/drafts/compose-drafts";
import { leaveFullTerminal } from "../session/full-terminal/full-terminal";
import { isAgentChat, isFullTerminal, openPaneId, sessionStore } from "../session/session-store";
import { enterWorkspace, showWorkspaceBeside } from "./actions";
import { inspectorOpen, setInspectorOpen } from "./inspector-store";
import { focusEnteringColumn, focusLeaving } from "./opener-focus";
import { beginLeave } from "./store";
import { dismissFilesDialogs } from "./surface-dialogs";

/**
 * The inspector's lifetime beside the desk session.
 *
 * Opening binds the workspace model to the open pane without navigating; while
 * it is open it follows the session: another pane rebinds it, and losing the
 * pane or the computer closes it. Closing gives back exactly what opening took
 * and never touches the session view.
 *
 * Open is the reader's choice, not a description of the layout. A window too
 * narrow for the column (a rotated tablet, a dragged edge) only parks it: the
 * model is released, the files button opens the workspace screen as it does on
 * any narrow layout, and the column returns with the room, on the tab, file or
 * diff the model remembers for that pane. What ends the choice is the reader
 * closing the column, the session leaving the page (the list, settings, the
 * board), the pane going away, or the computer changing.
 *
 * Whenever the column stops showing a pane's files (parked, closed, or bound
 * to another pane), the menus and questions opened from its list are put away
 * with it (`surface-dialogs`): nothing of the files UI is left on the page to
 * ask about a file whose list is not shown. A note in progress is not among
 * them and is kept (`note-drafts`).
 */

/** What the inspector bound the model to; null while the model is not its own. */
let bound: { session: LiveSession; paneId: string } | null = null;
let stopFollowing: (() => void) | null = null;

function release(): void {
  if (!bound) return;
  bound = null;
  // The column is leaving the page: what was opened from its list goes with it.
  dismissFilesDialogs();
  beginLeave();
  adoptDiffNoteScope(null);
}

function shut(): void {
  setInspectorOpen(false);
  stopFollowing?.();
  stopFollowing = null;
  release();
}

/**
 * Bring the binding in line with the session. The states that close the
 * inspector are ones whose composition already has no session to sit beside,
 * so the commit that brought them here needs no second one.
 */
function follow(): void {
  if (!inspectorOpen()) return;
  const screen = currentScreen();
  // The workspace screen owns the model until the reader leaves it: expanded
  // from the column, or opened by the files button while the column was parked.
  // The inspector binds again when the session returns.
  if (screen === "workspace") {
    bound = null;
    return;
  }
  const session = liveSession();
  const paneId = openPaneId();
  if (screen !== "pane" || !session || !paneId) {
    shut();
    return;
  }
  // Parked: no column to show the model in until the window has room again.
  if (!isRoomy()) {
    release();
    return;
  }
  if (bound?.session === session && bound.paneId === paneId) return;
  // Another pane's files take the column: a menu about the last pane's file has no list behind it.
  if (bound) dismissFilesDialogs();
  bound = { session, paneId };
  void showWorkspaceBeside(paneId);
}

function followSession(): () => void {
  const releases = [sessionStore, navigationStore, computersStore].map((store) => store.subscribe(follow));
  window.addEventListener("resize", follow);
  return () => {
    for (const stop of releases) stop();
    window.removeEventListener("resize", follow);
  };
}

/** Open or close the inspector beside the desk session. */
export function toggleWorkspaceInspector(): void {
  if (inspectorOpen()) {
    closeWorkspaceInspector();
    return;
  }
  // Opened with a key: the column takes the keyboard, as the screen would.
  const takeFocus = focusEnteringColumn();
  setInspectorOpen(true);
  stopFollowing ??= followSession();
  follow();
  commitView();
  takeFocus();
}

/**
 * Close the inspector; the list returns when it had given its column away. A
 * key pressed in the column (Enter on its Close) takes focus back to the
 * button that opened it.
 */
export function closeWorkspaceInspector(): void {
  if (!inspectorOpen()) return;
  const handBack = focusLeaving(".inspector");
  shut();
  commitView();
  handBack();
}

/**
 * Open the workspace screen for the inspector's pane. The inspector stays open
 * underneath, so leaving the screen returns to the session with it beside.
 */
export async function expandWorkspaceInspector(): Promise<void> {
  if (!inspectorOpen() || !openPaneId() || currentScreen() !== "pane") return;
  // The same handover the phone makes when it leaves the session for the screen.
  parkComposeView();
  const returnView = isFullTerminal() ? "full" : isAgentChat() ? "agent" : "guided";
  if (isFullTerminal()) await leaveFullTerminal({ rememberGuided: false, paint: false });
  if (isAgentChat()) leaveAgentChat({ rememberGuided: false, paint: false });
  await enterWorkspace(openPaneId(), returnView);
}
