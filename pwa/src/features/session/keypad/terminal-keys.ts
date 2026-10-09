/** Legacy xterm key encoding, shared by the PTY bridge and guided keypad. */
const directions: Record<string, string> = { up: "A", down: "B", right: "C", left: "D" };

/**
 * The keys a hardware keyboard has and the pad has no cap for, by the final
 * byte or the number xterm's own keyboard table gives them. Home and End
 * follow the cursor-key mode like the arrows; F1–F4 are always SS3.
 */
const letterKeys: Record<string, string> = { home: "H", end: "F", f1: "P", f2: "Q", f3: "R", f4: "S" };
const tildeKeys: Record<string, number> = {
  insert: 2, delete: 3, pageup: 5, pagedown: 6,
  f5: 15, f6: 17, f7: 18, f8: 19, f9: 20, f10: 21, f11: 23, f12: 24,
};

function encodeNavigationKey(key: string, modifiers: number, shift: boolean, ctrl: boolean, applicationCursor: boolean): string | null {
  const letter = Object.hasOwn(letterKeys, key) ? letterKeys[key] : undefined;
  if (letter) {
    if (modifiers) return `\x1b[1;${modifiers + 1}${letter}`;
    return `\x1b${key.startsWith("f") || applicationCursor ? "O" : "["}${letter}`;
  }
  const number = Object.hasOwn(tildeKeys, key) ? tildeKeys[key] : undefined;
  if (number === undefined) return null;
  // Shift or Ctrl with Insert is copy and paste on some systems, and Shift with
  // a page key scrolls the emulator's own scrollback: none of them is sent.
  if (key === "insert") return shift || ctrl ? "" : "\x1b[2~";
  if (key === "pageup" || key === "pagedown") {
    if (shift) return "";
    return ctrl ? `\x1b[${number};${modifiers + 1}~` : `\x1b[${number}~`;
  }
  return modifiers ? `\x1b[${number};${modifiers + 1}~` : `\x1b[${number}~`;
}

export function encodeTerminalKey(key: string, applicationCursor = false): string {
  let ctrl = false, alt = false, shift = false;
  let match: RegExpExecArray | null;
  while ((match = /^(ctrl|alt|shift)\+/.exec(key))) {
    ctrl ||= match[1] === "ctrl";
    alt ||= match[1] === "alt";
    shift ||= match[1] === "shift";
    key = key.slice(match[0].length);
  }
  const direction = Object.hasOwn(directions, key) ? directions[key] : undefined;
  const modifiers = Number(shift) + Number(alt) * 2 + Number(ctrl) * 4;
  if (direction) return modifiers
    ? `\x1b[1;${modifiers + 1}${direction}`
    : `\x1b${applicationCursor ? "O" : "["}${direction}`;
  const navigation = encodeNavigationKey(key, modifiers, shift, ctrl, applicationCursor);
  if (navigation !== null) return navigation;
  // These intentionally follow xterm's legacy keyboard behavior. Some chords
  // share bytes (e.g. Ctrl+Shift+C and Ctrl+C); GUI Command is not a PTY key.
  if (key === "tab") return shift ? "\x1b[Z" : "\t";
  let bytes: string;
  if (key === "space") bytes = ctrl ? "\0" : " ";
  else if (key === "enter") bytes = "\r";
  else if (key === "esc") bytes = "\x1b";
  else if (key === "backspace") bytes = ctrl ? "\b" : "\x7f";
  else if (/^[a-z]$/i.test(key)) bytes = ctrl
    ? String.fromCharCode(key.toLowerCase().charCodeAt(0) - 96)
    : shift ? key.toUpperCase() : key;
  else if (ctrl && /^[ @\[\\\]\^_]$/.test(key)) bytes = String.fromCharCode(key.charCodeAt(0) & 0x1f);
  else if (ctrl && key === "?") bytes = "\x7f";
  else if (ctrl && /^[3-7]$/.test(key)) bytes = String.fromCharCode(Number(key) + 24);
  else if (ctrl && key === "8") bytes = "\x7f";
  else if (!ctrl && Array.from(key).length === 1) bytes = shift ? key.toUpperCase() : key;
  else return "";
  return (alt ? "\x1b" : "") + bytes;
}

/**
 * Native SendKeys only accepts ctrl+letter and printable non-space characters;
 * other chords, Space, and the navigation and function keys need one PTY write.
 */
export function requiresTerminalText(key: string): boolean {
  if (key === "space" || Object.hasOwn(letterKeys, key) || Object.hasOwn(tildeKeys, key)) return true;
  return /^(ctrl|alt|shift)\+/.test(key) && !/^ctrl\+[a-z]$/.test(key);
}
