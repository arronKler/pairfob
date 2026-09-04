/**
 * Public surface of the session screen. The implementation is split by
 * responsibility under `./session/`; re-export here so callers keep one import.
 */
export { composeField, composeLiveControl, focusCompose, handlePaneKey, preserveCompose, setComposeLive } from "./session/compose";
export { dropQueuedKeys } from "./session/keys";
export { paneReadLines } from "./session/model";
export { stickBottom, toggleTermSelect, toggleTermWrap } from "./session/term";
export {
  fillSession,
  finishSessionPaint,
  patchChromeTitle,
  patchSessionScreen,
  sessionScroll,
  type SessionHandlers,
} from "./session/view";
