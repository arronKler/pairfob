import { expectSameNode } from "../../../../test-support/node-identity";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { closeTestDialogs } from "../../../../test-support/close-dialogs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { setLang } from "../../../lib/i18n";
import { MenuItem, showActionSheet } from "./action-sheet";
import { askConfirm, askText, showHelp } from "./basic-dialogs";
import { bindOverlayOrigin } from "./origin";
import { bindSheetDrag } from "./sheet-drag";

/**
 * A dialog's desk form: where the list sits beside the page, a mouse or the
 * keyboard gets the wide window's centred card below 900px too, and a finger,
 * every phone, and a window dragged down to the phone layout keep the sheet.
 * The card follows the window both ways for as long as the dialog is open.
 */
const pause = (ms = 0) => new Promise<void>(resolve => setTimeout(resolve, ms));
const dialog = () => document.querySelector<HTMLDialogElement>("dialog[open]")!;
let release = () => {};
let trigger: HTMLButtonElement;

function press(pointerType: string): void {
  trigger.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerType, clientX: 40, clientY: 40 }) as unknown as Event);
}
function keydown(key: string): void {
  trigger.dispatchEvent(new happy.KeyboardEvent("keydown", { key, bubbles: true }) as unknown as Event);
}
function resize(width: number): void {
  act(() => {
    happy.happyDOM.setWindowSize({ width, height: 700 });
    window.dispatchEvent(new happy.Event("resize") as unknown as Event);
  });
}
function confirmClass(): string {
  act(() => { void askConfirm({ title: "Close this session?", confirmLabel: "Close" }); });
  const classes = dialog().className;
  act(() => closeTestDialogs());
  return classes;
}
function touch(target: HTMLDialogElement, kind: string, y: number, at: number): void {
  const event = new happy.Event(kind, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: kind === "touchend" ? [] : [{ clientX: 20, clientY: y }] },
    timeStamp: { value: at },
  });
  target.dispatchEvent(event as unknown as Event);
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  happy.happyDOM.setWindowSize({ width: 800, height: 700 });
  trigger = document.createElement("button");
  document.body.append(trigger);
  release = bindOverlayOrigin(document);
});
afterEach(async () => {
  await act(async () => { closeTestDialogs(); await pause(); });
  release();
  trigger.remove();
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
});

describe("which dialogs take the desk form", () => {
  test("a mouse or the keyboard beside the list gets the card; a finger or a pen keeps the sheet", () => {
    for (const width of [720, 800, 899, 900, 1440]) {
      happy.happyDOM.setWindowSize({ width, height: 700 });
      press("mouse");
      expect(confirmClass(), `mouse ${width}`).toBe("modal confirm desk-form");
      keydown("Enter");
      expect(confirmClass(), `key ${width}`).toBe("modal confirm desk-form");
      press("touch");
      expect(confirmClass(), `touch ${width}`).toBe("modal confirm");
      press("pen");
      expect(confirmClass(), `pen ${width}`).toBe("modal confirm");
    }
  });

  test("the phone layout keeps the sheet for a mouse and the keyboard too", () => {
    for (const width of [390, 600, 719]) {
      happy.happyDOM.setWindowSize({ width, height: 700 });
      press("mouse");
      expect(confirmClass(), `mouse ${width}`).toBe("modal confirm");
      keydown(" ");
      expect(confirmClass(), `key ${width}`).toBe("modal confirm");
    }
  });

  test("a phone on its side is wide without being a desk", () => {
    const realScreen = Object.getOwnPropertyDescriptor(globalThis, "screen");
    try {
      Object.defineProperty(globalThis, "screen", { value: { width: 844, height: 390 }, configurable: true });
      happy.happyDOM.setWindowSize({ width: 844, height: 390 });
      press("mouse");
      expect(confirmClass()).toBe("modal confirm");
    } finally {
      if (realScreen) Object.defineProperty(globalThis, "screen", realScreen);
      else delete (globalThis as { screen?: unknown }).screen;
    }
  });

  test("a page that remembers no gesture opens the sheet", () => {
    press("mouse");
    release();
    expect(confirmClass()).toBe("modal confirm");
  });

  test("every shared frame takes it, and an anchored sheet stays a popover", () => {
    press("mouse");
    act(() => { void askText({ title: "Rename", initial: "api" }); });
    expect(dialog().className).toBe("modal text-edit desk-form");
    act(() => closeTestDialogs());
    act(() => showHelp("Install", ["Run the installer."]));
    expect(dialog().className).toBe("modal help desk-form");
    act(() => closeTestDialogs());
    act(() => showActionSheet("Resize", modal => <MenuItem modal={modal}>Done</MenuItem>, { className: "board-resize-sheet" }));
    expect(dialog().className).toBe("modal sheet desk-form board-resize-sheet");
    act(() => closeTestDialogs());
    act(() => showActionSheet("Session", modal => <MenuItem modal={modal}>Pin</MenuItem>, { popover: "menu", anchor: trigger }));
    expect(dialog().className).toBe("modal sheet popover popover-menu");
  });

  test("a dialog opened from an anchored menu is the card: the gesture is still the mouse", async () => {
    press("mouse");
    let asked: Promise<string | null> | undefined;
    act(() => showActionSheet("Session", modal => (
      <MenuItem modal={modal} action={() => { asked = askText({ title: "Rename", initial: "api" }); }}>Rename</MenuItem>
    ), { popover: "menu", anchor: trigger }));
    const item = dialog().querySelector<HTMLButtonElement>("[role=menuitem]")!;
    // The click that picks the row is the same mouse the menu opened under.
    item.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }) as unknown as Event);
    await act(async () => { item.click(); await pause(5); });
    expect(asked).toBeDefined();
    expect(dialog().className).toBe("modal text-edit desk-form");
  });
});

