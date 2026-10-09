import { expectSameNode } from "../../../../test-support/node-identity";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { closeTestDialogs } from "../../../../test-support/close-dialogs";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { setLang } from "../../../lib/i18n";
import { MenuItem, showActionSheet } from "./action-sheet";
import { MenuRow } from "./menu-controls";
import { bindOverlayOrigin } from "./origin";
import { useSheetNav } from "./sheet-stack";

/**
 * An open popover whose trigger leaves the page inside the desk tier: a menu
 * closes, a dialog holding the reader's work becomes the desk card, and a
 * trigger the shell only drew again is followed to its new element.
 */
const pause = (ms = 0) => new Promise<void>(resolve => setTimeout(resolve, ms));
const frame = () => act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); await pause(); });
/** Two frames: one to see the trigger gone, one to see it stay gone. */
const settle = async () => { await frame(); await frame(); await frame(); };
const sheet = () => document.querySelector<HTMLDialogElement>("dialog.sheet");
let release = () => {};
let column: HTMLDivElement;
let trigger: HTMLButtonElement;

function press(target: Element, pointerType: string, init: Record<string, unknown> = {}): void {
  target.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerType, clientX: 500, clientY: 300, ...init }) as unknown as Event);
}
/**
 * A control's box, and none while what holds it is not drawn, as a browser
 * measures it. Whether it is drawn is answered here too, on the control itself:
 * the DOM these tests run in is shared, and its own answer is not always there.
 */
function boxed(control: HTMLElement, left: number): void {
  const drawn = () => control.isConnected && column.style.display !== "none";
  control.checkVisibility = drawn;
  control.getBoundingClientRect = () => {
    const size = drawn() ? 40 : 0;
    return { left, top: 50, right: left + size, bottom: 50 + size, width: size, height: size, x: left, y: 50, toJSON() {} };
  };
}
function commands(home?: () => HTMLElement | null): void {
  showActionSheet("File", modal => <><MenuItem modal={modal}>Copy path</MenuItem><MenuItem modal={modal} danger>Delete file…</MenuItem></>,
    { popover: "menu", home });
}
function RenameRow() {
  const nav = useSheetNav()!;
  return <MenuRow label="Rename" next onClick={() => nav.push({ key: "rename", title: "Rename",
    render: () => <input aria-label="Name" /> })} />;
}
async function resize(width: number): Promise<void> {
  happy.happyDOM.setWindowSize({ width, height: 700 });
  await act(async () => { window.dispatchEvent(new happy.Event("resize") as unknown as Event); });
  await settle();
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
  column = document.createElement("div");
  trigger = document.createElement("button");
  trigger.className = "row-more";
  trigger.setAttribute("aria-label", "README.md actions");
  trigger.setAttribute("aria-haspopup", "menu");
  boxed(trigger, 1200);
  column.append(trigger);
  document.body.append(column);
  release = bindOverlayOrigin(document);
});
afterEach(async () => {
  await act(async () => { closeTestDialogs(); await pause(); });
  release();
  column.remove();
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
});

test("a menu whose trigger is removed from the page closes, and focus goes where the opener calls home", async () => {
  const home = document.createElement("button");
  document.body.append(home);
  press(trigger, "mouse");
  act(() => commands(() => home));
  const dialog = sheet()!;
  expect(dialog.className).toBe("modal sheet popover popover-menu");
  await settle();
  expect(dialog.open).toBeTrue();
  // The inspector is parked: its column, and the row with it, leave the page.
  column.remove();
  await settle();
  expect(dialog.open).toBeFalse();
  expect(sheet()).toBeNull();
  expectSameNode(document.activeElement, home);
  home.remove();
});

test("a menu whose trigger is still in the page but no longer drawn closes too", async () => {
  press(trigger, "mouse");
  act(() => commands());
  const dialog = sheet()!;
  // The list gives its column away: the rail is `display: none`, its rows are not removed.
  column.style.display = "none";
  await settle();
  expect(dialog.open).toBeFalse();
  expect(trigger.hasAttribute("data-popover-open")).toBeFalse();
  expect(trigger.hasAttribute("aria-expanded")).toBeFalse();
});

test("a trigger that only folds away under the inert page keeps its menu", async () => {
  press(trigger, "mouse");
  act(() => commands());
  const dialog = sheet()!;
  // A hover tool collapsed to nothing: in the layout, with no box.
  trigger.getBoundingClientRect = () => ({ left: 1200, top: 50, right: 1200, bottom: 50, width: 0, height: 0, x: 1200, y: 50, toJSON() {} });
  await settle();
  expect(dialog.open).toBeTrue();
  expect(dialog.className).toBe("modal sheet popover popover-menu");
  // Where the opening gesture saw it.
  expect(dialog.style.left).toBe("1200px");
});

