import { expectSameNode } from "../../../../test-support/node-identity";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { closeTestDialogs } from "../../../../test-support/close-dialogs";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { setLang } from "../../../lib/i18n";
import { MenuItem, MenuSection, showActionSheet } from "./action-sheet";
import { MenuRow } from "./menu-controls";
import { bindOverlayOrigin } from "./origin";
import { dismissPopovers } from "./popover";
import { useSheetNav } from "./sheet-stack";

/**
 * An open popover follows the window: below the desk tier the same dialog is
 * the bottom sheet, with what the reader left in it, and back inside the tier
 * it hangs from its trigger again or, without one, is the desk card.
 */
const pause = (ms = 0) => new Promise<void>(resolve => setTimeout(resolve, ms));
const sheet = () => document.querySelector<HTMLDialogElement>("dialog.sheet")!;
let release = () => {};
let trigger: HTMLButtonElement;

function press(target: Element, pointerType: string, init: Record<string, unknown> = {}): void {
  target.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerType, clientX: 500, clientY: 300, ...init }) as unknown as Event);
}
/** The way back to the anchor is decided a frame after the resize, once the shell has drawn the new width. */
async function resize(width: number): Promise<void> {
  happy.happyDOM.setWindowSize({ width, height: 700 });
  await act(async () => {
    window.dispatchEvent(new happy.Event("resize") as unknown as Event);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    await pause();
  });
}
function box(left: number): void {
  trigger.getBoundingClientRect = () => ({ left, top: 50, right: left + 40, bottom: 90, width: 40, height: 40, x: left, y: 50, toJSON() {} });
}
function commands(): void {
  showActionSheet("Session", modal => <>
    <MenuItem modal={modal}>Pin</MenuItem>
    <MenuSection title="Tab"><MenuItem modal={modal}>Rename tab</MenuItem><MenuItem modal={modal} danger>Close tab</MenuItem></MenuSection>
  </>, { popover: "menu" });
}
function RenameRow() {
  const nav = useSheetNav()!;
  return <MenuRow label="Rename" next onClick={() => nav.push({ key: "rename", title: "Rename",
    render: () => <input aria-label="Name" /> })} />;
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  happy.happyDOM.setWindowSize({ width: 800, height: 700 });
  trigger = document.createElement("button");
  trigger.setAttribute("aria-haspopup", "dialog");
  box(100);
  document.body.append(trigger);
  release = bindOverlayOrigin(document);
});
afterEach(async () => {
  await act(async () => { closeTestDialogs(); await pause(); });
  release();
  trigger.remove();
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
});

test("shrinking to the phone layout hands the open popover to the sheet; widening hangs it from its trigger again", async () => {
  press(trigger, "mouse");
  act(commands);
  const dialog = sheet();
  expect(dialog.className).toBe("modal sheet popover popover-menu");
  await resize(700);
  // The same dialog, still open, laid out by the sheet's own rules.
  expectSameNode(sheet(), dialog);
  expect(dialog.open).toBeTrue();
  expect(dialog.className).toBe("modal sheet");
  expect(dialog.hasAttribute("data-popover")).toBeFalse();
  expect([dialog.style.left, dialog.style.top, dialog.style.maxHeight]).toEqual(["", "", ""]);
  expect(dialog.querySelector(".sheet-body")!.hasAttribute("role")).toBeFalse();
  expect(dialog.querySelectorAll("[role=menuitem], [role=group]").length).toBe(0);
  // It holds the page back like any sheet (the gesture hears of the change on
  // the next microtask), and no longer marks a trigger as its own.
  await act(async () => { await pause(); });
  expect(document.body.classList.contains("sheet-open")).toBeTrue();
  expect(trigger.hasAttribute("data-popover-open")).toBeFalse();
  expect(trigger.hasAttribute("aria-expanded")).toBeFalse();
  // A blocking sheet is not a popover to sweep away.
  expect(dismissPopovers()).toBeFalse();

  box(60);
  await resize(800);
  expectSameNode(sheet(), dialog);
  expect(dialog.className).toBe("modal sheet popover popover-menu");
  expect(dialog.dataset.popover).toBe("menu");
  expect(dialog.style.left).toBe("60px");
  expect(dialog.style.top).toBe("96px");
  expect(dialog.querySelector(".sheet-body")!.getAttribute("role")).toBe("menu");
  expect(trigger.getAttribute("data-popover-open")).toBe("menu");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  await act(async () => { await pause(); });
  expect(document.body.classList.contains("sheet-open")).toBeFalse();
});

