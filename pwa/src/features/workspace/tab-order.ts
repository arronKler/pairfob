import { useSyncExternalStore } from "react";
import { handheld, isDesk } from "../../app/viewport";
import type { WorkspaceTab } from "./model";

/**
 * Which of the two tabs comes first.
 *
 * Beside the list, files and changes are opened to see what the agent changed:
 * a pane's first look opens on its changes (`actions`), and the tab that is
 * opened first is also the one that stands first, in the inspector's head and
 * on the screen alike. The two are one list shown at two widths, and a tab
 * that swapped sides with the window would move under the pointer. A phone
 * opens on its files and keeps them first, as it always has.
 */
const CHANGES_FIRST: readonly WorkspaceTab[] = ["changes", "files"];
const FILES_FIRST: readonly WorkspaceTab[] = ["files", "changes"];

/** The list sits beside the page and the screen is not a phone's. */
export function changesLead(): boolean {
  return isDesk() && !handheld();
}

function subscribeResize(listener: () => void): () => void {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
}

/** The order for the window as it is now; follows a resize or a rotation. */
export function useTabOrder(): readonly WorkspaceTab[] {
  return useSyncExternalStore(subscribeResize, changesLead) ? CHANGES_FIRST : FILES_FIRST;
}

/** The inspector only exists beside the list. */
export const INSPECTOR_TAB_ORDER = CHANGES_FIRST;
