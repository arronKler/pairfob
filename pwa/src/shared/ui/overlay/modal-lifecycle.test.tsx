import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { closeTestDialogs } from "../../../../test-support/close-dialogs";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act, useLayoutEffect } from "react";
import { askConfirm, askText, showHelp } from "./basic-dialogs";
import { setLang } from "../../../lib/i18n";
import { ModalFrame, presentModal } from "./modal";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";

let pending: HTMLDialogElement[] = [];
let restoreClose: (() => void) | undefined;
const triggers: HTMLElement[] = [];

beforeEach(async () => { await resetBoardTestDOM(); setLang("zh"); });
afterEach(async () => {
  act(() => { for (const dialog of [...pending]) deliverClose(dialog); });
  restoreClose?.();
  restoreClose = undefined;
  pending = [];
  act(() => { closeTestDialogs(); unmountReact(); });
  await Promise.resolve();
  for (const trigger of triggers.splice(0)) trigger.remove();
});

// Exercise delayed close delivery explicitly: Happy DOM otherwise dispatches it
// synchronously. This models event ordering, not native top-layer/focus behavior.
function delayCloseEvents(): void {
  const spy = spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (this: HTMLDialogElement, value?: string) {
    if (!this.open) return;
    if (value !== undefined) this.returnValue = value;
    this.open = false;
    pending.push(this);
  });
  restoreClose = () => spy.mockRestore();
}

function deliverClose(dialog: HTMLDialogElement): void {
  pending = pending.filter(item => item !== dialog);
  dialog.dispatchEvent(new happy.Event("close") as unknown as Event);
}

function openDialog(): HTMLDialogElement {
  return document.querySelector<HTMLDialogElement>("dialog[data-react-modal][open]")!;
}

function trigger(): HTMLButtonElement {
  const button = document.createElement("button");
  button.textContent = "Open";
  document.body.append(button);
  triggers.push(button);
  button.focus();
  return button;
}

test("text result waits for native close delivery, then releases its portal and restores its trigger", async () => {
  delayCloseEvents();
  const opener = trigger();
  let result!: Promise<string | null>;
  act(() => { result = askText("Rename", "old"); });
  const dialog = openDialog();
  dialog.querySelector("input")!.value = "edited";
  let settlements = 0;
  void result.then(() => { settlements++; });
  act(() => dialog.querySelector("form")!.dispatchEvent(new happy.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  await Promise.resolve();
  expect(dialog.open).toBeFalse();
  expect(dialog.isConnected).toBeTrue();
  expect(settlements).toBe(0);
  act(() => deliverClose(dialog));
  expect(await result).toBe("edited");
  expect(settlements).toBe(1);
  expect(dialog.isConnected).toBeFalse();
  expect(document.activeElement).toBe(opener);
  act(() => deliverClose(dialog));
  await Promise.resolve();
  expect(settlements).toBe(1);
});

test("simultaneous text and confirmation dialogs keep results and cleanup scoped to their own portal", async () => {
  delayCloseEvents();
  let text!: Promise<string | null>;
  let confirm!: Promise<boolean>;
  act(() => { text = askText("Rename", "draft"); });
  const textDialog = openDialog();
  const input = textDialog.querySelector("input")!;
  input.value = "retained draft";
  act(() => { confirm = askConfirm("Confirm another action?"); });
  const confirmDialog = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].at(-1)!;
  act(() => confirmDialog.querySelector<HTMLButtonElement>(".btn-danger")!.click());
  act(() => deliverClose(confirmDialog));
  expect(await confirm).toBeTrue();
  expect(confirmDialog.isConnected).toBeFalse();
  expect(textDialog.open).toBeTrue();
  expect(textDialog.querySelector("input")).toBe(input);
  expect(input.value).toBe("retained draft");
  act(() => textDialog.close("cancel"));
  act(() => deliverClose(textDialog));
  expect(await text).toBeNull();
  expect(document.querySelectorAll("dialog[data-react-modal]")).toHaveLength(0);
});

test("late help close events neither remove a replacement nor clear its replacement registration", () => {
  delayCloseEvents();
  act(() => showHelp("First", ["one"]));
  const first = openDialog();
  act(() => showHelp("Second", ["two"]));
  const second = openDialog();
  expect(first.open).toBeFalse();
  expect(second).not.toBe(first);
  expect(document.querySelectorAll("dialog.help[open]")).toHaveLength(1);
  act(() => deliverClose(first));
  expect(first.isConnected).toBeFalse();
  expect(second.open).toBeTrue();
  act(() => showHelp("Third", ["three"]));
  const third = openDialog();
  expect(second.open).toBeFalse();
  act(() => deliverClose(second));
  expect(third.isConnected).toBeTrue();
  expect(third.querySelector("h2")?.textContent).toBe("Third");
  expect(document.querySelectorAll("dialog.help")).toHaveLength(1);
});

test("app-root replacement and unmount preserve the separate modal input and skip a removed focus target", async () => {
  act(() => renderReact(<button>Open rename</button>));
  const opener = document.querySelector<HTMLButtonElement>("#app button")!;
  opener.focus();
  let result!: Promise<string | null>;
  act(() => { result = askText("Rename", "draft"); });
  const dialog = openDialog();
  const input = dialog.querySelector("input")!;
  input.value = "unsaved draft";
  input.setSelectionRange(2, 7);
  act(() => renderReact(<section>Next route</section>));
  act(() => unmountReact());
  expect(opener.isConnected).toBeFalse();
  expect(dialog.isConnected).toBeTrue();
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("unsaved draft");
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 7]);
  act(() => dialog.querySelector<HTMLButtonElement>(".btn-ghost")!.click());
  expect(await result).toBeNull();
  expect(document.activeElement).not.toBe(opener);
});

