import { useEffect, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { currentScreen } from "../../app/navigation-store";
import { closeWorkspaceDetail, leaveWorkspace } from "./actions";
import { closeWorkspaceInspector } from "./inspector";
import { getWorkspaceSnapshot } from "./store";

/**
 * Esc closes the top-most thing, one press at a time.
 *
 * A menu, sheet or dialog is in the top layer and closes itself. A note being
 * written under its line takes the key in its own form and is set aside
 * (`note-inline`). Below those the surface answers: an open file or diff closes
 * back to the list, and the list closes the surface, back to the session: the
 * inspector's column, or the files screen.
 *
 * The inspector answers only while focus is inside it. The session is right
 * next to it, and Esc typed there is the running program's.
 */

type Key = Pick<KeyboardEvent, "key" | "defaultPrevented" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "isComposing">;

/** Escape on its own, not already answered, and not the input method's. */
export function plainEscape(event: Key): boolean {
  return event.key === "Escape" && !event.defaultPrevented && !event.isComposing
    && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

/** Top-layer surfaces answer their own Esc. */
const OVERLAYS = "dialog, [popover], [role='dialog'], [role='menu'], [role='listbox']";

function closeTop(surface: "screen" | "column"): void {
  if (getWorkspaceSnapshot().view !== "browser") closeWorkspaceDetail();
  else if (surface === "screen") leaveWorkspace();
  else closeWorkspaceInspector();
}

/**
 * The inspector's own key handler. A sheet opened from the column is portalled
 * out of it but still bubbles here through React, so the key counts only when
 * it was pressed on something that is in the column.
 */
export function escapeFromColumn(event: ReactKeyboardEvent<HTMLElement>): void {
  if (!plainEscape(event.nativeEvent)) return;
  const target = event.target as Element;
  if (!event.currentTarget.contains(target) || target.closest(OVERLAYS)) return;
  event.preventDefault();
  closeTop("column");
}

/**
 * The files screen has the page to itself, so the key counts wherever focus
 * is, <body> included (a reader who got here with the mouse).
 */
export function useScreenEscape(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!plainEscape(event) || currentScreen() !== "workspace") return;
      const target = event.target as Partial<Element> | null;
      if (document.querySelector("dialog[open]") || document.fullscreenElement) return;
      if (typeof target?.closest === "function" && target.closest(OVERLAYS)) return;
      event.preventDefault();
      closeTop("screen");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