describe("a dialog a mouse or the keyboard opened follows the window", () => {
  test("dragged down to the phone layout it is the sheet, widened again the card, and keeps what was typed", () => {
    press("mouse");
    act(() => { void askText({ title: "Rename", initial: "api" }); });
    const field = dialog().querySelector("input")!;
    field.value = "api-server";
    resize(760);
    expect(dialog().className).toBe("modal text-edit desk-form");
    resize(700);
    expect(dialog().open).toBeTrue();
    expect(dialog().className).toBe("modal text-edit");
    expectSameNode(dialog().querySelector("input"), field);
    expect(field.value).toBe("api-server");
    // Back beside the list it is what a fresh open there would be, as it is past 900px.
    for (const width of [720, 800, 899, 900, 1440]) {
      resize(width);
      expect(dialog().className, String(width)).toBe("modal text-edit desk-form");
    }
    resize(719);
    expect(dialog().className).toBe("modal text-edit");
    expectSameNode(dialog().querySelector("input"), field);
    expect(field.value).toBe("api-server");
  });

  test("its two actions move between the sheet's bar and the card's footer; focus that was on one starts over in the field", () => {
    press("mouse");
    act(() => { void askText({ title: "Rename", initial: "api" }); });
    const field = dialog().querySelector("input")!;
    expect(dialog().querySelector(".text-edit-head")).toBeNull();
    const cancel = dialog().querySelector<HTMLButtonElement>(".desk-actions .desk-cancel")!;
    cancel.focus();
    resize(700);
    // The sheet: Cancel and Save above the field, and no footer or corner close.
    expect(dialog().querySelectorAll(".text-edit-head .text-edit-action").length).toBe(2);
    expect(dialog().querySelector(".desk-actions, .desk-close")).toBeNull();
    expect(cancel.isConnected).toBeFalse();
    expectSameNode(document.activeElement, field);
    resize(800);
    expect(dialog().querySelector(".text-edit-head")).toBeNull();
    expect(dialog().querySelectorAll(".desk-actions button").length).toBe(2);
    // Focus the reader left in the field stays in the field, with what was typed.
    expectSameNode(document.activeElement, field);
    expectSameNode(dialog().querySelector("input"), field);
  });

  test("opened on the phone layout, it is the card once the list is beside the page", () => {
    happy.happyDOM.setWindowSize({ width: 700, height: 700 });
    keydown("Enter");
    act(() => { void askText({ title: "Rename", initial: "api" }); });
    expect(dialog().className).toBe("modal text-edit");
    resize(800);
    expect(dialog().className).toBe("modal text-edit desk-form");
  });

  test("a later tap inside it changes nothing: the gesture that opened it decides", () => {
    press("mouse");
    act(() => { void askText({ title: "Rename", initial: "api" }); });
    press("touch");
    resize(700);
    resize(800);
    expect(dialog().className).toBe("modal text-edit desk-form");
  });

  test("a sheet a finger opened is not promoted when the window grows", () => {
    press("touch");
    act(() => { void askText({ title: "Rename", initial: "api" }); });
    expect(dialog().className).toBe("modal text-edit");
    // Not even by a mouse that arrives while it is open.
    press("mouse");
    for (const width of [700, 800, 899, 1000]) {
      resize(width);
      expect(dialog().className, String(width)).toBe("modal text-edit");
    }
  });
});

