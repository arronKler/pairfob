import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { renderReact, unmountReact } from "../../../test-support/react-harness";
import type { DiffNoteTarget } from "../../lib/diff-notes";
import { setLang } from "../../lib/i18n";
import { bindOverlayOrigin } from "../../shared/ui/overlay";
import { tabStops } from "../../shared/ui/overlay/tab-stops";
import { DiffNoteEditor } from "./notes";

/**
 * The line-note dialog drawn as the desk form (a mouse or the keyboard opened
 * it beside the list): the anatomy every desk dialog has, and what each way out
 * of it does to a half-written note. Cancel drops the words; the corner control
 * leaves as Escape does, and says so while there are words to keep.
 */

const target: DiffNoteTarget = { path: "app.ts", layer: "worktree", side: "new", line: 3, snippet: "export function App() {" };
let release: () => void = () => {};
let answers: string[] = [];

function open(input: "mouse" | "touch", width = 800): void {
  happy.happyDOM.setWindowSize({ width, height: 700 });
  document.body.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerType: input }) as unknown as Event);
  renderReact(<DiffNoteEditor target={target} onClose={(changed) => answers.push(`close:${changed}`)} onSetAside={() => answers.push("aside")} />);
}

const dialog = () => document.querySelector<HTMLDialogElement>("dialog.diff-note-modal")!;
const field = () => dialog().querySelector("textarea")!;
const corner = () => dialog().querySelector<HTMLButtonElement>(".desk-close");

function type(text: string): void {
  act(() => {
    field().value = text;
    field().dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  answers = [];
  release = bindOverlayOrigin(document);
});

afterEach(() => {
  unmountReact();
  release();
  setLang("zh");
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
});

describe("the line-note dialog as a desk form", () => {
  test("is written in the order it is read: title, field, Cancel and Save, then the corner control", () => {
    open("mouse");
    expect(dialog().classList.contains("desk-form")).toBeTrue();
    // The title stands alone: the sheet's bar is not drawn.
    expect(dialog().querySelector(".text-edit-head")).toBeNull();
    expect(dialog().querySelector("form > .modal-title")?.textContent).toBe("第 3 行批注");
    expect(tabStops(dialog()).map((stop) => stop.tagName === "TEXTAREA" ? "field" : stop.className)).toEqual([
      "field", "desk-cancel", "icon-btn desk-close",
    ]);
    type("half");
    // Save takes its place between them once there is something to save.
    expect(tabStops(dialog()).map((stop) => stop.tagName === "TEXTAREA" ? "field" : stop.textContent || stop.className)).toEqual([
      "field", "取消", "保存", "icon-btn desk-close",
    ]);
    // The corner control is the form's own child, where the title makes room for it.
    expect(corner()?.parentElement?.tagName).toBe("FORM");
  });

  test("the corner control leaves as Escape does, and Cancel is the answer that drops the words", () => {
    open("mouse");
    type("half written");
    act(() => corner()!.click());
    expect(answers).toEqual(["aside"]);
    act(() => dialog().querySelector<HTMLButtonElement>(".desk-cancel")!.click());
    expect(answers).toEqual(["aside", "close:false"]);
  });

  test("it is named for what it does to the note: set aside while there are words to keep, close when there are none", () => {
    open("mouse");
    expect(corner()?.getAttribute("aria-label")).toBe("关闭");
    type("half written");
    expect(corner()?.getAttribute("aria-label")).toBe("先放一边，留作未保存的批注");
    expect(corner()?.title).toBe("先放一边，留作未保存的批注");
    type("   ");
    expect(corner()?.getAttribute("aria-label")).toBe("关闭");
  });

  test("the English name says the same", () => {
    setLang("en");
    open("mouse");
    type("half written");
    expect(corner()?.getAttribute("aria-label")).toBe("Set aside as an unsaved note");
  });

  test("a finger keeps the sheet and its bar, with no footer and no corner control", () => {
    open("touch");
    expect(dialog().classList.contains("desk-form")).toBeFalse();
    const bar = dialog().querySelector(".text-edit-head")!;
    expect([...bar.children].map((child) => child.textContent)).toEqual(["取消", "第 3 行批注", "保存"]);
    expect(dialog().querySelector(".desk-actions")).toBeNull();
    expect(corner()).toBeNull();
  });

  test("so does a phone, whatever opened it", () => {
    open("mouse", 390);
    expect(dialog().classList.contains("desk-form")).toBeFalse();
    expect(dialog().querySelector(".text-edit-head")).not.toBeNull();
    expect(corner()).toBeNull();
  });
});