test("an open popover follows its trigger when the page moves it without a resize of its own", async () => {
  press(trigger, "mouse");
  act(commands);
  const dialog = sheet();
  expect([dialog.style.left, dialog.style.top]).toEqual(["100px", "96px"]);
  const frame = () => act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); await pause(); });
  // The board fits its camera a moment after the window changed, the shell regrids: no event reaches the popover.
  trigger.getBoundingClientRect = () => ({ left: 300, top: 400, right: 340, bottom: 440, width: 40, height: 40, x: 300, y: 400, toJSON() {} });
  await frame();
  expectSameNode(sheet(), dialog);
  expect([dialog.style.left, dialog.style.top]).toEqual(["300px", "446px"]);
  // While nothing it depends on changes it is left where it is: no placement runs, so nothing can make it twitch.
  dialog.style.left = "1px";
  await frame();
  await frame();
  expect(dialog.style.left).toBe("1px");
  // A window that changed shape with the trigger in place is a change too.
  happy.happyDOM.setWindowSize({ width: 900, height: 420 });
  await frame();
  expect([dialog.style.left, dialog.style.maxHeight]).toEqual(["300px", "404px"]);
  // Closed, it stops asking: the trigger can go anywhere.
  await act(async () => { closeTestDialogs(); await pause(); });
  box(40);
  await frame();
  expect(dialog.style.left).toBe("");
});

test("a typed name on a pushed page, and the caret in it, survive the trip both ways", async () => {
  press(trigger, "mouse");
  act(() => showActionSheet("Panel", () => <RenameRow />, { popover: "panel" }));
  const dialog = sheet();
  act(() => dialog.querySelector<HTMLButtonElement>(".menu-row")!.click());
  const field = dialog.querySelector("input")!;
  field.value = "X";
  field.focus();
  for (const width of [700, 800, 700, 1024]) {
    await resize(width);
    expect(dialog.open).toBeTrue();
    expect(dialog.querySelector("h2")?.textContent).toBe("Rename");
    expectSameNode(dialog.querySelector("input"), field);
    expect(field.value).toBe("X");
    expectSameNode(document.activeElement, field);
    expect(dialog.className).toBe(width < 720 ? "modal sheet" : "modal sheet popover popover-panel");
  }
});

test("focus stays on the same command while a menu's rows change role and wrapper", async () => {
  press(trigger, "mouse");
  act(commands);
  const dialog = sheet();
  const close = () => [...dialog.querySelectorAll<HTMLButtonElement>(".menu-item")].find(item => item.textContent === "Close tab")!;
  close().focus();
  await resize(700);
  expectSameNode(document.activeElement, close());
  expect(close().hasAttribute("role")).toBeFalse();
  await resize(800);
  expectSameNode(document.activeElement, close());
  expect(close().getAttribute("role")).toBe("menuitem");
});

test("a context-click menu comes back hanging from the control it was made on, not at the old point", async () => {
  press(trigger, "mouse", { button: 2, clientX: 620, clientY: 410 });
  act(commands);
  const dialog = sheet();
  expect([dialog.style.left, dialog.style.top]).toEqual(["620px", "410px"]);
  await resize(700);
  expect(dialog.className).toBe("modal sheet");
  box(60);
  await resize(800);
  // The point belonged to a window that has since changed shape; the control is where the keyboard would have opened it.
  expectSameNode(sheet(), dialog);
  expect(dialog.className).toBe("modal sheet popover popover-menu");
  expect([dialog.style.left, dialog.style.top]).toEqual(["60px", "96px"]);
  expect(trigger.getAttribute("data-popover-open")).toBe("menu");
  // It is anchored from here on: the next resize inside the tier follows the control, not the point.
  box(200);
  await resize(1024);
  expect([dialog.style.left, dialog.style.top]).toEqual(["200px", "96px"]);
  await act(async () => { closeTestDialogs(); await pause(); });
  expectSameNode(document.activeElement, trigger);
});

