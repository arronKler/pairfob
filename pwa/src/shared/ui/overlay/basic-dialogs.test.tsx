import { expectSameNode } from "../../../../test-support/node-identity";
import { happy, resetTestDOM } from "../../../../test-support/boot-dom";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { askConfirm, askText, showHelp } from "./basic-dialogs";
import { setLang, t } from "../../../lib/i18n";
import { tabStops } from "./tab-stops";

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
  expectSameNode(document.activeElement, input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 8]);
  expect(input.maxLength).toBe(255);
  expect(input.getAttribute("enterkeyhint")).toBe("done");
  expect(modal.querySelector(`label[for="${input.id}"]`)?.textContent).toBe("文件名");
  input.value = "new name";
  act(() => modal.querySelector("form")!.dispatchEvent(new happy.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  expect(await result).toBe("new name");
  expect(dialog()).toBeNull();
  expectSameNode(document.activeElement, trigger);
  trigger.remove();
});

test("text actions sit in the heading and Save waits for a real change", async () => {
  let result!: Promise<string | null>;
  act(() => { result = askText({ title: "改会话名", initial: "api", hint: "留空恢复", emptyHint: "将恢复自动名称" }); });
  const modal = dialog();
  const head = modal.querySelector(".text-edit-head")!;
  const save = head.querySelector<HTMLButtonElement>(".text-edit-save")!;
  expect(head.querySelector("h2")?.textContent).toBe("改会话名");
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
  expectSameNode(document.activeElement, buttons[0]);
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
  expectSameNode(document.activeElement, dialog().querySelector(".help-close"));
});

/** The card a mouse or the keyboard gets beside the list (`desk-form`). */
async function withDesk(run: () => Promise<void>): Promise<void> {
  const { bindOverlayOrigin } = await import("./origin");
  happy.happyDOM.setWindowSize({ width: 1024, height: 768 });
  const release = bindOverlayOrigin(document);
  document.body.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }) as unknown as Event);
  try { await run(); } finally {
    release();
    happy.happyDOM.setWindowSize({ width: 390, height: 844 });
  }
}

/** What Tab stops at inside the open dialog, in order, as their class or tag names. */
function stops(): string[] {
  return tabStops(dialog()).map(stop => stop.className.split(" ").at(-1) || stop.tagName.toLowerCase());
}

test("the desk form adds a corner close that cancels; the sheet has none", async () => {
  let sheetResult!: Promise<string | null>;
  act(() => { sheetResult = askText({ title: "名称", initial: "a" }); });
  expect(dialog().classList.contains("desk-form")).toBeFalse();
  expect(dialog().querySelector(".desk-close")).toBeNull();
  act(() => dialog().close("cancel"));
  expect(await sheetResult).toBeNull();

  await withDesk(async () => {
    let text!: Promise<string | null>;
    act(() => { text = askText({ title: "名称", initial: "a" }); });
    expect(dialog().className).toBe("modal text-edit desk-form");
    const close = dialog().querySelector<HTMLButtonElement>(".desk-close")!;
    expect(close.getAttribute("aria-label")).toBe(t("close"));
    // Last in the form: Tab reaches the field and the two actions first.
    expectSameNode(dialog().querySelector("form")!.lastElementChild, close);
    dialog().querySelector("input")!.value = "typed";
    act(() => close.click());
    expect(await text).toBeNull();

    let confirm!: Promise<boolean>;
    act(() => { confirm = askConfirm({ title: "关闭？", confirmLabel: "关闭" }); });
    expect(dialog().className).toBe("modal confirm desk-form");
    act(() => dialog().querySelector<HTMLButtonElement>(".desk-close")!.click());
    expect(await confirm).toBeFalse();

    // Help is one of the family: the shared title and corner close, and one button that puts it away.
    act(() => showHelp("帮助", ["说明"]));
    expect(dialog().querySelectorAll(".help-close").length).toBe(0);
    expectSameNode(dialog().querySelector("form")!.lastElementChild, dialog().querySelector(".desk-close"));
    const done = dialog().querySelector<HTMLButtonElement>(".help-done")!;
    expect(done.textContent).toBe(t("desk.gotIt"));
    expectSameNode(document.activeElement, done);
    act(() => done.click());
    expect(document.querySelector("dialog.help")).toBeNull();
  });
});

