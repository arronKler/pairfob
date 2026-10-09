/**
 * Search and jump: one text field that reaches every session and the rail's
 * destinations. Entry points call `openCommandPalette()`; the application
 * composition hands the herd in through `provideCommandPalette`.
 */
export { openCommandPalette } from "./open";
export { provideCommandPalette, type CommandPalettePorts } from "./ports";
export { attentionSessions, type PaletteActionId, type PaletteInput, type PaletteSession } from "./model/palette";
