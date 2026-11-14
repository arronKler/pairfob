import { beforeEach, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../../test-support/dom";
import type { Terminal } from "@xterm/xterm";
import { scrollClientTerminal } from "./full-terminal-client-scroll";

beforeEach(resetBoardTestDOM);

function setup(type = "normal", mouseTrackingMode = "none", applicationCursorKeysMode = false, bracketedPasteMode = false) {
  const scrolled: number[] = [];
  const inputs: string[] = [];
  const host = document.createElement("div");
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  screen.getBoundingClientRect = () => ({ left: 10, top: 20, width: 800, height: 240 }) as DOMRect;
  host.append(screen);
  document.body.append(host);
  const terminal = {
    cols: 80, rows: 24,
    buffer: { active: { type } },
    modes: { mouseTrackingMode, applicationCursorKeysMode, bracketedPasteMode },
    scrollLines: (lines: number) => scrolled.push(lines),
    input: (bytes: string) => inputs.push(bytes),
  } as unknown as Terminal;
  return { terminal, host, screen, scrolled, inputs };
}

test("main-buffer history scrolls locally without sending shell cursor keys", () => {
  const s = setup();
  expect(scrollClientTerminal(s.terminal, s.host, "up", 3, "wheel")).toBeTrue();
  expect(scrollClientTerminal(s.terminal, s.host, "down", 23, "page_key")).toBeTrue();
  expect(s.scrolled).toEqual([-3, 23]);
  expect(s.inputs).toEqual([]);
});

test("a touch scroll enters xterm's active mouse encoder once per line", () => {
  const s = setup("alternate", "vt200");
  const events: WheelEvent[] = [];
  s.screen.addEventListener("wheel", (event) => events.push(event));
  expect(scrollClientTerminal(s.terminal, s.host, "down", 3, "wheel", { column: 4, row: 5 })).toBeTrue();
  expect(events).toHaveLength(3);
  expect(events.map((event) => [event.deltaY, event.deltaMode, event.target])).toEqual(
    Array.from({ length: 3 }, () => [1, 1, s.screen]),
  );
  expect(s.inputs).toEqual([]);
});

test("an alternate-screen wheel without mouse support cannot type arrows; explicit page keys still work", () => {
  const s = setup("alternate");
  expect(scrollClientTerminal(s.terminal, s.host, "up", 3, "wheel")).toBeFalse();
  expect(s.inputs).toEqual([]);
  expect(scrollClientTerminal(s.terminal, s.host, "up", 23, "page_key")).toBeTrue();
  expect(s.inputs).toEqual(["\x1b[5~"]);
});

for (const type of ["normal", "alternate"]) {
  for (const mode of ["vt200", "x10"]) {
    test(`page buttons send one page key in the ${type} buffer with ${mode} mouse tracking`, () => {
      const s = setup(type, mode);
      const wheels: Event[] = [];
      s.screen.addEventListener("wheel", event => wheels.push(event));
      expect(scrollClientTerminal(s.terminal, s.host, "up", 23, "page_key")).toBeTrue();
      expect(scrollClientTerminal(s.terminal, s.host, "down", 23, "page_key")).toBeTrue();
      expect(s.inputs).toEqual(["\x1b[5~", "\x1b[6~"]);
      expect(s.scrolled).toEqual([]);
      expect(wheels).toEqual([]);
    });
  }
}

test("main-screen application cursor mode receives page keys rather than scrolling browser history", () => {
  const s = setup("normal", "none", true);
  expect(scrollClientTerminal(s.terminal, s.host, "up", 23, "page_key")).toBeTrue();
  expect(s.inputs).toEqual(["\x1b[5~"]);
  expect(s.scrolled).toEqual([]);
});

test("a shell with application cursor mode and bracketed paste still pages local history", () => {
  const s = setup("normal", "none", true, true);
  expect(scrollClientTerminal(s.terminal, s.host, "up", 23, "page_key")).toBeTrue();
  expect(s.inputs).toEqual([]);
  expect(s.scrolled).toEqual([-23]);
});
