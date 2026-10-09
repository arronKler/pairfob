import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { appRoot } from "../dom-root";
import { guardListReturn, LIST_RETURN_SECOND_TAP_MS } from "./list-return";

/**
 * The click that ends a tap on the full-width board lands on the list that has
 * just come back under the finger, and so does the second half of a double
 * tap. The guard stops those clicks and nothing else.
 */
let release: () => void;
/** The guard's clock, moved by hand: only time separates a double tap from a deliberate one. */
let clock: number;
const later = (ms: number): void => { clock += ms; };
let row: HTMLButtonElement;
let tile: HTMLButtonElement;
let opened: string[];

/** A pointer click as the browser sends it; `detail` 0 is a key or a scripted click. */
function click(target: Element, detail = 1): boolean {
  return target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail }));
}

function pointer(type: "pointerdown" | "pointerup", target: Element): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true }));
}

beforeEach(async () => {
  await resetBoardTestDOM();
  const app = appRoot();
  app.className = "desk rail-hidden";
  app.innerHTML = '<aside class="rail"><button class="card-main">row</button></aside>'
    + '<section class="main"><button class="board-pane">tile</button></section>';
  row = app.querySelector<HTMLButtonElement>(".card-main")!;
  tile = app.querySelector<HTMLButtonElement>(".board-pane")!;
  opened = [];
  row.addEventListener("click", () => opened.push("row"));
  tile.addEventListener("click", () => opened.push("tile"));
  clock = 1000;
  release = guardListReturn(() => clock);
});

afterEach(() => {
  release();
  appRoot().className = "";
  appRoot().replaceChildren();
});

/** The tile opens its pane as the finger lifts: the list is back before the click. */
function tapTileThatOpensItsPane(): void {
  pointer("pointerdown", tile);
  pointer("pointerup", tile);
  tile.click();
  appRoot().classList.remove("rail-hidden");
}

describe("the list returning under a finger", () => {
  test("the tap's own click does not open the row that came up under it", () => {
    tapTileThatOpensItsPane();
    expect(click(row)).toBeFalse();
    expect(opened).toEqual(["tile"]);
  });

  test("it stops that one click: the reader's next press on the list is their own", () => {
    tapTileThatOpensItsPane();
    click(row);
    later(LIST_RETURN_SECOND_TAP_MS);
    pointer("pointerdown", row);
    pointer("pointerup", row);
    expect(click(row)).toBeTrue();
    expect(opened).toEqual(["tile", "row"]);
    // A release that was never followed by a click is forgotten by the next press too.
    appRoot().classList.add("rail-hidden");
    pointer("pointerdown", tile);
    pointer("pointerup", tile);
    appRoot().classList.remove("rail-hidden");
    later(LIST_RETURN_SECOND_TAP_MS);
    pointer("pointerdown", row);
    pointer("pointerup", row);
    expect(click(row)).toBeTrue();
  });

  test("the second tap of a double tap lands on the list and opens nothing", () => {
    // The board's back control: its own click is on the board and brings the list back.
    pointer("pointerdown", tile);
    pointer("pointerup", tile);
    expect(click(tile)).toBeTrue();
    appRoot().classList.remove("rail-hidden");
    // The finger comes down again where the list now is.
    later(120);
    pointer("pointerdown", row);
    pointer("pointerup", row);
    expect(click(row, 2)).toBeFalse();
    expect(opened).toEqual(["tile"]);
    // A third tap inside the same moment is no more deliberate than the second.
    later(120);
    pointer("pointerdown", row);
    pointer("pointerup", row);
    expect(click(row, 3)).toBeFalse();
    // Once the moment has passed the list is the reader's again, with no press spent on the guard.
    later(LIST_RETURN_SECOND_TAP_MS);
    pointer("pointerdown", row);
    pointer("pointerup", row);
    expect(click(row)).toBeTrue();
    expect(opened).toEqual(["tile", "row"]);
  });

  test("only the clock bounds the second tap: a slow second press and a key are let through", () => {
    pointer("pointerdown", tile);
    pointer("pointerup", tile);
    click(tile);
    appRoot().classList.remove("rail-hidden");
    later(LIST_RETURN_SECOND_TAP_MS);
    pointer("pointerdown", row);
    pointer("pointerup", row);
    expect(click(row)).toBeTrue();

    appRoot().classList.add("rail-hidden");
    pointer("pointerdown", tile);
    pointer("pointerup", tile);
    appRoot().classList.remove("rail-hidden");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    pointer("pointerdown", row);
    pointer("pointerup", row);
    expect(click(row)).toBeTrue();
  });

  test("a click elsewhere, a key and a scripted click are never stopped", () => {
    tapTileThatOpensItsPane();
    // The trailing click on the page beside the list is left alone, and does not spend the guard.
    expect(click(tile)).toBeTrue();
    // Enter on a focused row, or code that clicks it, follows no release.
    expect(click(row, 0)).toBeTrue();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(click(row)).toBeTrue();
  });

  test("while the list is on screen nothing is watched for", () => {
    appRoot().classList.remove("rail-hidden");
    pointer("pointerdown", row);
    pointer("pointerup", row);
    expect(click(row)).toBeTrue();
    expect(opened).toEqual(["row"]);
  });

  test("releasing the guard removes it", () => {
    release();
    tapTileThatOpensItsPane();
    expect(click(row)).toBeTrue();
    release = guardListReturn();
  });
});
