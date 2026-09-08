/**
 * Public surface of the session screen. The implementation is split by
 * responsibility under `./session/`; re-export here so callers keep one import.
 */
export { composeField, focusCompose, handlePaneKey, preserveCompose, setComposeLive } from "./session/compose";
export { dropQueuedKeys } from "./session/keys";
export { paneReadLines } from "./session/model";
export { revealCaretRow, stickBottom, toggleTermSelect, toggleTermWrap } from "./session/term";
export {
  finishSessionPaint,
  patchChromeTitle,
  patchSessionScreen,
  prepareSessionPaint,
  sessionScroll,
  type SessionHandlers,
} from "./session/view";
