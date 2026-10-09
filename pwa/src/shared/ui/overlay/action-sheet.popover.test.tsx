import { expectSameNode, expectSameNodes } from "../../../../test-support/node-identity";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { closeTestDialogs } from "../../../../test-support/close-dialogs";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { setLang } from "../../../lib/i18n";
import { MenuItem, MenuSection, showActionSheet } from "./action-sheet";
import { MenuChoice } from "./menu-choice";
import { MenuGroup, MenuRow } from "./menu-controls";
import { bindOverlayOrigin } from "./origin";
import { dismissPopovers } from "./popover";
import { useSheetNav } from "./sheet-stack";

/**
 * The same action sheet, anchored: a mouse or key open on a desk layout gets a
 * popover at what opened it, and every other open is still the sheet.
 */
const pause = (ms = 0) => new Promise<void>(resolve => setTimeout(resolve, ms));
const sheet = () => document.querySelector<HTMLDialogElement>("dialog.sheet")!;
const items = () => [...sheet().querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
let release = () => {};
let trigger: HTMLButtonElement;

function press(target: Element, pointerType: string, init: Record<string, unknown> = {}): void {
  target.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerType, clientX: 500, clientY: 300, ...init }) as unknown as Event);
}
function key(target: Element, name: string): KeyboardEvent {
  const event = new happy.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }) as unknown as KeyboardEvent;
  target.dispatchEvent(event);
  return event;
}
function commands(): void {
  showActionSheet("Session", modal => <>
    <MenuItem modal={modal}>Pin</MenuItem>
    <MenuItem modal={modal} disabled>Unavailable</MenuItem>
    <MenuChoice modal={modal} title="Rename" />
    <MenuSection title="Manage"><MenuGroup><MenuRow modal={modal} action={() => {}} label="Close" danger /></MenuGroup></MenuSection>
  </>, { popover: "menu", subtitle: "api-server" });
}

function resize(width: number): void {
  happy.happyDOM.setWindowSize({ width, height: 700 });
  act(() => { window.dispatchEvent(new happy.Event("resize") as unknown as Event); });
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
  trigger = document.createElement("button");
  trigger.getBoundingClientRect = () => ({ left: 100, top: 50, right: 140, bottom: 90, width: 40, height: 40, x: 100, y: 50, toJSON() {} });
  document.body.append(trigger);
  release = bindOverlayOrigin(document);
});
afterEach(async () => {
  await act(async () => { closeTestDialogs(); await pause(); });
  release();
  trigger.remove();
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
});

test("a mouse click opens a menu under its trigger with menu semantics and no sheet gesture", () => {
  press(trigger, "mouse");
  act(commands);
  const dialog = sheet();
  expect(dialog.open).toBeTrue();
  expect(dialog.className).toBe("modal sheet popover popover-menu");
  expect(dialog.dataset.popover).toBe("menu");
  expect(dialog.style.left).toBe("100px");
  expect(dialog.style.top).toBe("96px");
  expect(dialog.style.maxHeight).toBe("884px");
  const body = dialog.querySelector(".sheet-body")!;
  expect(body.getAttribute("role")).toBe("menu");
  expect(body.getAttribute("aria-labelledby")).toBe(dialog.querySelector("h2")!.id);
  expect(items().map(item => item.textContent)).toEqual(["Pin", "Unavailable", "Rename", "Close"]);
  expect(dialog.querySelector("[role=group][aria-label=Manage] .menu-section-title")?.getAttribute("aria-hidden")).toBe("true");
  expect(document.activeElement?.textContent).toBe("Pin");
  expect(document.body.classList.contains("sheet-open")).toBeFalse();
  // The trigger is marked as the open one for as long as its menu is up.
  expect(trigger.getAttribute("data-popover-open")).toBe("menu");
  act(() => closeTestDialogs());
  expect(trigger.hasAttribute("data-popover-open")).toBeFalse();
});

test("a context click opens the menu at the pointer", () => {
  press(trigger, "mouse", { button: 2, clientX: 620, clientY: 410 });
  act(commands);
  expect(sheet().style.left).toBe("620px");
  expect(sheet().style.top).toBe("410px");
});

test("arrow keys walk the enabled commands and wrap; Home and End reach the ends", () => {
  press(trigger, "mouse");
  act(commands);
  const [pin, rename, close] = items().filter(item => !item.disabled);
  expect(key(pin, "ArrowDown").defaultPrevented).toBeTrue();
  expectSameNode(document.activeElement, rename);
  key(rename, "ArrowDown");
  expectSameNode(document.activeElement, close);
  key(close, "ArrowDown");
  expectSameNode(document.activeElement, pin);
  key(pin, "ArrowUp");
  expectSameNode(document.activeElement, close);
  key(close, "Home");
  expectSameNode(document.activeElement, pin);
  key(pin, "End");
  expectSameNode(document.activeElement, close);
});

test("a press outside closes at once and focus returns to the trigger", async () => {
  press(trigger, "mouse");
  act(commands);
  const dialog = sheet();
  // Inside the dialog's own box (a border, a gap between rows) is not outside.
  dialog.getBoundingClientRect = () => ({ left: 100, top: 96, right: 320, bottom: 300, width: 220, height: 204, x: 100, y: 96, toJSON() {} });
  act(() => press(dialog, "mouse", { clientX: 150, clientY: 120 }));
  expect(dialog.open).toBeTrue();
  await act(async () => { press(dialog, "mouse", { clientX: 700, clientY: 500 }); await pause(); });
  expect(document.querySelector("dialog.sheet")).toBeNull();
  expectSameNode(document.activeElement, trigger);
});