test("a trigger away for a single frame is not given up on", async () => {
  press(trigger, "mouse");
  act(() => commands());
  const dialog = sheet()!;
  await settle();
  column.remove();
  // The popover's own frame callback is older than this one and runs first: it sees the trigger gone exactly once.
  await act(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => { document.body.append(column); resolve(); }));
  });
  await settle();
  expect(dialog.open).toBeTrue();
  expect(dialog.className).toBe("modal sheet popover popover-menu");
});

test("the shell drew the trigger again inside the tier: the same menu hangs from the new element", async () => {
  trigger.setAttribute("data-trigger-of", "README.md");
  press(trigger, "mouse");
  act(() => commands());
  const dialog = sheet()!;
  expect(dialog.style.left).toBe("1200px");
  const redrawn = trigger.cloneNode(true) as HTMLButtonElement;
  redrawn.removeAttribute("data-popover-open");
  redrawn.removeAttribute("aria-expanded");
  boxed(redrawn, 900);
  trigger.replaceWith(redrawn);
  await settle();
  expectSameNode(sheet(), dialog);
  expect(dialog.open).toBeTrue();
  expect(dialog.className).toBe("modal sheet popover popover-menu");
  expect(dialog.style.left).toBe("900px");
  expect(redrawn.getAttribute("data-popover-open")).toBe("menu");
  expect(redrawn.getAttribute("aria-expanded")).toBe("true");
  await act(async () => { closeTestDialogs(); await pause(); });
  expectSameNode(document.activeElement, redrawn);
});

test("a pushed page with a typed name is kept: the dialog becomes the desk card, and hangs again when the trigger is back", async () => {
  press(trigger, "mouse");
  act(() => showActionSheet("Panel", () => <RenameRow />, { popover: "panel" }));
  const dialog = sheet()!;
  act(() => dialog.querySelector<HTMLButtonElement>(".menu-row")!.click());
  const field = dialog.querySelector("input")!;
  field.value = "Typed name";
  field.focus();
  column.remove();
  await settle();
  expectSameNode(sheet(), dialog);
  expect(dialog.open).toBeTrue();
  expect(dialog.className).toBe("modal sheet desk-form");
  expect(dialog.hasAttribute("data-popover")).toBeFalse();
  expect(dialog.style.left).toBe("");
  expectSameNode(dialog.querySelector("input"), field);
  expect(field.value).toBe("Typed name");
  expectSameNode(document.activeElement, field);
  // The column comes back with the wider window.
  document.body.append(column);
  await resize(1500);
  expect(dialog.className).toBe("modal sheet popover popover-panel");
  expect(trigger.getAttribute("data-popover-open")).toBe("panel");
  expect(field.value).toBe("Typed name");
});

test("a panel showing only its settings holds nothing and closes like a menu", async () => {
  press(trigger, "mouse");
  act(() => showActionSheet("Panel", () => <RenameRow />, { popover: "panel" }));
  const dialog = sheet()!;
  column.remove();
  await settle();
  expect(dialog.open).toBeFalse();
});

test("a context click on something that is not a control has no owner to lose", async () => {
  const text = document.createElement("p");
  column.append(text);
  press(text, "mouse", { button: 2, clientX: 620, clientY: 410 });
  act(() => commands());
  const dialog = sheet()!;
  expect(dialog.style.left).toBe("620px");
  text.remove();
  await settle();
  expect(dialog.open).toBeTrue();
  expect(dialog.style.left).toBe("620px");
});

test("a context menu made on a row closes when the row leaves", async () => {
  trigger.setAttribute("data-trigger-of", "p2");
  press(trigger, "mouse", { button: 2, clientX: 620, clientY: 410 });
  act(() => commands());
  const dialog = sheet()!;
  expect(dialog.style.left).toBe("620px");
  trigger.remove();
  await settle();
  expect(dialog.open).toBeFalse();
});

test("below the desk tier the sheet does not ask: a trigger gone meanwhile is the card's business on the way back", async () => {
  press(trigger, "mouse");
  act(() => commands());
  const dialog = sheet()!;
  await resize(700);
  expect(dialog.className).toBe("modal sheet");
  column.remove();
  await settle();
  expect(dialog.open).toBeTrue();
  await resize(1440);
  expect(dialog.open).toBeTrue();
  expect(dialog.className).toBe("modal sheet desk-form");
});
