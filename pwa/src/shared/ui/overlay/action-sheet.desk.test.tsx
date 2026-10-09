import { expectSameNode } from "../../../../test-support/node-identity";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { closeTestDialogs } from "../../../../test-support/close-dialogs";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { setLang, t } from "../../../lib/i18n";
import { MenuItem, MenuRadio, showActionSheet } from "./action-sheet";
import { askConfirm } from "./basic-dialogs";
import { MenuRow } from "./menu-controls";
import { DeskCancel } from "./modal";
import { bindOverlayOrigin } from "./origin";
import { SegmentedControl } from "../primitives";
import { useSheetNav } from "./sheet-stack";
import { tabStops } from "./tab-stops";

/**
 * A sheet in its desk form: anchored under its trigger as a panel, or the
 * centred card. The close control is written last, a pushed page has the desk
 * footer whose Cancel steps back, and stepping back returns to the control
 * that opened the page. A finger's sheet keeps its head and its order.
 */
const pause = (ms = 0) => new Promise<void>(resolve => setTimeout(resolve, ms));
const sheet = () => document.querySelector<HTMLDialogElement>("dialog.sheet")!;
const named = (text: string) => [...sheet().querySelectorAll<HTMLElement>("button, input")]
  .find(control => (control.getAttribute("aria-label") ?? control.textContent) === text)!;
const names = () => tabStops(sheet()).map(stop => stop.getAttribute("aria-label") ?? stop.textContent);
let release = () => {};
let trigger: HTMLButtonElement;

function press(pointerType: string): void {
  trigger.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerType, clientX: 40, clientY: 40 }) as unknown as Event);
}
function key(target: Element, name: string): KeyboardEvent {
  const event = new happy.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }) as unknown as KeyboardEvent;
  act(() => { target.dispatchEvent(event); });
  return event;
}

function Root() {
  const nav = useSheetNav()!;
  const page = (title: string) => () => nav.push({ key: title, title, render: () => <div className="create-footer">
    <input aria-label={`${title} name`} data-autofocus="" />
    <DeskCancel /><button type="button">Save</button>
  </div> });
  return <>
    <button type="button" aria-label="Copy path">/work</button>
    <SegmentedControl activation="manual" aria-label="Mode">
      <MenuRadio modal={null as never} label="Auto" aria="Auto" selected={false} action={() => {}} start />
      <MenuRadio modal={null as never} label="Chat" aria="Chat" selected action={() => {}} start />
    </SegmentedControl>
    <MenuRow label="Rename" next onClick={page("Rename")} />
    <MenuRow label="Split" next onClick={page("Split")} />
  </>;
}
const open = () => act(() => showActionSheet("Session", () => <Root />, { popover: "panel", anchor: trigger }));

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

test("the panel starts a mouse or the keyboard on its named control and writes the close last; the sheet keeps its head", () => {
  press("mouse");
  open();
  expect(sheet().className).toBe("modal sheet popover popover-panel");
  // `data-desk-autofocus`: the chosen mode, not the first button the panel happens to hold.
  expectSameNode(document.activeElement, named("Chat"));
  expect(sheet().querySelector(".sheet-close")).toBeNull();
  expectSameNode(sheet().querySelector("form")!.lastElementChild, sheet().querySelector(".desk-close"));
  expect(names()).toEqual(["Copy path", "Chat", "Rename", "Split", t("close")]);
  act(() => closeTestDialogs());

  press("touch");
  open();
  expect(sheet().className).toBe("modal sheet");
  expectSameNode(document.activeElement, named("Copy path"));
  expect(sheet().querySelector(".desk-close")).toBeNull();
  expect(sheet().querySelector(".sheet-head .sheet-close")).not.toBeNull();
  expect(sheet().querySelector(".desk-cancel")).toBeNull();
});

test("a pushed page has the way back, its form, Cancel then the action, and the close: in that order", () => {
  press("mouse");
  open();
  act(() => named("Rename").click());
  expect(sheet().querySelector("h2")?.textContent).toBe("Rename");
  expectSameNode(document.activeElement, named("Rename name"));
  expect(names()).toEqual([t("sheet.back"), "Rename name", t("cancel"), "Save", t("close")]);
  // Cancel steps back to the panel; it does not put the panel away.
  act(() => named(t("cancel")).click());
  expect(sheet().open).toBeTrue();
  expect(sheet().querySelector("h2")?.textContent).toBe("Session");
});

test("stepping back returns to the control that opened the page, by Escape, Cancel or Back", () => {
  press("mouse");
  open();
  for (const [row, leave] of [["Rename", "escape"], ["Split", "cancel"], ["Split", "back"]] as const) {
    // The press is what says which row it was: not every engine focuses a clicked button.
    named(row).dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }) as unknown as Event);
    act(() => named(row).click());
    expectSameNode(document.activeElement, named(`${row} name`));
    if (leave === "escape") expect(key(named(`${row} name`), "Escape").defaultPrevented).toBeTrue();
    else act(() => named(leave === "cancel" ? t("cancel") : t("sheet.back")).click());
    expect(sheet().open).toBeTrue();
    expectSameNode(document.activeElement, named(row));
  }
  // At the root Escape puts the panel away and focus goes back to its trigger.
  key(document.activeElement!, "Escape");
});

