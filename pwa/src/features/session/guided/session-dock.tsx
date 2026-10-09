import { t } from "../../../lib/i18n";
import { SessionCompose } from "./session-compose";
import { SessionKeyPad } from "./session-keypad";
import { AttachmentTray } from "../attachments/attachment-tray";
import { useDeskPointer } from "../desk-pointer";
import { useCompose } from "../hooks";
import { useShortLandscape } from "../keypad/short-landscape";
import { useSoftKeyboardOpen } from "../keypad/soft-keyboard";
import { focusCompose, setComposeLive } from "./compose";
import { InputModeSwitch } from "./compose-controls";

export type SessionDockProps = {
  /** The session header carries a back control. Standalone, that also means the phone field. */
  includeBack: boolean;
  /** No hardware keyboard, so the field is the mobile one; the pane passes what the device can do. */
  phone?: boolean;
};

/**
 * Guided session dock for root integration: keypad + compose.
 * `phone` picks the field (`compose-text-mobile` / `compose-text-desktop`) and
 * follows `includeBack` when a caller mounts the dock on its own.
 * `SessionCompose` is a stable sibling of the keypad so IME/draft/selection
 * survive local expand/slash morphs and parent output paints.
 * The attachment tray leads the dock and shrinks its thumbnails while the soft
 * keyboard is up.
 *
 * Driven by a mouse beside the list, the key pad waits behind "按键" and the
 * 组字 / 实时 switch sits under the field; a finger keeps the row and the panel.
 * On a phone turned on its side the finger's dock is dense (`is-dense`): the
 * pad shows one row of keys to a page so the buffer keeps its rows.
 */
export function SessionDock({ includeBack, phone = includeBack }: SessionDockProps) {
  const keyboardOpen = useSoftKeyboardOpen();
  const pointer = useDeskPointer();
  const live = useCompose().composeLive;
  const dense = useShortLandscape() && !pointer;
  return <div className={dense ? "dock is-dense" : "dock"}>
    <AttachmentTray compact={keyboardOpen} />
    <SessionKeyPad collapsible={pointer} dense={dense} />
    <SessionCompose includeBack={includeBack} phone={phone} keysButton={pointer} />
    {/* The current mode's line leads: it is the one that stays when the column is too narrow for both. */}
    {pointer && <InputModeSwitch live={live}
      hints={live ? [t("deskDock.hintLive"), t("deskDock.hintBatch")] : [t("deskDock.hintBatch"), t("deskDock.hintLive")]}
      onChange={(next) => {
        void setComposeLive(next);
        focusCompose();
      }} />}
  </div>;
}

export { SessionCompose } from "./session-compose";
export { SessionKeyPad } from "./session-keypad";
export { SessionPadModeBar, SessionSlashPad } from "./session-slash-pad";
