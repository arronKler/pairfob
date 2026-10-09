import { Window } from "happy-dom";
import { describe, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/pair", width: 1440, height: 900 });
const g = globalThis as unknown as Record<string, unknown>;
g.window = happy;
g.document = happy.document;
g.HTMLElement = happy.HTMLElement;

const { cursorLift, followCursor, liftClip, liftPanCanvas } = await import("./full-terminal-lift.ts");

/**
 * The walkthrough's numbers: a 1440x900 window gives the terminal a 722px room
 * for 31 rows of 23px, and the pad a mouse calls up leaves 544px of it.
 */
const ROOM = 722;
const UNDER_PAD = 544;
const CELL = 23;
const lift = (cursorRow: number, visibleHeight = UNDER_PAD) =>
  cursorLift({ roomHeight: ROOM, visibleHeight, cellHeight: CELL, cursorRow });

function terminalAt(row: number, cellHeight: number | null = CELL) {
  return {
    buffer: { active: { cursorY: row } },
    _core: { _renderService: { dimensions: { css: { cell: cellHeight ? { width: 7, height: cellHeight } : undefined } } } },
  };
}

describe("how far the canvas slides under the momentary key pad", () => {
  test("a cursor on the first row does not slide it: the prompt stays in view", () => {
    expect(lift(0)).toBe(0);
  });

  test("a cursor anywhere in the part that stays visible does not slide it", () => {
    // 544px show rows 0 to 22 whole (23 x 23 = 529).
    expect(lift(11)).toBe(0);
    expect(lift(22)).toBe(0);
  });

  test("a cursor on the last row slides it by the covered height", () => {
    expect(lift(30)).toBe(ROOM - UNDER_PAD);
  });

  test("a cursor in between slides it just far enough for its row to clear the pad", () => {
    // Row 23 ends at 552px: 8px more than the pad leaves.
    expect(lift(23)).toBe(8);
    expect(lift(26)).toBe(27 * CELL - UNDER_PAD);
    // One row short of the end stops a row short of the whole slide.
    expect(lift(29)).toBe(30 * CELL - UNDER_PAD);
  });

  test("a grid shorter than the room slides for its own last row, not the room's", () => {
    // The computer's pane has 26 rows in a 31-row room.
    expect(lift(25)).toBe(26 * CELL - UNDER_PAD);
    // And 20 rows fit above the pad as they are.
    expect(lift(19)).toBe(0);
  });

  test("nothing covered, or no cell measured yet, is no slide", () => {
    expect(lift(30, ROOM)).toBe(0);
    expect(lift(30, ROOM + 40)).toBe(0);
    expect(cursorLift({ roomHeight: ROOM, visibleHeight: UNDER_PAD, cellHeight: 0, cursorRow: 30 })).toBe(0);
  });
});

describe("the canvas follows the cursor while the pad is open", () => {
  test("the canvas keeps the room's height whatever the cursor does", () => {
    const canvas = document.createElement("div");
    liftPanCanvas(canvas, ROOM, UNDER_PAD);
    expect(canvas.style.height).toBe("722px");
    followCursor(canvas, terminalAt(0));
    expect(canvas.style.height).toBe("722px");
    expect(canvas.style.marginTop).toBe("");
  });

  test("it slides when a frame moves the cursor under the pad, and back when the screen clears", () => {
    const canvas = document.createElement("div");
    liftPanCanvas(canvas, ROOM, UNDER_PAD);
    followCursor(canvas, terminalAt(30));
    expect(canvas.style.marginTop).toBe("-178px");
    followCursor(canvas, terminalAt(25));
    expect(canvas.style.marginTop).toBe("-54px");
    followCursor(canvas, terminalAt(0));
    expect(canvas.style.marginTop).toBe("");
  });

  test("a canvas that slid is cut on a row boundary, so the first line showing is a whole one", () => {
    // A phone on its side, 568x320: five 21px rows in a row 70px high slide up 35px, into the second row.
    expect(liftClip(35, 21)).toBe(42);
    // A slide of whole rows cuts nothing more, float error or not.
    expect(liftClip(42, 21)).toBe(42);
    expect(liftClip(62.4, 20.8)).toBeCloseTo(62.4, 5);
    expect(liftClip(0, 21)).toBe(0);
    expect(liftClip(35, 0)).toBe(0);
    const canvas = document.createElement("div");
    liftPanCanvas(canvas, 105, 70);
    followCursor(canvas, terminalAt(4, 21));
    expect(canvas.style.marginTop).toBe("-35px");
    expect(canvas.style.clipPath.replace(/0px/g, "0")).toBe("inset(42px 0 0 0)");
    // The walkthrough's desk: 178px is not whole 23px rows either.
    liftPanCanvas(canvas, ROOM, UNDER_PAD);
    followCursor(canvas, terminalAt(30));
    expect(canvas.style.clipPath.replace(/0px/g, "0")).toBe("inset(184px 0 0 0)");
    // Back on the first row nothing slid and nothing is cut.
    followCursor(canvas, terminalAt(0));
    expect(canvas.style.clipPath).toBe("");
  });

  test("closing the pad puts the canvas back, and later frames leave it there", () => {
    const canvas = document.createElement("div");
    liftPanCanvas(canvas, ROOM, UNDER_PAD);
    followCursor(canvas, terminalAt(30));
    liftPanCanvas(canvas, ROOM, ROOM);
    expect(canvas.style.height).toBe("");
    expect(canvas.style.marginTop).toBe("");
    expect(canvas.style.clipPath).toBe("");
    followCursor(canvas, terminalAt(30));
    expect(canvas.style.marginTop).toBe("");
  });

  test("a canvas that was never lifted is not touched", () => {
    const canvas = document.createElement("div");
    canvas.style.marginTop = "3px";
    followCursor(canvas, terminalAt(30));
    expect(canvas.style.marginTop).toBe("3px");
    followCursor(null, terminalAt(30));
  });

  test("a renderer that has not measured a cell yet does not slide", () => {
    const canvas = document.createElement("div");
    liftPanCanvas(canvas, ROOM, UNDER_PAD);
    followCursor(canvas, terminalAt(30, null));
    expect(canvas.style.marginTop).toBe("");
  });
});