test("Tab does not leave the panel", () => {
  press("mouse");
  open();
  const close = sheet().querySelector<HTMLElement>(".desk-close")!;
  close.focus();
  expect(key(close, "Tab").defaultPrevented).toBeTrue();
  expectSameNode(document.activeElement, named("Copy path"));
});

test("a confirmed removal is followed only where a mouse or the keyboard asked beside the list", async () => {
  const globals = globalThis as { MutationObserver?: unknown };
  const real = globals.MutationObserver;
  globals.MutationObserver = happy.MutationObserver;
  const list = document.createElement("div");
  list.innerHTML = `<article><button id="a">a</button></article><article><button id="b">b</button></article>`;
  document.body.append(list);
  const [first, second] = [...list.querySelectorAll("button")];
  const confirmFrom = async (pointerType: string) => {
    first.focus();
    first.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerType }) as unknown as Event);
    let answer!: Promise<boolean>;
    act(() => { answer = askConfirm({ title: "Close?", confirmLabel: "Close" }); });
    await act(async () => { document.querySelector<HTMLButtonElement>("dialog.confirm .btn-danger")!.click(); await pause(); });
    expect(await answer).toBeTrue();
    expectSameNode(document.activeElement, first);
    const row = first.parentElement!;
    row.remove();
    first.blur();
    await pause();
    const landed = document.activeElement;
    list.prepend(row);
    return landed;
  };
  try {
    expectSameNode(await confirmFrom("mouse"), second);
    // A finger left no keyboard position to hand on.
    expectSameNode(await confirmFrom("touch"), document.body);
  } finally {
    list.remove();
    globals.MutationObserver = real;
  }
});

test("the card's body says what lies beyond its edges, so the head and a pinned footer are ruled off only then", () => {
  press("mouse");
  act(() => showActionSheet("Create", modal => <MenuItem modal={modal}>Go</MenuItem>));
  expect(sheet().className).toBe("modal sheet desk-form");
  const body = sheet().querySelector<HTMLElement>(".sheet-body")!;
  const lay = (scrollTop: number, clientHeight: number, scrollHeight: number) => {
    Object.defineProperties(body, {
      scrollTop: { value: scrollTop, configurable: true }, clientHeight: { value: clientHeight, configurable: true },
      scrollHeight: { value: scrollHeight, configurable: true },
    });
    body.dispatchEvent(new happy.Event("scroll") as unknown as Event);
  };
  const edges = () => [body.hasAttribute("data-above"), body.hasAttribute("data-below")];
  // A form that fits is one plain surface.
  lay(0, 400, 400);
  expect(edges()).toEqual([false, false]);
  lay(0, 400, 900);
  expect(edges()).toEqual([false, true]);
  lay(120, 400, 900);
  expect(edges()).toEqual([true, true]);
  lay(500, 400, 900);
  expect(edges()).toEqual([true, false]);
  act(() => closeTestDialogs());

  // The sheet draws its own bar and is not marked.
  press("touch");
  act(() => showActionSheet("Create", modal => <MenuItem modal={modal}>Go</MenuItem>));
  const sheetBody = sheet().querySelector<HTMLElement>(".sheet-body")!;
  Object.defineProperties(sheetBody, { scrollTop: { value: 50, configurable: true }, clientHeight: { value: 100, configurable: true },
    scrollHeight: { value: 900, configurable: true } });
  sheetBody.dispatchEvent(new happy.Event("scroll") as unknown as Event);
  expect([sheetBody.hasAttribute("data-above"), sheetBody.hasAttribute("data-below")]).toEqual([false, false]);
});

test("a trigger drawn again while the panel was open takes focus back in its new place", async () => {
  trigger.className = "icon-btn icon-more";
  trigger.setAttribute("aria-label", "Session actions");
  press("mouse");
  open();
  // What the panel did replaced the header, and its "more" with it.
  const again = trigger.cloneNode(true) as HTMLButtonElement;
  trigger.replaceWith(again);
  await act(async () => { closeTestDialogs(); await pause(); });
  expectSameNode(document.activeElement, again);
  again.remove();
  document.body.append(trigger);

  // One of several alike is not guessed at.
  press("mouse");
  open();
  const twins = [trigger.cloneNode(true) as HTMLButtonElement, trigger.cloneNode(true) as HTMLButtonElement];
  trigger.replaceWith(...twins);
  await act(async () => { closeTestDialogs(); await pause(); });
  expectSameNode(document.activeElement, document.body);
  for (const twin of twins) twin.remove();
  document.body.append(trigger);
});

test("a menu keeps its own head, and its rows are not a form to cancel", () => {
  press("mouse");
  act(() => showActionSheet("Row", modal => <><MenuItem modal={modal}>Pin</MenuItem><DeskCancel /></>, { popover: "menu", anchor: trigger }));
  expect(sheet().className).toBe("modal sheet popover popover-menu");
  expect(sheet().querySelector(".desk-close")).toBeNull();
  expect(sheet().querySelector(".desk-cancel")).toBeNull();
  expect(sheet().querySelector(".sheet-head .sheet-close")).not.toBeNull();
});
