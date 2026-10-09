import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { happy, resetBoardTestDOM } from "../../test-support/dom";
import { emulateTouchDevice } from "../features/session/touch-realm";
import { bindInputMode, hardwareKeyboard, noteKeydown, resetInputMode, subscribeHardwareKeyboard } from "./input-mode";

/**
 * Telling a hardware keyboard from an on-screen one on a touch device. The
 * guard these pin: Return on a phone's on-screen keyboard adds a line, so
 * nothing that keyboard can produce may ever read as a physical key.
 */
const TABLET = { width: 1180, height: 820 };
const PHONE = { width: 390, height: 844 };

let release = () => {};
let restorePointer = () => {};
let clock = 0;
const realNow = performance.now;

function key(target: Node, name: string, init: Record<string, unknown> = {}): void {
  target.dispatchEvent(new happy.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }) as unknown as Event);
}

/** A field the reader focused `heldMs` ago. */
function focusedField(heldMs: number): HTMLTextAreaElement {
  const field = document.createElement("textarea");
  document.body.append(field);
  field.dispatchEvent(new happy.FocusEvent("focusin", { bubbles: true }) as unknown as Event);
  clock += heldMs;
  return field;
}

const softKeyboard = (open: boolean) => { document.documentElement.dataset.kb = open ? "open" : "closed"; };
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  await resetBoardTestDOM();
  // An earlier file may have proved a keyboard and left it proved.
  resetInputMode();
  happy.happyDOM.setWindowSize(TABLET);
  restorePointer = emulateTouchDevice();
  clock = 10_000;
  performance.now = () => clock;
  release = bindInputMode(document);
});

afterEach(() => {
  release();
  restorePointer();
  performance.now = realNow;
  resetInputMode();
  delete document.documentElement.dataset.kb;
  for (const stray of document.querySelectorAll("body > :not(#app)")) stray.remove();
  happy.happyDOM.setWindowSize(PHONE);
});

describe("a key typed into a field on a touch tablet", () => {
  test("counts once the field has been focused long enough for an on-screen keyboard to have shown", () => {
    const field = focusedField(400);
    key(field, "h");
    expect(hardwareKeyboard()).toBeFalse();
    clock += 700;
    key(field, "i");
    expect(hardwareKeyboard()).toBeTrue();
  });

  test("a press on the field starts the wait again: that is what raises a hidden keyboard", () => {
    const field = focusedField(5000);
    field.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }) as unknown as Event);
    clock += 300;
    key(field, "h");
    expect(hardwareKeyboard()).toBeFalse();
  });

  test("never counts while the on-screen keyboard is showing", () => {
    const field = focusedField(5000);
    softKeyboard(true);
    key(field, "h");
    key(field, "ArrowLeft");
    key(document.body, "Escape");
    expect(hardwareKeyboard()).toBeFalse();
  });

  test("Return, Backspace and composition placeholders prove nothing however long the field was focused", () => {
    const field = focusedField(60_000);
    key(field, "Enter");
    key(field, "Backspace");
    key(field, "Shift");
    key(field, "Unidentified", { keyCode: 229 });
    key(field, "Process");
    key(field, "a", { isComposing: true });
    expect(hardwareKeyboard()).toBeFalse();
  });

  test("typing begun during the wait is remembered: the Return after the wait is a hardware key before it is handled", () => {
    const field = focusedField(760);
    key(field, "l");
    clock += 140;
    key(field, "s");
    expect(hardwareKeyboard()).toBeFalse();
    clock += 500;
    // 1.4s after the tap, and what the field's own listener sees when the key reaches it.
    let seenByField: boolean | null = null;
    field.addEventListener("keydown", () => { seenByField = hardwareKeyboard(); }, { once: true });
    key(field, "Enter");
    expect(seenByField).toBe(true);
  });

  test("Backspace after the wait counts the same way, and a Return inside the wait does not", () => {
    const early = focusedField(300);
    key(early, "l");
    clock += 300;
    key(early, "Enter");
    expect(hardwareKeyboard()).toBeFalse();
    clock += 500;
    key(early, "Backspace");
    expect(hardwareKeyboard()).toBeTrue();
  });

  test("an on-screen keyboard that shows in that focus takes the typed characters back, for as long as the focus lasts", async () => {
    const field = focusedField(300);
    // Tapped on the keys as they slid in, before the viewport had settled on them.
    key(field, "l");
    softKeyboard(true);
    await settle();
    softKeyboard(false);
    await settle();
    clock += 5000;
    key(field, "Enter");
    key(field, "Backspace");
    expect(hardwareKeyboard()).toBeFalse();
    // Seen at a key instead of at its settle: the same.
    const other = focusedField(300);
    key(other, "l");
    softKeyboard(true);
    key(other, "s");
    softKeyboard(false);
    clock += 5000;
    key(other, "Enter");
    expect(hardwareKeyboard()).toBeFalse();
  });

  test("characters typed in one focus say nothing for the next: a press on the field starts over", () => {
    const field = focusedField(300);
    key(field, "l");
    field.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }) as unknown as Event);
    clock += 5000;
    key(field, "Enter");
    expect(hardwareKeyboard()).toBeFalse();
    const next = focusedField(5000);
    key(next, "Enter");
    expect(hardwareKeyboard()).toBeFalse();
  });

  test("a composition placeholder during the wait is not a typed character", () => {
    const field = focusedField(300);
    key(field, "Unidentified", { keyCode: 229 });
    key(field, "a", { isComposing: true });
    key(field, "Process");
    clock += 5000;
    key(field, "Enter");
    key(field, "Backspace");
    expect(hardwareKeyboard()).toBeFalse();
  });

  test("a field focused before the page was watching proves nothing", () => {
    const field = document.createElement("textarea");
    document.body.append(field);
    clock += 60_000;
    key(field, "h");
    expect(hardwareKeyboard()).toBeFalse();
  });

  test("a key no on-screen keyboard has counts at once", () => {
    for (const [name, init] of [
      ["Escape", {}], ["ArrowLeft", {}], ["Tab", {}], ["F5", {}], ["c", { ctrlKey: true }], ["Meta", { metaKey: true }], ["a", { altKey: true }],
      // The navigation block: a tablet's on-screen keyboard draws none of it.
      ["PageUp", {}], ["PageDown", {}], ["Home", {}], ["End", {}], ["Delete", {}], ["Insert", {}],
    ] as const) {
      resetInputMode();
      key(focusedField(0), name, init);
      expect(hardwareKeyboard(), name).toBeTrue();
    }
  });
});

