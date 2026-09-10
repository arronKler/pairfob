import { happy, resetTestDOM } from "../../../../test-support/boot-dom";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { askConfirm, askText, showHelp } from "./basic-dialogs";
import { setLang } from "../../../lib/i18n";

beforeEach(async () => { await resetTestDOM(); setLang("zh"); });
afterEach(() => {
  act(() => { for (const dialog of document.querySelectorAll("dialog[data-react-modal]")) (dialog as HTMLDialogElement).close("cancel"); });
});

function dialog(): HTMLDialogElement {
  return document.querySelector<HTMLDialogElement>("dialog[data-react-modal]")!;
}

test("text dialog selects its initial value, submits current text and restores focus", async () => {
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  let result!: Promise<string | null>;
  act(() => { result = askText("重命名", "original", 255, "文件名"); });
  const modal = dialog();
  const input = modal.querySelector("input")!;
  expect(modal.open).toBeTrue();
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 8]);
  expect(input.maxLength).toBe(255);
  expect(input.parentElement?.textContent).toBe("文件名");
  input.value = "new name";
  act(() => modal.querySelector("form")!.dispatchEvent(new happy.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  expect(await result).toBe("new name");
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(trigger);
  trigger.remove();
});

test("text cancel returns null while an accepted empty value stays empty", async () => {
  let cancelled!: Promise<string | null>;
  act(() => { cancelled = askText("名称"); });
  act(() => dialog().querySelector<HTMLButtonElement>(".btn-ghost")!.click());
  expect(await cancelled).toBeNull();
  let accepted!: Promise<string | null>;
  act(() => { accepted = askText("名称"); });
  act(() => dialog().querySelector("form")!.dispatchEvent(new happy.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  expect(await accepted).toBe("");
});

test("confirmation starts on cancel and resolves true only from explicit confirmation", async () => {
  let result!: Promise<boolean>;
  act(() => { result = askConfirm("删除文件？", "删除"); });
  expect(document.activeElement).toBe(dialog().querySelector(".btn-ghost"));
  act(() => dialog().querySelector<HTMLButtonElement>(".btn-danger")!.click());
  expect(await result).toBeTrue();
  act(() => { result = askConfirm("删除文件？"); });
  act(() => dialog().close("cancel"));
  expect(await result).toBeFalse();
});

test("backdrop and Escape respect the opening gesture guard", async () => {
  const now = spyOn(performance, "now").mockReturnValue(1000);
  try {
    let result!: Promise<boolean>;
    act(() => { result = askConfirm("确认？"); });
    const modal = dialog();
    const early = new happy.Event("cancel", { cancelable: true });
    act(() => modal.dispatchEvent(early as unknown as Event));
    expect(early.defaultPrevented).toBeTrue();
    expect(modal.open).toBeTrue();
    now.mockReturnValue(1400);
    act(() => modal.dispatchEvent(new happy.MouseEvent("click", { bubbles: true }) as unknown as MouseEvent));
    expect(await result).toBeFalse();
  } finally { now.mockRestore(); }
});

test("help replacement keeps one accessible React dialog with literal code", () => {
  act(() => showHelp("说明", ["第一段", { before: "运行 ", code: "pairfob <script>", after: "。" }]));
  const first = dialog();
  expect(first.querySelector("code")?.textContent).toBe("pairfob <script>");
  expect(first.querySelector("script")).toBeNull();
  const ids = first.getAttribute("aria-describedby")!.split(" ");
  expect(ids.every(id => !!document.getElementById(id))).toBeTrue();
  act(() => showHelp("语言", ["第二段"]));
  expect(first.isConnected).toBeFalse();
  expect(document.querySelectorAll("dialog.help")).toHaveLength(1);
  expect(dialog().querySelector("h2")?.textContent).toBe("语言");
  expect(document.activeElement).toBe(dialog().querySelector(".help-close"));
});
