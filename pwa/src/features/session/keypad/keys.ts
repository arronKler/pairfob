/** Pad key tables. No state, paint, or DOM. */

export type Modifier = "ctrl" | "alt" | "shift" | "cmd";

export type KeySpec = {
  key: string;
  label?: string;
  aria?: string;
  repeat?: boolean;
  modifier?: Modifier;
};

/** Primary phone row: escape, movement, delete. The pad toggle takes the seventh cell. */
export const PRIMARY_KEYS: KeySpec[] = [
  { key: "esc", label: "Esc" },
  { key: "up", label: "↑", repeat: true },
  { key: "down", label: "↓", repeat: true },
  { key: "left", label: "←", repeat: true },
  { key: "right", label: "→", repeat: true },
  { key: "backspace", label: "⌫", repeat: true },
];

/**
 * Paging, for a pad opened with a mouse: the scroll rail a finger pages with is
 * put away there. These are not sendable keys; each pad pages its own way.
 */
export const PAGE_KEYS: KeySpec[] = [
  { key: "pageup", label: "PgUp" },
  { key: "pagedown", label: "PgDn" },
];

/**
 * Modifiers can be held or latched for the next key. Modified keys use terminal
 * encoding; Cmd retains the pad’s Ctrl alias. One name, Alt, for the key and
 * for the chords it forms; the spoken label keeps the Mac name too.
 */
export const TERTIARY_KEYS: KeySpec[] = [
  { key: "ctrl", label: "Ctrl", aria: "Control", modifier: "ctrl" },
  { key: "alt", label: "Alt", aria: "Alt / Option", modifier: "alt" },
  { key: "shift", label: "Shift", aria: "Shift", modifier: "shift" },
  { key: "cmd", label: "Cmd", aria: "Command", modifier: "cmd" },
];

export const SECONDARY_KEYS: KeySpec[] = [
  { key: "tab", label: "Tab" },
  { key: "shift+tab" },
  { key: "enter", label: "Enter" },
];

/** POSIX terminal controls: interrupt, end of input, suspend, clear, history search, kill line, kill word. */
const CONTROL_CHORDS: KeySpec[] = ["c", "d", "z", "l", "r", "u", "w"].map(letter => ({ key: `ctrl+${letter}` }));

/** Page 1, "control". Every modifier stays on this page so held and locked chords remain reachable. */
export const EXPANDED_KEYS: KeySpec[] = [...TERTIARY_KEYS, ...SECONDARY_KEYS, ...CONTROL_CHORDS];

/** Page 2, "select and edit": TUI choices, then readline editing. These keys never append Enter. */
export const EXTRA_KEYS: KeySpec[] = [
  ...["1", "2", "3", "4", "5", "y", "n"].map(key => ({ key, label: key.toUpperCase() })),
  { key: "space" },
  { key: "ctrl+a", repeat: true },
  { key: "ctrl+e", repeat: true },
  { key: "ctrl+k", repeat: true },
  { key: "ctrl+y" },
  { key: "alt+b", repeat: true },
  { key: "alt+f", repeat: true },
];

/** Pages are grouped by purpose; both hold exactly two rows of seven. */
export const KEY_PAGES = [
  { name: "pad.pageControl", keys: EXPANDED_KEYS },
  { name: "pad.pageEdit", keys: EXTRA_KEYS },
] as const;

const WORD_NAMES: Readonly<Record<string, string>> = { esc: "Esc", tab: "Tab", enter: "Enter" };
const MODIFIER_NAMES: Readonly<Record<string, string>> = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Cmd" };

/**
 * How a keycap is written. A glyph is one character; a word is a key name; a
 * chord puts its modifier on a small line above the key so the main keys of a
 * row share one baseline. Arrows and ⌫ are glyphs drawn as icons.
 */
export type Keycap =
  | { kind: "glyph"; text: string }
  | { kind: "word"; text: string }
  | { kind: "chord"; modifier: string; text: string; word: boolean };

export function keycapOf(spec: KeySpec): Keycap {
  if (spec.modifier) return { kind: "word", text: spec.label ?? MODIFIER_NAMES[spec.modifier]! };
  if (spec.key === "space") return { kind: "word", text: "" };
  const chord = /^(ctrl|alt|shift)\+(.+)$/.exec(spec.key);
  if (chord) {
    const main = WORD_NAMES[chord[2]!] ?? chord[2]!.toUpperCase();
    return { kind: "chord", modifier: MODIFIER_NAMES[chord[1]!]!, text: main, word: Array.from(main).length > 1 };
  }
  const text = spec.label ?? WORD_NAMES[spec.key] ?? spec.key;
  return Array.from(text).length > 1 ? { kind: "word", text } : { kind: "glyph", text };
}

/** Screen readers hear the full chord ("Ctrl+C"), never the stacked visual. */
export function keyAriaName(spec: KeySpec): string {
  if (spec.aria) return spec.aria;
  const cap = keycapOf(spec);
  return cap.kind === "chord" ? `${cap.modifier}+${cap.text}` : cap.text;
}
