import { happy, resetTestDOM } from "../../test-support/boot-dom";
import { closeTestDialogs } from "../../test-support/close-dialogs";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { askCreateTab } from "../features/operations/operation-forms";
import { bindSheetDrag } from "../shared/ui/overlay/sheet-drag";

beforeEach(resetTestDOM);
afterEach(closeTestDialogs);

function touch(dialog: HTMLDialogElement, kind: string, y: number, at: number) {
  const event = new happy.Event(kind, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: kind === "touchend" ? [] : [{ clientX: 20, clientY: y }] },
    timeStamp: { value: at },
  });
  dialog.dispatchEvent(event as unknown as Event);
}

function drag(dialog: HTMLDialogElement) {
  touch(dialog, "touchstart", 0, 0);
  touch(dialog, "touchmove", 240, 100);
  touch(dialog, "touchend", 240, 110);
}

test("disposing a sheet cancels its transition fallback and permanent gesture listeners", async () => {
  const dialog = document.createElement("dialog");
  const form = document.createElement("form");
  dialog.append(form);
  document.body.append(dialog);
  dialog.showModal();
  let closes = 0;
  const dispose = bindSheetDrag({ dialog, form, close: () => { closes++; } });
  await Promise.resolve();
  expect(document.body.classList.contains("sheet-open")).toBeTrue();
  drag(dialog);
  expect(form.classList.contains("is-sheet-closing")).toBeTrue();
  dispose();
  expect(document.body.classList.contains("sheet-open")).toBeFalse();
  expect(document.body.style.getPropertyValue("--sheet-lift")).toBe("");
  expect(form.classList.contains("is-sheet-closing")).toBeFalse();
  drag(dialog);
  expect(form.style.transform).toBe("");
  await new Promise(resolve => setTimeout(resolve, 450));
  expect(closes).toBe(0);
  dispose();
  dialog.close();
  dialog.remove();
});

test("React unmount clears sheet feedback before the later native close listener could run", async () => {
  let pending!: ReturnType<typeof askCreateTab>;
  act(() => { pending = askCreateTab([]); });
  const dialog = document.querySelector<HTMLDialogElement>("dialog.operation-modal")!;
  await Promise.resolve();
  touch(dialog, "touchstart", 0, 0);
  touch(dialog, "touchmove", 30, 100);
  expect(document.body.classList.contains("sheet-dragging")).toBeTrue();
  act(() => dialog.close("cancel"));
  expect(await pending).toBeNull();
  expect(document.body.classList.contains("sheet-dragging")).toBeFalse();
  expect(document.body.classList.contains("sheet-open")).toBeFalse();
  expect(document.body.style.getPropertyValue("--sheet-lift")).toBe("");
});

test("dispose before the opening microtask cannot leave a stale sheet-open class", async () => {
  const dialog = document.createElement("dialog");
  const form = document.createElement("form");
  document.body.append(dialog);
  dialog.append(form);
  dialog.showModal();
  bindSheetDrag({ dialog, form, close: () => dialog.close() })();
  await Promise.resolve();
  expect(document.body.classList.contains("sheet-open")).toBeFalse();
  dialog.close();
  dialog.remove();
});
