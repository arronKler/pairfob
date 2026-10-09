import { expectSameNode } from "../../../../test-support/node-identity";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { closeTestDialogs } from "../../../../test-support/close-dialogs";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { setLang, t } from "../../../lib/i18n";
import { showActionSheet } from "./action-sheet";
import { useEscapeStep } from "./escape-steps";
import { MenuRow } from "./menu-controls";
import { DeskCancel, DIALOG_STEP, ModalFrame, presentModal, stepClass } from "./modal";
import { bindOverlayOrigin } from "./origin";
import { SheetFooter } from "./sheet-content";
import { useSheetNav } from "./sheet-stack";
import { tabStops } from "./tab-stops";

/**
 * One rule for Escape in every dialog: it takes back the last step first (a
 * question asked in place, then a pushed page, then the dialog), and a dialog
 * that opened over another as its next step leaves the first one standing.
 * And one place for a desk card's footer: under the scrolling body.
 */
const pause = (ms = 0) => new Promise<void>(resolve => setTimeout(resolve, ms));
const dialogs = () => [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")];
const top = () => dialogs().at(-1)!;
const named = (text: string) => [...top().querySelectorAll<HTMLElement>("button, input")]
  .find(control => (control.getAttribute("aria-label") ?? control.textContent) === text)!;
let release = () => {};
let trigger: HTMLButtonElement;

function press(pointerType: string): void {
  trigger.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerType, clientX: 40, clientY: 40 }) as unknown as Event);
}
/** The key as a keyboard sends it: down on what has focus, then up. */
function escape(): void {
  const target = document.activeElement ?? document.body;
  act(() => { target.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event); });
  act(() => { target.dispatchEvent(new happy.KeyboardEvent("keyup", { key: "Escape", bubbles: true }) as unknown as Event); });
}

/** A row that asks in place, as the session panel's close does. */
function Asking({ label }: { label: string }) {
  const [asking, setAsking] = useState(false);
  useEscapeStep(asking, () => setAsking(false));
  return <>
    <button type="button" onClick={() => setAsking(true)}>{label}</button>
    {asking ? <div className="question"><button type="button" onClick={() => setAsking(false)}>{`Keep ${label}`}</button></div> : null}
  </>;
}

function Root() {
  const nav = useSheetNav()!;
  return <>
    <Asking label="Close" />
    <MenuRow label="Rename" next onClick={() => nav.push({ key: "rename", title: "Rename", render: () => <div className="form">
      <input aria-label="Name" data-autofocus="" />
      <Asking label="Reset" />
      <SheetFooter><div className="create-footer"><DeskCancel /><button type="button">Save</button></div></SheetFooter>
    </div> })} />
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

test("Escape undoes the last step first: the question asked in place, then the page, then the sheet", async () => {
  press("mouse");
  open();
  act(() => named("Rename").click());
  act(() => named("Reset").click());
  expect(top().querySelector(".question")).not.toBeNull();
  escape();
  // Only the question went: the page it was asked on is still the page.
  expect(top().querySelector(".question")).toBeNull();
  expect(top().querySelector("h2")?.textContent).toBe("Rename");
  escape();
  expect(top().querySelector("h2")?.textContent).toBe("Session");
  act(() => named("Close").click());
  escape();
  expect(dialogs()).toHaveLength(1);
  expect(top().querySelector(".question")).toBeNull();
  escape();
  await act(async () => { await pause(); });
  expect(dialogs()).toHaveLength(0);
});

test("a close request that is no key means the whole step back, as before: a phone's system back skips nothing new", () => {
  press("mouse");
  open();
  act(() => named("Rename").click());
  act(() => named("Reset").click());
  act(() => { top().dispatchEvent(new happy.Event("cancel", { cancelable: true }) as unknown as Event); });
  // The page is stepped back from, question and all: the request did not come from Escape.
  expect(top().querySelector("h2")?.textContent).toBe("Session");
});

test("Escape pressed with focus on nothing still undoes the step: the browser's close request arrives while the key is down", () => {
  press("mouse");
  open();
  act(() => named("Close").click());
  act(() => { window.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Escape" }) as unknown as Event); });
  act(() => { top().dispatchEvent(new happy.Event("cancel", { cancelable: true }) as unknown as Event); });
  act(() => { window.dispatchEvent(new happy.KeyboardEvent("keyup", { key: "Escape" }) as unknown as Event); });
  expect(dialogs()).toHaveLength(1);
  expect(top().querySelector(".question")).toBeNull();
});

test("a plain dialog has the same rule: its step, then itself", async () => {
  press("mouse");
  act(() => { presentModal<void>(modal => <ModalFrame modal={modal} title="Plain"><Asking label="Erase" /></ModalFrame>); });
  act(() => named("Erase").click());
  named("Keep Erase").focus();
  // Past the guard that keeps the press which opened a dialog from also closing it.
  await pause(420);
  escape();
  expect(dialogs()).toHaveLength(1);
  expect(top().querySelector(".question")).toBeNull();
  named("Erase").focus();
  escape();
  await act(async () => { await pause(); });
  expect(dialogs()).toHaveLength(0);
});

test("a dialog opened over another is its next step: putting it away leaves the first, with focus on the row that asked", async () => {
  press("mouse");
  open();
  expect(stepClass()).toBe(DIALOG_STEP);
  const row = named("Close");
  row.focus();
  const step = stepClass();
  act(() => { presentModal<void>(modal => <ModalFrame modal={modal} title="Step" className={`modal ${step}`}>
    <button type="button">Inside</button></ModalFrame>); });
  expect(dialogs()).toHaveLength(2);
  expect(top().classList.contains(DIALOG_STEP)).toBeTrue();
  // A modal on top takes focus in a browser; here it is put there by hand.
  named("Inside").focus();
  await pause(420);
  escape();
  await act(async () => { await pause(); });
  expect(dialogs()).toHaveLength(1);
  expect(top().querySelector("h2")?.textContent).toBe("Session");
  expectSameNode(document.activeElement, row);
  act(() => closeTestDialogs());
  expect(stepClass()).toBe("");
});

test("the desk card writes a page's footer under its scrolling body; Tab still walks the form, the footer, the close", () => {
  press("mouse");
  open();
  act(() => named("Rename").click());
  const foot = top().querySelector(".sheet-foot")!;
  expectSameNode(top().querySelector(".sheet-body")!.nextElementSibling, foot);
  expectSameNode(foot.querySelector(".create-footer")!.parentElement, foot);
  expect(top().querySelector(".sheet-body .create-footer")).toBeNull();
  expect(tabStops(top()).map(stop => stop.getAttribute("aria-label") ?? stop.textContent))
    .toEqual([t("sheet.back"), "Name", "Reset", t("cancel"), "Save", t("close")]);
  // Back on the root there is no footer, and the slot holds nothing to draw.
  escape();
  expect(top().querySelector(".sheet-foot")!.childElementCount).toBe(0);
});

test("a finger's sheet keeps the footer pinned inside its scroller", () => {
  press("touch");
  open();
  act(() => named("Rename").click());
  expect(top().querySelector(".sheet-foot")).toBeNull();
  expect(top().querySelector(".sheet-body .create-footer")).not.toBeNull();
});