test("a native close releases component effects and controller refs exactly once", async () => {
  let cleanups = 0;
  function Content() {
    useLayoutEffect(() => () => { cleanups++; }, []);
    return <p>Contents</p>;
  }
  let modal!: ReturnType<typeof presentModal<string>>;
  act(() => { modal = presentModal<string>(controller => <ModalFrame modal={controller} title="Lifecycle"><Content /></ModalFrame>); });
  const dialog = modal.dialog.current!;
  act(() => dialog.close("cancel"));
  expect(await modal.result).toBeNull();
  expect(cleanups).toBe(1);
  expect(modal.dialog.current).toBeNull();
  expect(modal.form.current).toBeNull();
  act(() => { modal.dismiss(); modal.close("late"); deliverClose(dialog); });
  expect(cleanups).toBe(1);
  expect(await modal.result).toBeNull();
});

test("text preserves native close acceptance for every return value except cancel", async () => {
  for (const returnValue of ["ok", "confirm", ""]) {
    let result!: Promise<string | null>;
    act(() => { result = askText("Rename", "before"); });
    const dialog = openDialog();
    dialog.querySelector("input")!.value = `current ${returnValue}`;
    act(() => dialog.close(returnValue));
    expect(await result).toBe(`current ${returnValue}`);
  }
});

test("confirmation retains a direct promise continuation after native close delivery", async () => {
  let continued: boolean | undefined;
  act(() => { void askConfirm("Confirm?").then(value => { continued = value; }); });
  act(() => openDialog().querySelector<HTMLButtonElement>(".btn-danger")!.click());
  await Promise.resolve();
  expect(continued).toBeTrue();
});

test("native confirmation accepts only its legacy confirm return value", async () => {
  for (const returnValue of ["confirm", "cancel", "ok", ""]) {
    let result!: Promise<boolean>;
    act(() => { result = askConfirm("Confirm?"); });
    act(() => openDialog().close(returnValue));
    expect(await result).toBe(returnValue === "confirm");
  }
});
