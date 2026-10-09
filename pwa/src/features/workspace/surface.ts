import { currentScreen } from "../../app/navigation-store";
import { isRoomy } from "../../app/viewport";
import { openPaneId } from "../session/session-store";
import { inspectorOpen } from "./inspector-store";
import { getWorkspaceSnapshot } from "./store";

/**
 * Where the workspace model is presented.
 *
 * It has two surfaces: the workspace screen, and the inspector beside the pane
 * it is bound to. Work that outlives an await asks here instead of asking for
 * the screen alone, so it holds on either surface and stops as soon as neither
 * shows this pane's files.
 */

/**
 * The inspector presents the model beside the pane it is bound to. It stays
 * open in the reader's mind through a window too narrow to show it, but
 * presents nothing there.
 */
export function workspaceBeside(): boolean {
  const paneId = getWorkspaceSnapshot().paneId;
  return inspectorOpen() && isRoomy() && currentScreen() === "pane" && paneId !== "" && paneId === openPaneId();
}

/** The model is on screen: as the workspace screen, or in the inspector. */
export function workspacePresented(): boolean {
  return currentScreen() === "workspace" || workspaceBeside();
}
