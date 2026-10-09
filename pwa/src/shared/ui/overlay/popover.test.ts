import { expectSameNode } from "../../../../test-support/node-identity";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bindOverlayOrigin } from "./origin";
import { deskPresentation, placePopover, popoverBox, popoverTarget } from "./popover";

const viewport = { width: 1440, height: 900 };
const box = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width, bottom: top + height });
const point = (x: number, y: number) => box(x, y, 0, 0);

describe("placement", () => {
  test("a menu opens under its trigger on the leading edge", () => {
    expect(placePopover("menu", box(200, 10, 32, 32), { width: 220, height: 180 }, viewport)).toEqual({ left: 200, top: 48, maxHeight: 884 });
  });

  test("a menu flips to the trailing edge and above when that side has no room", () => {
    const spot = placePopover("menu", box(1380, 850, 40, 32), { width: 220, height: 180 }, viewport);
    expect(spot.left).toBe(1380 + 40 - 220);
    expect(spot.top).toBe(850 - 6 - 180);
  });

  test("a menu taller than both sides stays inside the viewport and scrolls", () => {
    const spot = placePopover("menu", box(20, 400, 40, 32), { width: 220, height: 2000 }, viewport);
    expect(spot.top).toBe(8);
    expect(spot.maxHeight).toBe(884);
  });

  test("a menu too tall for either side stands beside its trigger, and over it only without room there", () => {
    // A row's "more" at the rail's edge: the menu takes the column next to it and the row stays readable.
    expect(placePopover("menu", box(259, 452, 28, 28), { width: 206, height: 469 }, viewport)).toEqual({ left: 293, top: 423, maxHeight: 884 });
    // No room after it: before it.
    expect(placePopover("menu", box(1300, 452, 28, 28), { width: 206, height: 469 }, viewport)).toMatchObject({ left: 1300 - 6 - 206, top: 423 });
    // A window as narrow as the menu leaves only the old place.
    expect(placePopover("menu", box(100, 300, 40, 32), { width: 220, height: 500 }, { width: 300, height: 600 })).toMatchObject({ left: 8, top: 92 });
    // The pointer has no box to stand beside: its menu still slides up along it.
    expect(placePopover("menu", point(150, 500), { width: 200, height: 700 }, viewport, true)).toMatchObject({ left: 150, top: 192 });
  });

  test("a context menu opens at the pointer and flips at the edges", () => {
    expect(placePopover("menu", point(150, 190), { width: 200, height: 300 }, viewport, true)).toMatchObject({ left: 150, top: 190 });
    expect(placePopover("menu", point(1400, 880), { width: 200, height: 300 }, viewport, true)).toMatchObject({ left: 1200, top: 580 });
  });

  test("a panel hangs under its trigger on the trailing edge with the height that is left", () => {
    expect(placePopover("panel", box(1390, 4, 44, 44), { width: 360, height: 700 }, viewport)).toEqual({ left: 1072, top: 54, maxHeight: 838 });
    // A column narrower than the panel keeps it on screen rather than under the trigger's edge.
    expect(placePopover("panel", box(300, 4, 44, 44), { width: 360, height: 700 }, viewport).left).toBe(8);
  });

  test("with nothing to hang from it takes the middle of the window", () => {
    expect(placePopover("menu", null, { width: 240, height: 300 }, viewport)).toEqual({ left: 600, top: 300, maxHeight: 884 });
  });
});

