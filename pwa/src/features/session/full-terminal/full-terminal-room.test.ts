import { Window } from "happy-dom";
import { afterEach, describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/pair", width: 1440, height: 900 });
const g = globalThis as unknown as Record<string, unknown>;
g.window = happy;
g.document = happy.document;
g.HTMLElement = happy.HTMLElement;
happy.document.body.innerHTML = '<main id="app"></main>';

const { terminalRoom } = await import("./full-terminal-room.ts");

const app = () => document.getElementById("app")!;

/** `#app > .main > .full-terminal-root > (.full-terminal-host, .full-terminal-pad)`, as the desk shell mounts it. */
function shell(classes: string) {
  app().className = classes;
  app().innerHTML = '<section class="main"><div class="full-terminal-root">'
    + '<div class="full-terminal-host"></div><div class="full-terminal-pad"></div></div></section>';
  return {
    host: app().querySelector<HTMLElement>(".full-terminal-host")!,
    pad: app().querySelector<HTMLElement>(".full-terminal-pad")!,
  };
}

function inspector(width: number): void {
  const aside = document.createElement("aside");
  aside.className = "inspector";
  aside.style.width = `${width}px`;
  app().append(aside);
}

/** The pad's box: its border, what it shows and what it holds. */
function padBox(pad: HTMLElement, box: { outer: number; inner: number; content: number }): void {
  Object.defineProperties(pad, {
    offsetHeight: { value: box.outer, configurable: true },
    clientHeight: { value: box.inner, configurable: true },
    scrollHeight: { value: box.content, configurable: true },
  });
}

function keys(pad: HTMLElement, height: number, momentary = true): void {
  const controls = document.createElement("div");
  controls.className = momentary ? "full-terminal-pad-controls is-momentary" : "full-terminal-pad-controls";
  Object.defineProperty(controls, "offsetHeight", { value: height });
  pad.append(controls);
}

/** The compose field at `height`; one line is 46px. */
function draft(pad: HTMLElement, height: number): void {
  const field = document.createElement("textarea");
  field.className = "full-terminal-compose-input";
  Object.defineProperty(field, "offsetHeight", { value: height });
  pad.append(field);
}

afterEach(() => {
  app().className = "";
  app().removeAttribute("style");
  app().replaceChildren();
});

describe("the room the computer's terminal is sized against", () => {
  test("it is the visible box when nothing covers the column", () => {
    const { host } = shell("desk");
    expect(terminalRoom(host, { width: 1122, height: 722 })).toEqual({ width: 1122, height: 722 });
  });

  test("the inspector's column is given back", () => {
    const { host } = shell("desk inspector");
    inspector(518.4);
    expect(terminalRoom(host, { width: 603.6, height: 722 })).toEqual({ width: 1122, height: 722 });
  });

  test("with the list hidden, its column is taken off again: the list returns with the inspector gone", () => {
    const { host } = shell("desk inspector rail-hidden");
    app().style.setProperty("--rail-w", "280px");
    inspector(502);
    expect(terminalRoom(host, { width: 506, height: 600 }).width).toBe(506 + 502 - 280);
    // The probe that reads the hidden column leaves nothing behind.
    expect(host.children).toHaveLength(0);
  });

  test("an inspector class without the column, or the phone shell, changes nothing", () => {
    const desk = shell("desk inspector");
    expect(terminalRoom(desk.host, { width: 600, height: 700 }).width).toBe(600);
    const phone = shell("session");
    inspector(400);
    expect(terminalRoom(phone.host, { width: 382, height: 500 }).width).toBe(382);
  });

  test("the pad a mouse calls up gives its height back", () => {
    const { host, pad } = shell("desk");
    keys(pad, 178);
    padBox(pad, { outer: 259, inner: 258, content: 258 });
    expect(terminalRoom(host, { width: 1122, height: 544 })).toEqual({ width: 1122, height: 722 });
  });

  test("a pad at its ceiling scrolls its keys, so they cost only what the pad grew by", () => {
    const { host, pad } = shell("desk");
    keys(pad, 178);
    // 300px of content in a pad capped at 201px: without the keys it would be 123px tall.
    padBox(pad, { outer: 201, inner: 200, content: 300 });
    expect(terminalRoom(host, { width: 1122, height: 300 }).height).toBe(300 + (201 - 123));
    // Still scrolling without the keys: they cost the terminal nothing.
    padBox(pad, { outer: 201, inner: 200, content: 500 });
    expect(terminalRoom(host, { width: 1122, height: 300 }).height).toBe(300);
  });

  test("a finger's key row is part of the layout and does resize the terminal", () => {
    const { host, pad } = shell("desk");
    keys(pad, 178, false);
    padBox(pad, { outer: 259, inner: 258, content: 258 });
    expect(terminalRoom(host, { width: 1122, height: 544 }).height).toBe(544);
  });

  test("a one-line draft takes nothing: the terminal is sized under it", () => {
    const { host, pad } = shell("session");
    draft(pad, 46);
    padBox(pad, { outer: 119, inner: 118, content: 118 });
    expect(terminalRoom(host, { width: 382, height: 664 }).height).toBe(664);
  });

  test("the lines a draft grows past its first are given back, on the phone as beside the list", () => {
    for (const classes of ["session", "desk"]) {
      const { host, pad } = shell(classes);
      // Five lines: 46 + 78.
      draft(pad, 124);
      padBox(pad, { outer: 197, inner: 196, content: 196 });
      expect(terminalRoom(host, { width: 382, height: 586 }).height).toBe(664);
    }
  });

  test("a long draft and the pad a mouse calls up are given back together", () => {
    const { host, pad } = shell("desk");
    keys(pad, 178);
    draft(pad, 82);
    padBox(pad, { outer: 295, inner: 294, content: 294 });
    expect(terminalRoom(host, { width: 1122, height: 508 }).height).toBe(508 + 178 + 36);
  });

  test("a draft growing in a pad at its ceiling costs only what the pad grew by", () => {
    const { host, pad } = shell("session");
    draft(pad, 124);
    // 260px of content in a pad capped at 201px: with one line it would be 182px tall.
    padBox(pad, { outer: 201, inner: 200, content: 259 });
    expect(terminalRoom(host, { width: 382, height: 300 }).height).toBe(300 + (201 - 182));
  });
});
