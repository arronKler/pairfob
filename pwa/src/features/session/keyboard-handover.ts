import { hardwareKeyboard } from "../../app/input-mode";
import { isDesk } from "../../app/viewport";
import { composeEl } from "./chat/agent-chat-controller";
import { noteSessionChosen, sessionMayTakeFocus } from "./focus";
import { focusFullTerminal } from "./full-terminal/full-terminal";
import { focusCompose } from "./guided/compose";
import { isAgentChat, isFullTerminal } from "./session-store";

/**
 * Hand the keyboard to the session that is already on screen.
 *
 * Opening a pane from the list hands it over by arriving: the session paints or
 * mounts, finds the press that chose it still on its list row, and takes focus
 * (see `sessionMayTakeFocus`). Choosing the row of the pane that is already
 * open arrives nowhere and paints nothing, so the handover is made here, to
 * whichever controller is displaying the session.
 *
 * It goes only where opening would take it: beside the list, with a hardware
 * keyboard, and never past a dialog. A touch field still waits for its tap,
 * because focusing it raises the keys; the choice is remembered all the same,
 * so the first key a keyboard types there is the session's.
 */
export function handKeyboardToSession(): void {
  if (!isDesk()) return;
  noteSessionChosen();
  if (!hardwareKeyboard() || !sessionMayTakeFocus()) return;
  if (isFullTerminal()) focusFullTerminal();
  else if (isAgentChat()) composeEl()?.focus({ preventScroll: true });
  else focusCompose();
}