describe("presentation", () => {
  let release = () => {};
  let trigger: HTMLButtonElement;
  const press = (target: Element, pointerType: string, button = 0) => target.dispatchEvent(
    new happy.PointerEvent("pointerdown", { bubbles: true, pointerType, button, clientX: 30, clientY: 70 }) as unknown as Event);

  beforeEach(async () => {
    await resetBoardTestDOM();
    happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
    trigger = document.createElement("button");
    trigger.innerHTML = "<svg></svg>";
    document.body.append(trigger);
    release = bindOverlayOrigin(document);
  });
  afterEach(() => { release(); trigger.remove(); happy.happyDOM.setWindowSize({ width: 390, height: 844 }); });

  test("a caller that did not ask, an unbound page and a phone layout keep the sheet", () => {
    press(trigger, "mouse");
    expect(popoverTarget(undefined)).toBeNull();
    happy.happyDOM.setWindowSize({ width: 390, height: 844 });
    expect(popoverTarget("menu")).toBeNull();
    happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
    release();
    expect(popoverTarget("menu")).toBeNull();
  });

  test("the tier is the shell's: from the width that puts the list beside the page, on a screen that is not a phone", () => {
    const realScreen = Object.getOwnPropertyDescriptor(globalThis, "screen");
    press(trigger, "mouse");
    try {
      for (const width of [720, 800, 899, 900]) {
        happy.happyDOM.setWindowSize({ width, height: 700 });
        expect(popoverTarget("menu"), String(width)).toMatchObject({ kind: "menu", anchor: trigger });
        expect(deskPresentation(), String(width)).toBeTrue();
      }
      happy.happyDOM.setWindowSize({ width: 719, height: 700 });
      expect(popoverTarget("menu")).toBeNull();
      expect(deskPresentation()).toBeFalse();
      // A phone on its side is wider than a tablet in portrait and keeps its sheets.
      Object.defineProperty(globalThis, "screen", { value: { width: 844, height: 390 }, configurable: true });
      happy.happyDOM.setWindowSize({ width: 844, height: 390 });
      expect(popoverTarget("menu")).toBeNull();
      expect(deskPresentation()).toBeFalse();
      // The largest phones always crossed 900px, where the list is beside the page.
      Object.defineProperty(globalThis, "screen", { value: { width: 932, height: 430 }, configurable: true });
      happy.happyDOM.setWindowSize({ width: 932, height: 430 });
      expect(popoverTarget("menu")).not.toBeNull();
    } finally {
      if (realScreen) Object.defineProperty(globalThis, "screen", realScreen);
      else delete (globalThis as { screen?: unknown }).screen;
    }
  });

  test("the desk form is for a mouse or the keyboard, and for a page that remembers the gesture", () => {
    press(trigger, "mouse");
    expect(deskPresentation()).toBeTrue();
    trigger.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "k", bubbles: true }) as unknown as Event);
    expect(deskPresentation()).toBeTrue();
    press(trigger, "touch");
    expect(deskPresentation()).toBeFalse();
    press(trigger, "pen");
    expect(deskPresentation()).toBeFalse();
    press(trigger, "mouse");
    release();
    expect(deskPresentation()).toBeFalse();
  });

  test("a finger or a pen keeps the sheet on a desk layout", () => {
    press(trigger, "touch");
    expect(popoverTarget("menu")).toBeNull();
    expect(popoverTarget("panel", trigger)).toBeNull();
    press(trigger, "pen");
    expect(popoverTarget("menu")).toBeNull();
  });

  const rect = (left: number, top: number, width: number, height: number) => () =>
    ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON() {} });

  test("a mouse click anchors to the control it landed in, with its box at that moment", () => {
    trigger.getBoundingClientRect = rect(10, 20, 40, 40);
    press(trigger.querySelector("svg")!, "mouse");
    expect(popoverTarget("menu")).toEqual({ kind: "menu", anchor: trigger, box: { left: 10, top: 20, right: 50, bottom: 60 },
      point: { x: 30, y: 70 }, atPoint: false });
  });

  test("a context click opens a menu at the pointer, and a panel still under its trigger", () => {
    trigger.getBoundingClientRect = rect(10, 20, 40, 40);
    press(trigger, "mouse", 2);
    const menu = popoverTarget("menu")!;
    expect(menu).toMatchObject({ anchor: trigger, atPoint: true, point: { x: 30, y: 70 } });
    expect(popoverBox(menu)).toEqual({ box: { left: 30, right: 30, top: 70, bottom: 70 }, atPoint: true });
    const panel = popoverTarget("panel")!;
    expect(panel.atPoint).toBeFalse();
    expect(popoverBox(panel)).toEqual({ box: { left: 10, top: 20, right: 50, bottom: 60 }, atPoint: false });
  });

  test("an explicit anchor wins over the pressed control and over the pointer", () => {
    const other = document.createElement("button");
    other.getBoundingClientRect = rect(300, 20, 40, 40);
    document.body.append(other);
    press(trigger, "mouse", 2);
    const target = popoverTarget("menu", other)!;
    expectSameNode(target.anchor, other);
    expect(popoverBox(target)).toMatchObject({ box: { left: 300, bottom: 60 }, atPoint: false });
    other.remove();
  });

  test("a keyboard open anchors to the focused control, or keeps the sheet when nothing holds focus", () => {
    trigger.focus();
    trigger.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
    expect(popoverTarget("menu")).toMatchObject({ kind: "menu", anchor: trigger, point: null, atPoint: false });
    trigger.blur();
    document.body.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
    expect(popoverTarget("menu")).toBeNull();
  });

  test("a follow-up whose trigger is gone opens where the mouse was", () => {
    press(trigger, "mouse");
    trigger.remove();
    const target = popoverTarget("menu")!;
    expect(target).toEqual({ kind: "menu", anchor: null, box: null, point: { x: 30, y: 70 }, atPoint: false });
    expect(popoverBox(target)).toEqual({ box: { left: 30, right: 30, top: 70, bottom: 70 }, atPoint: true });
  });

  test("a trigger that folds away once the popover is up keeps the box the gesture saw", () => {
    trigger.getBoundingClientRect = rect(260, 280, 28, 28);
    press(trigger, "mouse");
    const target = popoverTarget("menu")!;
    // Hover actions collapse to nothing while the page behind is inert.
    trigger.getBoundingClientRect = rect(293, 280, 0, 28);
    expect(popoverBox(target)).toEqual({ box: { left: 260, top: 280, right: 288, bottom: 308 }, atPoint: false });
    // Laid out again (a resize), it is read where it is now.
    trigger.getBoundingClientRect = rect(200, 280, 28, 28);
    expect(popoverBox(target)?.box.left).toBe(200);
  });

  test("a trigger with no box at all gives way to the pointer, and a keyboard open to the middle", () => {
    // The test realm lays every element out at 0x0, like a row inside a sheet being replaced.
    press(trigger, "mouse");
    expect(popoverBox(popoverTarget("menu")!)).toEqual({ box: { left: 30, right: 30, top: 70, bottom: 70 }, atPoint: true });
    trigger.focus();
    trigger.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
    expect(popoverBox(popoverTarget("menu")!)).toBeNull();
  });
});
