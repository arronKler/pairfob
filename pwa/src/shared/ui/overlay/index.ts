/**
 * Shared overlay layer: the modal portal lifetime and the sheets built on it.
 *
 * `presentModal` owns exactly one React portal per dialog and settles its
 * promise once, on native `close`. Everything else here — the generic dialogs,
 * the drag-to-dismiss gesture, the action sheet and the long-press binding —
 * composes that lifetime without touching application state. A sheet opened by
 * a mouse on a desk layout is the same dialog anchored to what opened it
 * (`popover`), decided from the gesture `origin` remembers; every other dialog
 * a mouse or the keyboard opens there is the centred card (`desk-form`), also
 * below the width where a finger gets the bottom sheet.
 */
export { ModalFrame, presentModal, type ModalController } from "./modal";
export { askConfirm, askText, showHelp, type ConfirmRequest, type HelpBlock, type TextRequest } from "./basic-dialogs";
export { bindSheetDrag, sheetRelease, sheetTravel, type SheetDrag } from "./sheet-drag";
export { MenuItem, MenuRadio, MenuSection, showActionSheet,
  type ActionSheetController, type ActionSheetOptions, type SheetAction } from "./action-sheet";
export { MenuChoice } from "./menu-choice";
export { MenuGroup, MenuRow, MenuSetting, MenuStepper, MenuSwitch, MenuTile, MenuTiles } from "./menu-controls";
export { useSheetNav, type SheetNav, type SheetPage } from "./sheet-stack";
export { bindObjectPress } from "./object-press";
export { bindOverlayOrigin, type OverlayInput, type OverlayOrigin } from "./origin";
export { dismissPopovers, type PopoverKind } from "./popover";
export { useObjectPress } from "./use-object-press";
