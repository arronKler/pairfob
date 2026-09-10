/**
 * Shared overlay layer: the modal portal lifetime and the sheets built on it.
 *
 * `presentModal` owns exactly one React portal per dialog and settles its
 * promise once, on native `close`. Everything else here — the generic dialogs,
 * the drag-to-dismiss gesture, the action sheet and the long-press binding —
 * composes that lifetime without touching application state.
 */
export { ModalFrame, presentModal, type ModalController } from "./modal";
export { askConfirm, askText, showHelp, type HelpBlock } from "./basic-dialogs";
export { bindSheetDrag, sheetRelease, sheetTravel, type SheetDrag } from "./sheet-drag";
export { MenuItem, MenuRadio, MenuSection, showActionSheet,
  type ActionSheetController, type SheetAction } from "./action-sheet";
export { bindObjectPress } from "./object-press";
export { useObjectPress } from "./use-object-press";
