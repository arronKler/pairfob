import { app, state } from "../../state";
import { isDesk } from "../../viewport";
import { composeField, sizeCompose, syncSendButton } from "./compose";
import { settleEcho } from "./echo";
import { paneModel } from "./model";
import { discardEmptyPaneRow } from "./rowbar";
import {
  atBottom,
  displayedTermModel,
  restoreTermScroll,
  sessionScroll,
  stickBottom,
  syncJump,
  termElement,
} from "./term";
import { markCaughtUp, noteSnapshot, unreadCount } from "./unread";
import { flushSync } from "react-dom";
import { notifySessionUI } from "./ui-revision";

export type SessionHandlers = {
  onBack: () => void;
  onMenu: () => void;
  onSwitch: () => void;
  onWorkspace: () => void;
};

export function finishSessionPaint(scroll: { top: number; left: number; bottom: boolean }, input?: HTMLTextAreaElement): void {
  if (state.agentChat) return;
  const term = termElement();
  if (term) {
    restoreTermScroll(term, scroll);
    state.paneFollow = scroll.bottom;
    if (state.paneFollow) {
      state.paneUnread = false;
      markCaughtUp(state.paneId ?? "", paneModel().texts);
    }
    syncJump();
  }
  const field = input ?? composeField();
  if (field) {
    sizeCompose(field);
    if (state.composeFocused || isDesk()) {
      field.focus({ preventScroll: true });
      const caret = field.value.length;
      field.setSelectionRange(caret, caret);
    }
  }
}

export function patchChromeTitle(): void {
  if (app.querySelector("[data-react-session-chrome]")) {
    flushSync(notifySessionUI);
  }
}

/** In-place buffer update that keeps scroll, selection and a typed draft. */
export function patchSessionScreen(): boolean {
  const term = termElement();
  const extras = app.querySelector(".session-extras") as HTMLElement | null;
  if (!term || !extras || state.screen !== "pane") return false;
  // Repainting rows would collapse an in-progress text selection.
  if (state.termSelect) return true;
  const following = atBottom(term);
  const left = term.scrollLeft;
  const top = term.scrollTop;
  const model = paneModel();
  // The snapshot is the truth: resolve the prediction before drawing it.
  settleEcho(state.paneId ?? "", model.texts, state.paneHash);
  discardEmptyPaneRow(displayedTermModel(model));
  flushSync(() => { syncSendButton(); notifySessionUI(); });
  restoreTermScroll(term, { left, top, bottom: following });
  state.paneFollow = following;
  // A repaint that changed nothing is not new output, so the chip stays away.
  noteSnapshot(state.paneId ?? "", model.texts, following);
  state.paneUnread = unreadCount() > 0;
  syncJump();
  return true;
}

export { sessionScroll, stickBottom };

/** Normalize controller state before rendering; JSX only reads the prepared view. */
export function prepareSessionPaint(): ReturnType<typeof sessionScroll> {
  discardEmptyPaneRow(displayedTermModel(paneModel()));
  return sessionScroll();
}