describe("sheet gestures follow the presentation", () => {
  const open = () => act(() => showActionSheet("Resize", modal => <MenuItem modal={modal}>Done</MenuItem>));
  const drag = (to: number) => { touch(dialog(), "touchstart", 0, 0); touch(dialog(), "touchmove", to, 100); };
  const form = () => dialog().querySelector("form")!;

  test("a card is not dragged and leaves the page where it is", async () => {
    press("mouse");
    open();
    await act(async () => { await pause(); });
    expect(dialog().className).toBe("modal sheet desk-form");
    expect(document.body.classList.contains("sheet-open")).toBeFalse();
    drag(240);
    expect(form().style.transform).toBe("");
    expect(form().classList.contains("is-sheet-dragging")).toBeFalse();
    expect(document.body.classList.contains("sheet-dragging")).toBeFalse();
  });

  test("the same sheet under a finger is dragged and pushes the page back", async () => {
    press("touch");
    open();
    await act(async () => { await pause(); });
    expect(dialog().className).toBe("modal sheet");
    expect(document.body.classList.contains("sheet-open")).toBeTrue();
    drag(240);
    expect(form().style.transform).toBe("translateY(240px)");
    touch(dialog(), "touchend", 240, 110);
  });

  test("a card that became the sheet gains the gesture and the receding page", async () => {
    press("mouse");
    open();
    await act(async () => { await pause(); });
    expect(document.body.classList.contains("sheet-open")).toBeFalse();
    resize(700);
    await act(async () => { await pause(); });
    expect(dialog().className).toBe("modal sheet");
    expect(document.body.classList.contains("sheet-open")).toBeTrue();
    drag(60);
    expect(form().style.transform).toBe("translateY(60px)");
    touch(dialog(), "touchend", 60, 400);
  });

  test("widened again it is the card: the page comes forward and the drag is gone", async () => {
    press("mouse");
    open();
    resize(700);
    await act(async () => { await pause(); });
    expect(document.body.classList.contains("sheet-open")).toBeTrue();
    // Caught mid-drag by the wider window, the sheet is let go where it started.
    drag(60);
    expect(form().classList.contains("is-sheet-dragging")).toBeTrue();
    resize(800);
    await act(async () => { await pause(); });
    expect(dialog().className).toBe("modal sheet desk-form");
    expect(document.body.classList.contains("sheet-open")).toBeFalse();
    expect(document.body.classList.contains("sheet-dragging")).toBeFalse();
    expect(form().style.transform).toBe("");
    expect(form().classList.contains("is-sheet-dragging")).toBeFalse();
    touch(dialog(), "touchend", 60, 400);
    expect(dialog().open).toBeTrue();
    drag(240);
    expect(form().style.transform).toBe("");
    // And the sheet once more, with everything a sheet has.
    resize(700);
    await act(async () => { await pause(); });
    expect(document.body.classList.contains("sheet-open")).toBeTrue();
    drag(60);
    expect(form().style.transform).toBe("translateY(60px)");
    touch(dialog(), "touchend", 60, 400);
  });

  test("a card over a finger's sheet does not bring the page forward", async () => {
    const raw = (className: string) => {
      const element = document.createElement("dialog");
      element.className = className;
      const inner = document.createElement("form");
      element.append(inner);
      document.body.append(element);
      element.showModal();
      return { element, release: bindSheetDrag({ dialog: element, form: inner, close: () => element.close() }) };
    };
    const sheet = raw("modal sheet");
    const card = raw("modal sheet desk-form");
    await pause();
    expect(document.body.classList.contains("sheet-open")).toBeTrue();
    // The card's own class changing asks again, and still leaves the other's page alone.
    card.element.classList.add("is-expanded");
    await pause();
    expect(document.body.classList.contains("sheet-open")).toBeTrue();
    card.release();
    expect(document.body.classList.contains("sheet-open")).toBeTrue();
    sheet.release();
    expect(document.body.classList.contains("sheet-open")).toBeFalse();
    card.element.remove();
    sheet.element.remove();
  });
});
