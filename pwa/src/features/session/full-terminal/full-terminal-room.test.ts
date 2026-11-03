import { Window } from "happy-dom";
import { afterEach, describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/pair", width: 1440, height: 900 });
const g = globalThis as unknown as Record<string, unknown>;
g.window = happy;
g.document = happy.document;
g.HTMLElement = happy.HTMLElement;
happy.document.body.innerHTML = '<main id="app"></main>';

const { floatingPadCover, terminalRoom } = await import("./full-terminal-room.ts");

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

/** A point without a layout engine: the box each element reports. */
function box(el: HTMLElement, top: number, height: number): void {
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ top, bottom: top + height, left: 0, right: 0, width: 0, height }),
  });
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

  test("the floating panel takes no room, so opening it never resizes the computer's terminal", () => {
    const { host, pad } = shell("desk");
    const panel = document.createElement("div");
    panel.className = "pad-panel";
    Object.defineProperty(panel, "offsetHeight", { value: 198 });
    pad.append(panel);
    box(host, 100, 600);
    box(panel, 318, 198);
    expect(terminalRoom(host, { width: 1122, height: 544 })).toEqual({ width: 1122, height: 544 });
  });

  test("the covered part of the host is what the cursor's row must clear", () => {
    const { host, pad } = shell("desk");
    const panel = document.createElement("div");
    panel.className = "pad-panel";
    pad.append(panel);
    box(host, 100, 600);
    box(panel, 318, 198);
    expect(floatingPadCover(host)).toBe(382);
    // Taller than the host: the whole bottom is hidden, never more than its height.
    box(panel, 40, 400);
    expect(floatingPadCover(host)).toBe(600);
    // Gone: nothing covers anything.
    panel.remove();
    expect(floatingPadCover(host)).toBe(0);
  });

  test("a one-line draft takes nothing: the terminal is sized under it", () => {
    const { host, pad } = shell("session");
    draft(pad, 46);
    expect(terminalRoom(host, { width: 382, height: 664 }).height).toBe(664);
  });

  test("the lines a draft grows past its first are given back, on the phone as beside the list", () => {
    for (const classes of ["session", "desk"]) {
      const { host, pad } = shell(classes);
      // Five lines: 46 + 78.
      draft(pad, 124);
      expect(terminalRoom(host, { width: 382, height: 586 }).height).toBe(664);
    }
  });

  test("a long draft alone is given back; the floating panel adds nothing", () => {
    const { host, pad } = shell("desk");
    draft(pad, 82);
    const panel = document.createElement("div");
    panel.className = "pad-panel";
    Object.defineProperty(panel, "offsetHeight", { value: 198 });
    pad.append(panel);
    expect(terminalRoom(host, { width: 1122, height: 508 }).height).toBe(508 + 36);
  });
});