test("between the phone and the roomy width a mouse still gets the popover, and it follows its trigger", () => {
  happy.happyDOM.setWindowSize({ width: 800, height: 700 });
  press(trigger, "mouse");
  act(commands);
  const dialog = sheet();
  expect(dialog.className).toBe("modal sheet popover popover-menu");
  expect(dialog.style.left).toBe("100px");
  expect(document.body.classList.contains("sheet-open")).toBeFalse();
  trigger.getBoundingClientRect = () => ({ left: 60, top: 50, right: 100, bottom: 90, width: 40, height: 40, x: 60, y: 50, toJSON() {} });
  resize(760);
  expect(dialog.open).toBeTrue();
  expect(dialog.style.left).toBe("60px");
  // On the phone layout the same mouse opens the sheet.
  act(() => closeTestDialogs());
  happy.happyDOM.setWindowSize({ width: 700, height: 700 });
  press(trigger, "mouse");
  act(commands);
  expect(sheet().className).toBe("modal sheet");
});
test("Escape closes the popover like any sheet", async () => {
  press(trigger, "mouse");
  act(commands);
  await act(async () => {
    sheet().dispatchEvent(new happy.Event("cancel", { cancelable: true }) as unknown as Event);
    await pause();
  });
  expect(document.querySelector("dialog.sheet")).toBeNull();
});

test("a finger on the same layout, and any open on a phone, gets the unchanged sheet", () => {
  press(trigger, "touch");
  act(commands);
  let dialog = sheet();
  expect(dialog.className).toBe("modal sheet");
  expect(dialog.hasAttribute("data-popover")).toBeFalse();
  expect(dialog.style.left).toBe("");
  expect(dialog.querySelector(".sheet-body")!.hasAttribute("role")).toBeFalse();
  expect(dialog.querySelectorAll("[role=menuitem], [role=group]").length).toBe(0);
  expect([...dialog.querySelector(".sheet-body")!.children].map(node => node.tagName)).toEqual(["BUTTON", "BUTTON", "BUTTON", "H3", "DIV"]);
  expect(dialog.querySelector(".sheet-subtitle")?.textContent).toBe("api-server");
  act(() => closeTestDialogs());

  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
  press(trigger, "mouse");
  act(commands);
  dialog = sheet();
  expect(dialog.className).toBe("modal sheet");
  expect(dialog.hasAttribute("data-popover")).toBeFalse();
});

test("a caller that does not ask for a popover is never anchored: a mouse gets the centred card", () => {
  press(trigger, "mouse");
  act(() => showActionSheet("Actions", modal => <MenuItem modal={modal}>Run</MenuItem>));
  expect(sheet().className).toBe("modal sheet desk-form");
  expect(sheet().hasAttribute("data-popover")).toBeFalse();
  expect(sheet().style.left).toBe("");
  expect(sheet().querySelector(".menu-item")!.hasAttribute("role")).toBeFalse();
});

function PushRow() {
  const nav = useSheetNav()!;
  return <MenuRow label="Details" next onClick={() => nav.push({ key: "details", title: "Details",
    render: () => <><MenuRow label="Inside" onClick={() => {}} /><input aria-label="Name" /></> })} />;
}

test("a panel keeps its controls as they are, and a pushed page in a menu is not a command list", () => {
  press(trigger, "mouse");
  act(() => showActionSheet("Panel", () => <PushRow />, { popover: "panel", className: "pane-menu-sheet" }));
  let dialog = sheet();
  expect(dialog.className).toBe("modal sheet popover popover-panel pane-menu-sheet");
  expect(dialog.querySelector(".sheet-body")!.hasAttribute("role")).toBeFalse();
  expect(dialog.querySelector(".menu-row")!.hasAttribute("role")).toBeFalse();
  // Its settings own their arrow keys; the panel adds no menu navigation.
  expect(key(dialog.querySelector(".menu-row")!, "ArrowDown").defaultPrevented).toBeFalse();
  act(() => closeTestDialogs());

  press(trigger, "mouse");
  act(() => showActionSheet("Menu", () => <PushRow />, { popover: "menu" }));
  dialog = sheet();
  act(() => dialog.querySelector<HTMLButtonElement>("[role=menuitem]")!.click());
  expect(dialog.querySelector("h2")?.textContent).toBe("Details");
  expect(dialog.querySelector(".sheet-body")!.hasAttribute("role")).toBeFalse();
  expect(dialog.querySelector(".menu-row")!.hasAttribute("role")).toBeFalse();
  expect(key(dialog.querySelector("input")!, "ArrowDown").defaultPrevented).toBeFalse();
});

test("dismissPopovers closes popovers only and runs the follow-up after focus is back", async () => {
  expect(dismissPopovers()).toBeFalse();
  press(trigger, "touch");
  act(commands);
  expect(dismissPopovers()).toBeFalse();
  expect(sheet().open).toBeTrue();
  act(() => closeTestDialogs());

  press(trigger, "mouse");
  act(commands);
  const seen: Array<Element | null> = [];
  await act(async () => {
    expect(dismissPopovers(() => seen.push(document.querySelector("dialog.sheet"), document.activeElement))).toBeTrue();
    await pause(10);
  });
  expectSameNodes(seen, [null, trigger]);
});
