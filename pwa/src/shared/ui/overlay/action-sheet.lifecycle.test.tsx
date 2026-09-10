import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { closeTestDialogs } from "../../../../test-support/close-dialogs";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { askText } from "../../../lib/dom";
import { setLang } from "../../../lib/i18n";
// Generic action-sheet lifecycle (focus, teardown order, drag disposal) is the
// shared overlay owner directly — no App, no state, no paint hook.
import { MenuItem, showActionSheet } from "./action-sheet";

const pause = (ms = 0) => new Promise<void>(resolve => setTimeout(resolve, ms));
const sheet = () => document.querySelector<HTMLDialogElement>("dialog.sheet")!;
const action = () => sheet().querySelector<HTMLButtonElement>(".menu-item")!;

function trigger(): HTMLButtonElement {
  const button = document.createElement("button");
  button.textContent = "Page trigger";
  button.dataset.reviewTrigger = "";
  document.body.append(button);
  button.focus();
  return button;
}
function touch(target: HTMLElement, kind: string, y: number, at: number): void {
  const event = new happy.Event(kind, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { touches: { value: kind === "touchend" ? [] : [{ clientX: 20, clientY: y }] },
    timeStamp: { value: at } });
  target.dispatchEvent(event as unknown as Event);
}
function begin(title: string): void {
  showActionSheet(title, modal => <MenuItem modal={modal}>{title} action</MenuItem>);
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
});
afterEach(async () => {
  await act(async () => { closeTestDialogs(); await pause(); });
  for (const node of document.querySelectorAll("[data-review-trigger]")) node.remove();
});

test("a replacement opened by native close cannot lose focus to the retiring sheet's queued restore", async () => {
  const pageTrigger = trigger();
  act(() => begin("First"));
  const first = sheet();
  first.addEventListener("close", () => begin("Second"), { once: true });
  await act(async () => { first.close(); await Promise.resolve(); });
  const second = sheet();
  expect(first.isConnected).toBeFalse();
  expect(document.querySelectorAll("dialog.sheet")).toHaveLength(1);
  expect(second.open).toBeTrue();
  expect(document.activeElement === pageTrigger).toBeFalse();
  expect(document.activeElement === second.querySelector(".menu-item")).toBeTrue();
});

test("a picked action opens its text dialog only after sheet teardown and keeps that input focused", async () => {
  trigger();
  const observations: Array<{ connected: boolean; open: boolean; bodyFeedback: boolean }> = [];
  let pending: ReturnType<typeof askText> | undefined;
  let previous!: HTMLDialogElement;
  act(() => showActionSheet("Rename", modal => <MenuItem modal={modal} action={() => {
    observations.push({ connected: previous.isConnected, open: previous.open,
      bodyFeedback: document.body.classList.contains("sheet-open") });
    pending = askText("New label", "Original");
  }}>Rename now</MenuItem>));
  previous = sheet();
  await act(async () => { action().click(); await Promise.resolve(); });
  expect(observations).toEqual([]);
  await act(async () => { await pause(); });
  expect(observations).toEqual([{ connected: false, open: false, bodyFeedback: false }]);
  const next = document.querySelector<HTMLDialogElement>("dialog")!;
  const input = next.querySelector<HTMLInputElement>("input")!;
  expect(input.value).toBe("Original");
  expect(document.activeElement === input).toBeTrue();
  act(() => next.close("cancel"));
  expect(await pending).toBeNull();
});

test("replacing a dragging sheet retires its fallback and detached touch listeners", async () => {
  act(() => begin("First"));
  const first = sheet();
  const form = first.querySelector("form")!;
  await act(async () => { await Promise.resolve(); });
  act(() => {
    touch(first, "touchstart", 0, 0);
    touch(first, "touchmove", 240, 100);
    touch(first, "touchend", 240, 110);
  });
  expect(form.classList.contains("is-sheet-closing")).toBeTrue();
  await act(async () => { begin("Second"); await Promise.resolve(); });
  const second = sheet();
  expect(form.classList.contains("is-sheet-closing")).toBeFalse();
  expect(first.isConnected).toBeFalse();
  act(() => {
    touch(first, "touchstart", 0, 0);
    touch(first, "touchmove", 100, 100);
  });
  expect(form.style.transform).toBe("");
  await act(async () => { await pause(450); });
  expect(sheet() === second).toBeTrue();
  expect(second.open).toBeTrue();
  expect(document.body.classList.contains("sheet-open")).toBeTrue();
  expect(document.body.classList.contains("sheet-dragging")).toBeFalse();
});

test("a scrolled body keeps its scroll, and native close clears an engaged drag immediately", async () => {
  act(() => begin("Scroll"));
  const dialog = sheet();
  const form = dialog.querySelector("form")!;
  const body = dialog.querySelector<HTMLElement>(".sheet-body")!;
  const target = action();
  await act(async () => { await Promise.resolve(); });
  body.scrollTop = 30;
  act(() => { touch(target, "touchstart", 0, 0); touch(target, "touchmove", 60, 100); });
  expect(form.style.transform).toBe("");
  body.scrollTop = 0;
  act(() => { touch(target, "touchstart", 0, 0); touch(target, "touchmove", 60, 100); });
  expect(form.classList.contains("is-sheet-dragging")).toBeTrue();
  expect(form.style.transform).toContain("translateY(");
  expect(dialog.style.transform).toBe("");
  expect(document.body.classList.contains("sheet-dragging")).toBeTrue();
  await act(async () => { dialog.close(); await Promise.resolve(); });
  expect(document.querySelector("dialog.sheet")).toBeNull();
  expect(form.style.transform).toBe("");
  expect(document.body.classList.contains("sheet-dragging")).toBeFalse();
  expect(document.body.classList.contains("sheet-open")).toBeFalse();
  expect(document.body.style.getPropertyValue("--sheet-lift")).toBe("");
});