test("a row's context menu finds its row again by the session it names", async () => {
  trigger.className = "card-main";
  trigger.setAttribute("data-trigger-of", "p2");
  press(trigger, "mouse", { button: 2, clientX: 150, clientY: 70 });
  act(commands);
  const dialog = sheet();
  expect(dialog.style.left).toBe("150px");
  await resize(700);
  // The shell drew the list again: every row is a `card-main`, told apart by its session.
  const rows = ["p1", "p2", "p3"].map((pane, index) => {
    const row = trigger.cloneNode(true) as HTMLButtonElement;
    row.removeAttribute("data-popover-open");
    row.setAttribute("data-trigger-of", pane);
    const top = 100 + index * 50;
    row.getBoundingClientRect = () => ({ left: 8, top, right: 268, bottom: top + 46, width: 260, height: 46, x: 8, y: top, toJSON() {} });
    document.body.append(row);
    return row;
  });
  trigger.remove();
  await resize(800);
  expect(dialog.className).toBe("modal sheet popover popover-menu");
  expect([dialog.style.left, dialog.style.top]).toEqual(["8px", "202px"]);
  expect(rows.map(row => row.getAttribute("data-popover-open"))).toEqual([null, "menu", null]);
  await act(async () => { closeTestDialogs(); await pause(); });
  expectSameNode(document.activeElement, rows[1]);
  rows.forEach(row => row.remove());
});

test("a context click on something that is not a control, and a menu whose trigger is gone, come back as the desk card", async () => {
  const text = document.createElement("p");
  document.body.append(text);
  press(text, "mouse", { button: 2, clientX: 620, clientY: 410 });
  act(commands);
  let dialog = sheet();
  expect(dialog.style.left).toBe("620px");
  await resize(700);
  expect(dialog.className).toBe("modal sheet");
  await resize(800);
  // Nothing owns it: the point is gone and a paragraph is not a place to hang a menu from.
  expect(dialog.open).toBeTrue();
  expect(dialog.className).toBe("modal sheet desk-form");
  expect(dialog.hasAttribute("data-popover")).toBeFalse();
  expect(dialog.style.left).toBe("");
  // The card keeps following the window, and never claims an anchor back.
  await resize(700);
  expect(dialog.className).toBe("modal sheet");
  await resize(900);
  expect(dialog.className).toBe("modal sheet desk-form");
  act(() => closeTestDialogs());
  text.remove();

  press(trigger, "mouse");
  act(commands);
  dialog = sheet();
  await resize(700);
  trigger.remove();
  await resize(800);
  expect(dialog.open).toBeTrue();
  expect(dialog.className).toBe("modal sheet desk-form");

  // A context click's own control gone the same way: still the card.
  act(() => closeTestDialogs());
  document.body.append(trigger);
  press(trigger, "mouse", { button: 2, clientX: 620, clientY: 410 });
  act(commands);
  dialog = sheet();
  await resize(700);
  trigger.remove();
  await resize(800);
  expect(dialog.className).toBe("modal sheet desk-form");
});

test("the shell drew the trigger again: the popover hangs from the new one, and focus returns to it", async () => {
  trigger.className = "icon-btn";
  trigger.setAttribute("aria-label", "Session actions");
  press(trigger, "mouse");
  act(commands);
  const dialog = sheet();
  await resize(700);
  // Crossing the tier remounts the header: the same control, another element.
  const redrawn = trigger.cloneNode(true) as HTMLButtonElement;
  redrawn.getBoundingClientRect = () => ({ left: 300, top: 10, right: 340, bottom: 50, width: 40, height: 40, x: 300, y: 10, toJSON() {} });
  trigger.replaceWith(redrawn);
  await resize(800);
  expect(dialog.className).toBe("modal sheet popover popover-menu");
  expect(dialog.style.left).toBe("300px");
  expect(dialog.style.top).toBe("56px");
  expect(redrawn.getAttribute("data-popover-open")).toBe("menu");
  await act(async () => { closeTestDialogs(); await pause(); });
  expectSameNode(document.activeElement, redrawn);
  redrawn.remove();
});

test("one of several controls alike is not guessed at: the menu comes back as the card", async () => {
  trigger.className = "card-action";
  trigger.setAttribute("aria-label", "More");
  press(trigger, "mouse");
  act(commands);
  const dialog = sheet();
  await resize(700);
  const rows = [0, 1].map(() => {
    const more = trigger.cloneNode(true) as HTMLButtonElement;
    more.getBoundingClientRect = trigger.getBoundingClientRect;
    document.body.append(more);
    return more;
  });
  trigger.remove();
  await resize(800);
  expect(dialog.className).toBe("modal sheet desk-form");
  rows.forEach(more => more.remove());
});

