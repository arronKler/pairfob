import { resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BACK_SECOND_TAP_MS, BACK_SECOND_TAP_PX, guardBackTap } from "./back-tap";

/**
 * Going back swaps the screen under the finger. The second half of a doubled
 * tap lands on what came up there, and its click must go nowhere; a press a
 * moment later, a press somewhere else and every key are the reader's own.
 */
const BACK = { x: 28, y: 26 };
/** The guard's clock, moved by hand: only time and place separate a doubled tap from a deliberate one. */
let clock: number;
const later = (ms: number): void => { clock += ms; };
/** What the screen that came up shows at the back control's spot, and something elsewhere on it. */
let title: HTMLButtonElement;
let row: HTMLButtonElement;
let pressed: string[];

function press(target: Element, at = BACK, init: PointerEventInit = {}): void {
  target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, isPrimary: true, clientX: at.x, clientY: at.y, ...init }));
}
/** A pointer click as the browser sends it; `detail` 0 is a key or a scripted click. */
function click(target: Element, detail = 1): boolean {
  return target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail }));
}
function tap(target: Element, at = BACK): boolean {
  press(target, at);
  return click(target);
}

beforeEach(async () => {
  await resetBoardTestDOM();
  document.body.insertAdjacentHTML("beforeend", '<div id="screen"><button class="title">title</button><button class="row">row</button></div>');
  title = document.querySelector<HTMLButtonElement>(".title")!;
  row = document.querySelector<HTMLButtonElement>(".row")!;
  pressed = [];
  title.addEventListener("click", () => pressed.push("title"));
  row.addEventListener("click", () => pressed.push("row"));
  clock = 1000;
  guardBackTap(document, BACK, () => clock);
});

afterEach(() => {
  // A key ends whatever guard a test left armed.
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  document.getElementById("screen")?.remove();
});

describe("the tail of a double tap on a back control", () => {
  test("the second tap presses nothing on the screen that came up under it", () => {
    later(110);
    expect(tap(title)).toBeFalse();
    expect(pressed).toEqual([]);
  });

  test("neither does a third, as long as the taps keep coming inside the interval", () => {
    later(100);
    expect(tap(title)).toBeFalse();
    later(100);
    expect(tap(title)).toBeFalse();
    later(BACK_SECOND_TAP_MS);
    expect(tap(title)).toBeTrue();
    expect(pressed).toEqual(["title"]);
  });

  test("a tap that begins inside the interval is still the tail when its click comes after it", () => {
    later(BACK_SECOND_TAP_MS - 20);
    press(title);
    later(60);
    expect(click(title)).toBeFalse();
    // That was the last tap that could follow: the next one is the reader's.
    expect(tap(title)).toBeTrue();
    expect(pressed).toEqual(["title"]);
  });

  test("a deliberate tap at the same spot after the interval works", () => {
    later(BACK_SECOND_TAP_MS + 60);
    expect(tap(title)).toBeTrue();
    expect(pressed).toEqual(["title"]);
  });

  test("a tap anywhere else works at once, and ends the guard", () => {
    later(120);
    const elsewhere = { x: BACK.x + BACK_SECOND_TAP_PX + 1, y: BACK.y };
    expect(tap(row, elsewhere)).toBeTrue();
    expect(tap(title)).toBeTrue();
    expect(pressed).toEqual(["row", "title"]);
  });

  test("a doubled tap's jitter is still the same spot", () => {
    later(150);
    expect(tap(title, { x: BACK.x + 12, y: BACK.y - 9 })).toBeFalse();
    expect(pressed).toEqual([]);
  });

  test("a key or a scripted click is never a tap, and a key ends the guard", () => {
    later(90);
    press(title);
    expect(click(title, 0)).toBeTrue();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(tap(title)).toBeTrue();
    expect(pressed).toEqual(["title", "title"]);
  });

  test("a second half that became a drag, or never clicked, swallows nothing later", () => {
    later(90);
    press(title);
    title.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 }));
    expect(tap(title)).toBeTrue();

    guardBackTap(document, BACK, () => clock);
    later(90);
    press(title);
    // Held, never clicked; the press after it comes well past the interval.
    later(BACK_SECOND_TAP_MS + 200);
    expect(tap(title)).toBeTrue();
    expect(pressed).toEqual(["title", "title"]);
  });

  test("a control that acts on the press itself (a key of the key row) does not see the tail's press", () => {
    const sent: string[] = [];
    const heard: string[] = [];
    // A key is sent as it goes down; its click comes too late to be the thing to swallow.
    title.addEventListener("pointerdown", () => sent.push("backspace"));
    // The document's own listeners, bound before the guard was armed or after, still hear every press.
    const listen = (event: Event): void => { heard.push((event.target as Element).className); };
    document.addEventListener("pointerdown", listen, true);
    try {
      later(90);
      const tail = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: BACK.x, clientY: BACK.y });
      title.dispatchEvent(tail);
      expect(sent).toEqual([]);
      // Cancelled too: the press gives its target no focus and starts no mouse events of its own.
      expect(tail.defaultPrevented).toBeTrue();
      expect(click(title)).toBeFalse();
      // A third inside the interval is held back the same way.
      later(100);
      press(title);
      expect(sent).toEqual([]);
      expect(click(title)).toBeFalse();
      // The reader's own press, a moment later, is sent as it goes down.
      later(BACK_SECOND_TAP_MS);
      const own = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: BACK.x, clientY: BACK.y });
      title.dispatchEvent(own);
      expect(own.defaultPrevented).toBeFalse();
      expect(sent).toEqual(["backspace"]);
      expect(heard).toEqual(["title", "title", "title"]);
    } finally { document.removeEventListener("pointerdown", listen, true); }
  });

  test("a press elsewhere, a second finger and a press after the interval reach their controls", () => {
    const sent: string[] = [];
    row.addEventListener("pointerdown", () => sent.push("row"));
    later(90);
    // A second finger is nobody's doubled tap.
    press(row, BACK, { pointerId: 2, isPrimary: false });
    press(row, { x: BACK.x + BACK_SECOND_TAP_PX + 1, y: BACK.y });
    expect(sent).toEqual(["row", "row"]);
  });

  test("only the latest back press is followed, and a second finger is not a tap", () => {
    later(BACK_SECOND_TAP_MS - 50);
    // Back again, somewhere else on the screen: the interval starts over there.
    const other = { x: 300, y: 500 };
    guardBackTap(document, other, () => clock);
    later(100);
    press(title, BACK);
    expect(click(title)).toBeTrue();
    guardBackTap(document, other, () => clock);
    later(100);
    press(row, other, { pointerId: 2, isPrimary: false });
    expect(click(row)).toBeTrue();
    expect(tap(row, other)).toBeFalse();
    expect(pressed).toEqual(["title", "row"]);
  });
});
