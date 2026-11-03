import { SessionCompose } from "./session-compose";
import { SessionKeyPad } from "./session-keypad";
import { AttachmentTray } from "../attachments/attachment-tray";
import { useDeskPointer } from "../desk-pointer";
import { useShortLandscape } from "../keypad/short-landscape";
import { useSoftKeyboardOpen } from "../keypad/soft-keyboard";

export type SessionDockProps = {
  /** The session header carries a back control. Standalone, that also means the phone field. */
  includeBack: boolean;
  /** No hardware keyboard, so the field is the mobile one; the pane passes what the device can do. */
  phone?: boolean;
};

/**
 * Guided session dock for root integration: one compose row, with the keys
 * floating above it.
 * `phone` picks the field (`compose-text-mobile` / `compose-text-desktop`) and
 * follows `includeBack` when a caller mounts the dock on its own.
 * `SessionCompose` is a stable sibling of the keypad so IME/draft/selection
 * survive local expand/slash morphs and parent output paints.
 * The attachment tray leads the dock and shrinks its thumbnails while the soft
 * keyboard is up.
 *
 * Driven by a mouse beside the list, the key panel's primary row also carries
 * PgUp/PgDn, because the hidden scroll rail would have offered them. A finger
 * keeps seven cells and the rail. On a phone turned on its side the finger's
 * panel is dense (`is-dense`): one row of keys to a page so the buffer keeps
 * its rows.
 */
export function SessionDock({ includeBack, phone = includeBack }: SessionDockProps) {
  const keyboardOpen = useSoftKeyboardOpen();
  const pointer = useDeskPointer();
  const dense = useShortLandscape() && !pointer;
  return <div className={dense ? "dock is-dense" : "dock"}>
    <AttachmentTray compact={keyboardOpen} />
    <SessionKeyPad paging={pointer} dense={dense} />
    <SessionCompose includeBack={includeBack} phone={phone} />
  </div>;
}

export { SessionCompose } from "./session-compose";
export { SessionKeyPad } from "./session-keypad";
export { SessionPadModeBar, SessionSlashPad } from "./session-slash-pad";
