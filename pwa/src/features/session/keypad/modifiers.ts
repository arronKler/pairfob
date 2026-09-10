/** Pure pad-token remap. Controller code owns latch/consume side effects. */

export type PadModifierFlags = {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  cmd: boolean;
};

export function mapPadKey(key: string, flags: PadModifierFlags): string[] {
  const ctrl = flags.ctrl || flags.cmd;
  const { alt, shift } = flags;
  const letter = /^ctrl\+([a-z])$/.exec(key)?.[1] ?? (/^[a-z]$/i.test(key) ? key.toLowerCase() : "");
  if (ctrl && letter) return [`ctrl+${letter}`];
  if (ctrl) return [];
  if (alt) {
    if (key === "left") return ["esc", "b"];
    if (key === "right") return ["esc", "f"];
    if (key === "backspace") return ["ctrl+w"];
    if (letter) return ["esc", letter];
    return [];
  }
  if (shift && letter) return [letter.toUpperCase()];
  if (shift && key.length === 1) return [key.toUpperCase()];
  return [key];
}
