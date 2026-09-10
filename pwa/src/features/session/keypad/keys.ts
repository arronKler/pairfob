/** Pad key tables. No state, paint, or DOM. */

export type Modifier = "ctrl" | "alt" | "shift" | "cmd";

export type KeySpec = {
  key: string;
  label?: string;
  aria?: string;
  repeat?: boolean;
  modifier?: Modifier;
};

/** Primary phone row: escape, movement, delete. */
export const PRIMARY_KEYS: KeySpec[] = [
  { key: "esc", label: "Esc" },
  { key: "up", label: "↑", repeat: true },
  { key: "down", label: "↓", repeat: true },
  { key: "left", label: "←", repeat: true },
  { key: "right", label: "→", repeat: true },
  { key: "backspace", label: "⌫", repeat: true },
];

export const SECONDARY_KEYS: KeySpec[] = [
  { key: "tab", label: "Tab" },
  { key: "enter", label: "Enter" },
  { key: "ctrl+c", label: "Ctrl+C" },
  { key: "ctrl+z", label: "Ctrl+Z" },
  { key: "ctrl+d", label: "Ctrl+D" },
  { key: "ctrl+l", label: "Ctrl+L" },
];

/**
 * Extra row when expanded. Ctrl/Opt/Shift/Cmd are holds. Herdr only takes
 * ctrl+[a-z] plus named keys, so Opt/Shift remap onto that table.
 */
export const TERTIARY_KEYS: KeySpec[] = [
  { key: "ctrl", label: "Ctrl", aria: "Control", modifier: "ctrl" },
  { key: "alt", label: "Opt", aria: "Option", modifier: "alt" },
  { key: "shift", label: "Shift", aria: "Shift", modifier: "shift" },
  { key: "cmd", label: "Cmd", aria: "Command", modifier: "cmd" },
  { key: "ctrl+a", label: "Ctrl+A", repeat: true },
  { key: "ctrl+e", label: "Ctrl+E", repeat: true },
  { key: "ctrl+k", label: "Ctrl+K", repeat: true },
];
