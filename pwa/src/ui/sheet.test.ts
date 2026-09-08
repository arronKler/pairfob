import { resetTestDOM } from "../../test-support/boot-dom";
import { closeTestDialogs } from "../../test-support/close-dialogs";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, createElement } from "react";
import { setLang, t } from "../lib/i18n";
import { MenuItem, MenuSection, showActionSheet, type SheetAction } from "./react/action-sheet";

const pause = () => new Promise<void>(resolve => window.setTimeout(resolve, 0));
const current = () => document.querySelector<HTMLDialogElement>("dialog.sheet")!;

function open(action?: SheetAction): void {
  showActionSheet("Actions", modal => createElement(MenuSection, { title: "Workspace", children: [
    createElement(MenuItem, { key: "disabled", modal, disabled: true, children: "Unavailable" }),
    createElement(MenuItem, { key: "enabled", modal, action, children: "Open workspace" }),
  ] }));
}

beforeEach(async () => {
  await resetTestDOM();
  setLang("zh");
});
afterEach(async () => {
  await act(async () => { closeTestDialogs(); await pause(); });
});

describe("action sheet", () => {
  test("unique linked title ids do not need a secure-context UUID", async () => {
    const uuid = spyOn(crypto, "randomUUID").mockImplementation(() => { throw new Error("unavailable"); });
    try {
      act(() => open());
      const firstId = current().getAttribute("aria-labelledby")!;
      expect(firstId).not.toBe("");
      expect(document.getElementById(firstId)?.textContent).toBe("Actions");
      await act(async () => { current().close(); await Promise.resolve(); });
      act(() => open());
      const secondId = current().getAttribute("aria-labelledby")!;
      expect(secondId).not.toBe(firstId);
      expect(document.getElementById(secondId)?.textContent).toBe("Actions");
      expect(uuid).not.toHaveBeenCalled();
    } finally { uuid.mockRestore(); }
  });

  test("a full-height sheet keeps header dismissal above its scrolling items", () => {
    act(() => open());
    const dialog = current();
    const form = dialog.querySelector("form")!;
    expect([...form.children].map(node => node.className)).toEqual(["sheet-grab", "sheet-head", "sheet-body"]);
    expect(form.querySelector(".sheet-grab")?.getAttribute("aria-hidden")).toBe("true");
    expect(form.querySelector(".sheet-body > .menu-section-title")?.textContent).toBe("Workspace");
    expect(form.querySelectorAll(".sheet-body > .menu-item")).toHaveLength(2);
    const enabled = form.querySelector<HTMLButtonElement>(".menu-item:not(:disabled)")!;
    expect(document.activeElement === enabled).toBeTrue();
    const close = form.querySelector<HTMLButtonElement>(".sheet-head > .sheet-close")!;
    expect(close.type).toBe("button");
    expect(close.getAttribute("aria-label")).toBe(t("close"));
    act(() => close.click());
    expect(dialog.open).toBeFalse();
    expect(dialog.isConnected).toBeFalse();
  });

  test("backdrop dismissal ignores the opening gesture for 400 ms", () => {
    let now = 1000;
    const time = spyOn(performance, "now").mockImplementation(() => now);
    try {
      act(() => open());
      const dialog = current();
      act(() => dialog.click());
      expect(dialog.open).toBeTrue();
      now += 399;
      act(() => dialog.click());
      expect(dialog.open).toBeTrue();
      now += 1;
      act(() => dialog.click());
      expect(dialog.open).toBeFalse();
      expect(dialog.isConnected).toBeFalse();
    } finally { time.mockRestore(); }
  });

  test("menu actions run on the next task after the sheet closes", async () => {
    const calls: Array<{ open: boolean; connected: boolean }> = [];
    let dialog!: HTMLDialogElement;
    act(() => open(() => { calls.push({ open: dialog.open, connected: dialog.isConnected }); }));
    dialog = current();
    await act(async () => {
      dialog.querySelector<HTMLButtonElement>(".menu-item:not(:disabled)")!.click();
      await Promise.resolve();
    });
    expect(dialog.open).toBeFalse();
    expect(calls).toEqual([]);
    await act(async () => { await pause(); });
    expect(calls).toEqual([{ open: false, connected: false }]);
  });
});