describe("a phone", () => {
  test("never reads a key in its field as a hardware key", () => {
    happy.happyDOM.setWindowSize(PHONE);
    const field = focusedField(60_000);
    key(field, "h");
    key(field, "ArrowLeft");
    key(field, "c", { ctrlKey: true });
    for (const name of ["PageUp", "PageDown", "Home", "End", "Delete", "Insert"]) key(field, name);
    expect(hardwareKeyboard()).toBeFalse();
    // Nor a Return after characters typed as the field took focus.
    const early = focusedField(300);
    key(early, "l");
    clock += 5000;
    key(early, "Enter");
    expect(hardwareKeyboard()).toBeFalse();
    // Not remembered either: the same phone turned to a wide layout starts clean.
    happy.happyDOM.setWindowSize(TABLET);
    expect(hardwareKeyboard()).toBeFalse();
  });

  test("on its side is wide, and still a phone", () => {
    const realScreen = Object.getOwnPropertyDescriptor(globalThis, "screen");
    try {
      Object.defineProperty(globalThis, "screen", { value: { width: 932, height: 430 }, configurable: true });
      happy.happyDOM.setWindowSize({ width: 932, height: 430 });
      const field = focusedField(60_000);
      key(field, "h");
      key(field, "ArrowLeft");
      expect(hardwareKeyboard()).toBeFalse();
    } finally {
      if (realScreen) Object.defineProperty(globalThis, "screen", realScreen);
      else delete (globalThis as { screen?: unknown }).screen;
    }
  });
});

describe("the hardware-keyboard fact", () => {
  test("tells its subscribers when the first physical key proves it, once", () => {
    let told = 0;
    const stop = subscribeHardwareKeyboard(() => { told += 1; });
    key(document.body, "h");
    key(document.body, "i");
    expect(told).toBe(1);
    stop();
    resetInputMode();
    expect(told).toBe(1);
  });

  test("is withdrawn when the on-screen keyboard shows, and proved again by the next physical key", async () => {
    let told = 0;
    const stop = subscribeHardwareKeyboard(() => { told += 1; });
    key(document.body, "h");
    expect(hardwareKeyboard()).toBeTrue();
    // The keyboard case folded back: the tablet raises its own keys.
    softKeyboard(true);
    await settle();
    expect(hardwareKeyboard()).toBeFalse();
    expect(told).toBe(2);
    softKeyboard(false);
    await settle();
    expect(hardwareKeyboard()).toBeFalse();
    key(document.body, "h");
    expect(hardwareKeyboard()).toBeTrue();
    stop();
  });

  test("a mouse is a keyboard without any key", () => {
    restorePointer();
    expect(hardwareKeyboard()).toBeTrue();
    noteKeydown();
    expect(hardwareKeyboard()).toBeTrue();
  });
});
