import { happy, resetTestDOM } from "../../../../test-support/boot-dom";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { askConfirm, askText, showHelp } from "./basic-dialogs";
import { setLang, t } from "../../../lib/i18n";

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
  act(() => { result = askText({ title: "重命名", initial: "original", maxLength: 255, label: "文件名" }); });
  const modal = dialog();
  const input = modal.querySelector("input")!;
  expect(modal.open).toBeTrue();
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 8]);
  expect(input.maxLength).toBe(255);
  expect(input.getAttribute("enterkeyhint")).toBe("done");
  expect(modal.querySelector(`label[for="${input.id}"]`)?.textContent).toBe("文件名");
  input.value = "new name";
  act(() => modal.querySelector("form")!.dispatchEvent(new happy.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  expect(await result).toBe("new name");
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(trigger);
  trigger.remove();
});

test("text actions sit in the heading and Save waits for a real change", async () => {
  let result!: Promise<string | null>;
  act(() => { result = askText({ title: "改窗格名", initial: "api", hint: "留空恢复", emptyHint: "将恢复自动名称" }); });
  const modal = dialog();
  const head = modal.querySelector(".text-edit-head")!;
  const save = head.querySelector<HTMLButtonElement>(".text-edit-save")!;
  expect(head.querySelector("h2")?.textContent).toBe("改窗格名");
  expect(save.disabled).toBeTrue();
  expect(modal.querySelector(".text-edit-hint")?.textContent).toBe("留空恢复");
  act(() => modal.querySelector<HTMLButtonElement>(".text-edit-clear")!.click());
  expect(modal.querySelector("input")!.value).toBe("");
  expect(save.disabled).toBeFalse();
  expect(modal.querySelector(".text-edit-hint")?.textContent).toBe("将恢复自动名称");
  act(() => save.click());
  expect(await result).toBe("");
});

test("an unchanged submit dismisses and a required name cannot be saved blank", async () => {
  let unchanged!: Promise<string | null>;
  act(() => { unchanged = askText({ title: "名称", initial: "same" }); });
  act(() => dialog().querySelector("form")!.dispatchEvent(new happy.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  expect(await unchanged).toBeNull();
  let required!: Promise<string | null>;
  act(() => { required = askText({ title: "标签页名", initial: "main", allowEmpty: false }); });
  const modal = dialog();
  const input = modal.querySelector("input")!;
  act(() => modal.querySelector<HTMLButtonElement>(".text-edit-clear")!.click());
  expect(modal.querySelector<HTMLButtonElement>(".text-edit-save")!.disabled).toBeTrue();
  expect(modal.querySelector(".text-edit-hint")?.textContent).toBe(t("text.nameRequired"));
  act(() => modal.querySelector("form")!.dispatchEvent(new happy.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  expect(modal.open).toBeTrue();
  input.value = "next";
  act(() => modal.querySelector("form")!.dispatchEvent(new happy.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  expect(await required).toBe("next");
});

test("Enter commits even while Save is disabled: unchanged dismisses, blank required stays", async () => {
  const enter = (input: HTMLInputElement) => act(() => {
    input.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event);
  });
  let unchanged!: Promise<string | null>;
  act(() => { unchanged = askText({ title: "名称", initial: "same" }); });
  enter(dialog().querySelector("input")!);
  expect(await unchanged).toBeNull();
  let required!: Promise<string | null>;
  act(() => { required = askText({ title: "标签页名", initial: "main", allowEmpty: false }); });
  const modal = dialog();
  const input = modal.querySelector("input")!;
  input.value = "  ";
  enter(input);
  expect(modal.open).toBeTrue();
  input.value = "next";
  enter(input);
  expect(await required).toBe("next");
});

test("text cancel returns null", async () => {
  let cancelled!: Promise<string | null>;
  act(() => { cancelled = askText({ title: "名称" }); });
  act(() => dialog().querySelector<HTMLButtonElement>(".text-edit-action:not(.text-edit-save)")!.click());
  expect(await cancelled).toBeNull();
});

test("confirmation names its object, starts on cancel and resolves true only from explicit confirmation", async () => {
  let result!: Promise<boolean>;
  act(() => { result = askConfirm({ title: "删除这个文件？", subject: { name: "notes.md", detail: "docs/notes.md", status: "工作中" },
    message: "无法撤销。", warning: "它还在执行任务。", confirmLabel: "删除" }); });
  const modal = dialog();
  expect(modal.querySelector("h2")?.textContent).toBe("删除这个文件？");
  expect(modal.querySelector(".confirm-name")?.textContent).toBe("notes.md");
  expect(modal.querySelector(".confirm-detail")?.textContent).toBe("docs/notes.md");
  expect(modal.querySelector(".confirm-status")?.classList.contains("is-busy")).toBeTrue();
  expect(modal.querySelector(".confirm-warning")?.textContent).toBe("它还在执行任务。");
  const buttons = [...modal.querySelectorAll<HTMLButtonElement>(".confirm-actions button")];
  expect(buttons.map(button => button.textContent)).toEqual(["取消", "删除"]);
  expect(document.activeElement).toBe(buttons[0]);
  act(() => modal.querySelector<HTMLButtonElement>(".btn-danger")!.click());
  expect(await result).toBeTrue();
  act(() => { result = askConfirm({ title: "现在更新？", confirmLabel: "更新", tone: "primary" }); });
  expect(dialog().querySelector(".btn-danger")).toBeNull();
  expect(dialog().querySelector(".confirm-actions .btn-primary")?.textContent).toBe("更新");
  act(() => dialog().close("cancel"));
  expect(await result).toBeFalse();
});

test("backdrop and Escape respect the opening gesture guard", async () => {
  const now = spyOn(performance, "now").mockReturnValue(1000);
  try {
    let result!: Promise<boolean>;
    act(() => { result = askConfirm({ title: "确认？", confirmLabel: "确认" }); });
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