test("a row's control names its session: the popover hangs from that row again, and focus returns to it", async () => {
  trigger.className = "card-action is-more";
  trigger.setAttribute("aria-label", "More");
  trigger.setAttribute("data-trigger-of", "p2");
  press(trigger, "mouse");
  act(commands);
  const dialog = sheet();
  await resize(700);
  // The shell drew the list again: every row has a "more", told apart by the session it is for.
  const rows = ["p1", "p2", "p3"].map((pane, index) => {
    const more = trigger.cloneNode(true) as HTMLButtonElement;
    more.setAttribute("data-trigger-of", pane);
    const top = 100 + index * 50;
    more.getBoundingClientRect = () => ({ left: 240, top, right: 268, bottom: top + 28, width: 28, height: 28, x: 240, y: top, toJSON() {} });
    document.body.append(more);
    return more;
  });
  trigger.remove();
  await resize(800);
  expect(dialog.className).toBe("modal sheet popover popover-menu");
  expect([dialog.style.left, dialog.style.top]).toEqual(["240px", "184px"]);
  expect(rows.map(more => more.getAttribute("data-popover-open"))).toEqual([null, "menu", null]);
  await act(async () => { closeTestDialogs(); await pause(); });
  expectSameNode(document.activeElement, rows[1]);
  rows.forEach(more => more.remove());
});

test("its row left the list meanwhile: the menu is the card, and focus goes where the opener calls home", async () => {
  trigger.className = "card-action is-more";
  trigger.setAttribute("aria-label", "More");
  trigger.setAttribute("data-trigger-of", "p2");
  const home = document.createElement("button");
  document.body.append(home);
  press(trigger, "mouse");
  act(() => showActionSheet("Session", modal => <MenuItem modal={modal}>Pin</MenuItem>, { popover: "menu", home: () => home }));
  const dialog = sheet();
  await resize(700);
  const other = trigger.cloneNode(true) as HTMLButtonElement;
  other.setAttribute("data-trigger-of", "p1");
  other.getBoundingClientRect = trigger.getBoundingClientRect;
  document.body.append(other);
  trigger.remove();
  await resize(800);
  expect(dialog.open).toBeTrue();
  expect(dialog.className).toBe("modal sheet desk-form");
  expect(other.hasAttribute("data-popover-open")).toBeFalse();
  await act(async () => { closeTestDialogs(); await pause(); });
  expectSameNode(document.activeElement, home);
  other.remove();
  home.remove();
});

test("a finger's sheet asks for no home: it left no keyboard position to give back", async () => {
  const home = document.createElement("button");
  document.body.append(home);
  press(trigger, "touch");
  act(() => showActionSheet("Session", modal => <MenuItem modal={modal}>Pin</MenuItem>, { popover: "menu", home: () => home }));
  expect(sheet().className).toBe("modal sheet");
  await act(async () => { closeTestDialogs(); await pause(); });
  expectSameNode(document.activeElement, document.body);
  home.remove();
});

test("a tool that shows only while its heading is pointed at is measured as the open one", async () => {
  trigger.className = "icon-btn group-tool";
  trigger.setAttribute("aria-label", "Workspace actions");
  press(trigger, "mouse");
  act(commands);
  const dialog = sheet();
  await resize(700);
  // Folded to nothing until hovered, focused or marked as the open trigger, as the rail's style sheet draws it.
  const redrawn = trigger.cloneNode(true) as HTMLButtonElement;
  redrawn.removeAttribute("data-popover-open");
  redrawn.removeAttribute("aria-expanded");
  redrawn.getBoundingClientRect = () => {
    const width = redrawn.hasAttribute("data-popover-open") ? 30 : 0;
    return { left: 200, top: 270, right: 200 + width, bottom: 300, width, height: 30, x: 200, y: 270, toJSON() {} };
  };
  trigger.replaceWith(redrawn);
  await resize(800);
  expect(dialog.className).toBe("modal sheet popover popover-menu");
  expect([dialog.style.left, dialog.style.top]).toEqual(["200px", "306px"]);
  expect(redrawn.getAttribute("data-popover-open")).toBe("menu");
  await act(async () => { closeTestDialogs(); await pause(); });
  expect(redrawn.hasAttribute("data-popover-open")).toBeFalse();
  redrawn.remove();
});

test("a finger's sheet stays a sheet however the window is resized", async () => {
  press(trigger, "touch");
  act(commands);
  const dialog = sheet();
  for (const width of [700, 800, 1024]) {
    await resize(width);
    expect(dialog.className).toBe("modal sheet");
    expect(dialog.style.left).toBe("");
  }
});