test("the single-field editor is written in the order it is drawn: the sheet's bar first, the card's footer last", async () => {
  let sheetResult!: Promise<string | null>;
  act(() => { sheetResult = askText({ title: "名称", initial: "a" }); });
  // The sheet: Cancel · title · Save above the field, where the on-screen keyboard cannot cover them.
  expect([...dialog().querySelector("form")!.children].map(child => child.className.split(" ")[0]))
    .toEqual(["text-edit-head", "text-edit-label", "text-edit-field"]);
  // Save waits for a change, so Tab passes it until there is one.
  expect(stops()).toEqual(["text-edit-action", "input", "text-edit-clear"]);
  act(() => dialog().close("cancel"));
  expect(await sheetResult).toBeNull();

  await withDesk(async () => {
    let text!: Promise<string | null>;
    act(() => { text = askText({ title: "名称", initial: "a", hint: "说明" }); });
    // The card: title, the field, its guidance, the footer, the close — for the eye, Tab and a screen reader alike.
    expect([...dialog().querySelector("form")!.children].map(child => child.className.split(" ").at(-1)))
      .toEqual(["modal-title", "text-edit-label", "text-edit-field", "text-edit-hint", "desk-actions", "desk-close"]);
    expect(dialog().querySelector(".text-edit-head")).toBeNull();
    const footer = [...dialog().querySelectorAll<HTMLButtonElement>(".desk-actions button")];
    expect(footer.map(button => button.textContent)).toEqual([t("cancel"), t("text.save")]);
    // Save waits for a change, so Tab passes it until there is one.
    expect(stops()).toEqual(["input", "text-edit-clear", "desk-cancel", "desk-close"]);
    act(() => dialog().querySelector<HTMLButtonElement>(".text-edit-clear")!.click());
    expect(stops()).toEqual(["input", "desk-cancel", "text-edit-save", "desk-close"]);
    act(() => footer[1].click());
    expect(await text).toBe("");

    let confirm!: Promise<boolean>;
    act(() => { confirm = askConfirm({ title: "关闭？", confirmLabel: "关闭" }); });
    expect(stops()).toEqual(["confirm-cancel", "btn-danger", "desk-close"]);
    act(() => dialog().close("cancel"));
    expect(await confirm).toBeFalse();
  });
});

test("Tab stays inside the dialog: past the close it starts over, and back from the field it reaches the close", async () => {
  const tab = (shiftKey = false) => {
    const event = new happy.KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }) as unknown as KeyboardEvent;
    act(() => { (document.activeElement ?? document.body).dispatchEvent(event); });
    return event;
  };
  await withDesk(async () => {
    let text!: Promise<string | null>;
    act(() => { text = askText({ title: "名称", initial: "a" }); });
    const input = dialog().querySelector("input")!;
    const close = dialog().querySelector<HTMLButtonElement>(".desk-close")!;
    expectSameNode(document.activeElement, input);
    // In the middle the browser moves focus itself.
    dialog().querySelector<HTMLButtonElement>(".desk-cancel")!.focus();
    expect(tab().defaultPrevented).toBeFalse();
    close.focus();
    expect(tab().defaultPrevented).toBeTrue();
    expectSameNode(document.activeElement, input);
    expect(tab(true).defaultPrevented).toBeTrue();
    expectSameNode(document.activeElement, close);
    // Focus on nothing at all (a press on the card's padding) comes back in at the start.
    close.blur();
    expect(tab().defaultPrevented).toBeTrue();
    expectSameNode(document.activeElement, input);
    act(() => dialog().close("cancel"));
    expect(await text).toBeNull();
  });
});

test("Escape is answered on the key, so a second one in a row is never the browser's to decide", async () => {
  const now = spyOn(performance, "now").mockReturnValue(1000);
  const escape = (init: Record<string, unknown> = {}) => {
    const key = new happy.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init }) as unknown as KeyboardEvent;
    act(() => { dialog().querySelector("input")!.dispatchEvent(key); });
    return key;
  };
  try {
    let result!: Promise<string | null>;
    act(() => { result = askText({ title: "名称", initial: "a" }); });
    // The opening gesture guard holds for the key as it does for the close request.
    expect(escape().defaultPrevented).toBeTrue();
    expect(dialog().open).toBeTrue();
    now.mockReturnValue(1400);
    // An input method's own Escape (it cancels the candidate) is left to it.
    expect(escape({ isComposing: true }).defaultPrevented).toBeFalse();
    expect(dialog().open).toBeTrue();
    expect(escape().defaultPrevented).toBeTrue();
    expect(await result).toBeNull();
  } finally { now.mockRestore(); }
});
