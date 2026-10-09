import { expect, test } from "bun:test";
import { encodeTerminalKey, requiresTerminalText } from "./terminal-keys";
import { mapPadKey } from "./modifiers";

const none = { ctrl: false, alt: false, shift: false, cmd: false };

test("all modified arrows retain the xterm modifier bit mask in both cursor modes", () => {
  for (const [key, final] of Object.entries({ up: "A", down: "B", right: "C", left: "D" })) {
    for (let bits = 1; bits <= 7; bits++) {
      const flags = { ...none, shift: !!(bits & 1), alt: !!(bits & 2), ctrl: !!(bits & 4) };
      const mapped = mapPadKey(key, flags);
      expect(mapped).toHaveLength(1);
      expect(requiresTerminalText(mapped[0])).toBe(true);
      for (const application of [false, true]) expect(encodeTerminalKey(mapped[0], application)).toBe(`\x1b[1;${bits + 1}${final}`);
    }
    expect(encodeTerminalKey(key)).toBe(`\x1b[${final}`);
    expect(encodeTerminalKey(key, true)).toBe(`\x1bO${final}`);
  }
});

test("editing chords preserve legacy terminal bytes without substituting readline commands", () => {
  for (const [chord, bytes] of Object.entries({
    "alt+up": "\x1b[1;3A", "shift+tab": "\x1b[Z", "alt+backspace": "\x1b\x7f",
    "ctrl+backspace": "\b", "ctrl+alt+backspace": "\x1b\b", "alt+enter": "\x1b\r",
    "alt+esc": "\x1b\x1b", "ctrl+alt+c": "\x1b\x03", "alt+shift+c": "\x1bC",
  })) expect(encodeTerminalKey(chord)).toBe(bytes);
  expect(mapPadKey("ctrl+c", { ...none, alt: true })).toEqual(["ctrl+alt+c"]);
  expect(mapPadKey("up", { ...none, cmd: true, alt: true })).toEqual(["ctrl+alt+up"]);
  expect(requiresTerminalText("ctrl+c")).toBe(false);
  expect(requiresTerminalText("+")).toBe(false);
  for (const key of ["alt+unknown", "constructor", "__proto__"]) expect(encodeTerminalKey(key)).toBe("");
});


test("Ctrl punctuation and digit aliases encode terminal control bytes", () => {
  const cases: Array<[string, number]> = [
    [" ", 0], ["@", 0], ["[", 27], ["\\", 28], ["]", 29], ["^", 30], ["_", 31], ["?", 127],
    ["3", 27], ["4", 28], ["5", 29], ["6", 30], ["7", 31], ["8", 127],
  ];
  for (const [key, code] of cases) {
    const chord = mapPadKey(key, { ...none, ctrl: true });
    expect(chord).toEqual([`ctrl+${key}`]);
    expect(requiresTerminalText(chord[0]!)).toBe(true);
    expect(encodeTerminalKey(chord[0]!)).toBe(String.fromCharCode(code));
    expect(encodeTerminalKey(`ctrl+alt+${key}`)).toBe(`\x1b${String.fromCharCode(code)}`);
  }
});

test("Space is a named pad key that always travels as one PTY write", () => {
  // Herdr's SendKeys rejects whitespace, so the name must never reach it.
  expect(mapPadKey("space", none)).toEqual(["space"]);
  expect(requiresTerminalText("space")).toBe(true);
  expect(encodeTerminalKey("space")).toBe(" ");
  expect(encodeTerminalKey(mapPadKey("space", { ...none, ctrl: true })[0]!)).toBe("\0");
  expect(encodeTerminalKey(mapPadKey("space", { ...none, alt: true })[0]!)).toBe("\x1b ");
  expect(requiresTerminalText(mapPadKey("space", { ...none, shift: true })[0]!)).toBe(true);
});

test("navigation and function keys are written as xterm's own keyboard table writes them", () => {
  const plain: Record<string, string> = {
    home: "\x1b[H", end: "\x1b[F", insert: "\x1b[2~", delete: "\x1b[3~", pageup: "\x1b[5~", pagedown: "\x1b[6~",
    f1: "\x1bOP", f2: "\x1bOQ", f3: "\x1bOR", f4: "\x1bOS", f5: "\x1b[15~", f6: "\x1b[17~", f7: "\x1b[18~",
    f8: "\x1b[19~", f9: "\x1b[20~", f10: "\x1b[21~", f11: "\x1b[23~", f12: "\x1b[24~",
  };
  for (const [key, bytes] of Object.entries(plain)) {
    expect(encodeTerminalKey(key), key).toBe(bytes);
    // Herdr's SendKeys names none of them: each travels as one PTY write.
    expect(requiresTerminalText(key), key).toBe(true);
  }
  // Home and End follow the cursor-key mode a program set, like the arrows; nothing else does.
  expect(encodeTerminalKey("home", true)).toBe("\x1bOH");
  expect(encodeTerminalKey("end", true)).toBe("\x1bOF");
  expect(encodeTerminalKey("delete", true)).toBe("\x1b[3~");
  expect(encodeTerminalKey("f1", true)).toBe("\x1bOP");
});

test("their modifiers ride in the sequence, in both cursor modes", () => {
  for (const application of [false, true]) {
    expect(encodeTerminalKey("shift+home", application)).toBe("\x1b[1;2H");
    expect(encodeTerminalKey("ctrl+end", application)).toBe("\x1b[1;5F");
    expect(encodeTerminalKey("alt+delete", application)).toBe("\x1b[3;3~");
    expect(encodeTerminalKey("ctrl+shift+delete", application)).toBe("\x1b[3;6~");
    expect(encodeTerminalKey("shift+f1", application)).toBe("\x1b[1;2P");
    expect(encodeTerminalKey("ctrl+f5", application)).toBe("\x1b[15;5~");
    expect(encodeTerminalKey("ctrl+alt+shift+f12", application)).toBe("\x1b[24;8~");
    expect(encodeTerminalKey("ctrl+pageup", application)).toBe("\x1b[5;5~");
    expect(encodeTerminalKey("ctrl+alt+pagedown", application)).toBe("\x1b[6;7~");
  }
  // xterm sends a page key with Alt alone as the plain key.
  expect(encodeTerminalKey("alt+pageup")).toBe("\x1b[5~");
});

test("the chords an emulator keeps for itself are not sent", () => {
  // Shift or Ctrl with Insert is copy and paste on some systems; Shift with a page key scrolls the emulator.
  for (const key of ["shift+insert", "ctrl+insert", "shift+pageup", "shift+pagedown", "ctrl+shift+pageup"]) {
    expect(encodeTerminalKey(key), key).toBe("");
  }
  expect(encodeTerminalKey("alt+insert")).toBe("\x1b[2~");
  // A name that only looks like one is still nothing.
  for (const key of ["f13", "f0", "homes", "pageleft"]) expect(encodeTerminalKey(key), key).toBe("");
});
