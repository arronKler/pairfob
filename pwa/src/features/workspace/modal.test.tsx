import { expectSameNode } from "../../../test-support/node-identity";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { renderReact, unmountReact } from "../../../test-support/react-harness";
import { bindOverlayOrigin } from "../../shared/ui/overlay";
import { WorkspaceDialog } from "./modal";

beforeEach(async () => { await resetBoardTestDOM(); });
afterEach(() => unmountReact());

test("parent publications retain the draft and focus while dismissal uses the current callback", () => {
  const calls: string[] = [];
  const view = (owner: string) => <WorkspaceDialog className="modal" titleId="note-title"
    onDismiss={() => calls.push(owner)}>
    <h2 id="note-title">Note</h2><textarea defaultValue="draft" />
  </WorkspaceDialog>;
  renderReact(view("old"));
  const dialog = document.querySelector<HTMLDialogElement>("dialog")!;
  const field = dialog.querySelector("textarea")!;
  field.value = "unsaved changes";
  field.focus(); field.setSelectionRange(2, 6);
  renderReact(view("new"));
  expectSameNode(document.querySelector("dialog"), dialog);
  expect(field.value).toBe("unsaved changes");
  expectSameNode(document.activeElement, field);
  expect([field.selectionStart, field.selectionEnd]).toEqual([2, 6]);
  act(() => dialog.close());
  expect(calls).toEqual(["new"]);
});

test("unmount releases a sheet and restores its trigger without a spurious dismissal", async () => {
  const opener = document.createElement("button");
  document.body.append(opener); opener.focus();
  let dismissed = 0;
  renderReact(<WorkspaceDialog className="modal sheet" title="Branches" titleId="branch-title" sheet
    onDismiss={() => dismissed++}><button type="button">main</button></WorkspaceDialog>);
  await act(async () => { await Promise.resolve(); });
  const dialog = document.querySelector<HTMLDialogElement>("dialog")!;
  expect(dialog.open).toBeTrue();
  expect(document.body.classList.contains("sheet-open")).toBeTrue();
  unmountReact();
  await Promise.resolve();
  expect(dialog.open).toBeFalse();
  expect(dialog.isConnected).toBeFalse();
  expect(document.body.classList.contains("sheet-open")).toBeFalse();
  expectSameNode(document.activeElement, opener);
  // A detached, obsolete native close event must not reach the old owner.
  dialog.dispatchEvent(new happy.Event("close") as unknown as Event);
  expect(dismissed).toBe(0);
  opener.remove();
});

test("a mouse beside the list opens the note editor and the branch sheet as the card; a finger keeps the sheet", async () => {
  const release = bindOverlayOrigin(document);
  const press = (pointerType: string) => document.body.dispatchEvent(
    new happy.PointerEvent("pointerdown", { bubbles: true, pointerType }) as unknown as Event);
  const dialog = () => document.querySelector<HTMLDialogElement>("dialog")!;
  try {
    happy.happyDOM.setWindowSize({ width: 850, height: 700 });
    press("mouse");
    renderReact(<WorkspaceDialog className="modal text-edit diff-note-modal" titleId="note-title" keepOnBackdrop
      onDismiss={() => {}}><h2 id="note-title">Note</h2><textarea /></WorkspaceDialog>);
    expect(dialog().className).toBe("modal text-edit diff-note-modal desk-form");
    unmountReact();
    renderReact(<WorkspaceDialog className="modal sheet workspace-branch-sheet" title="Branches" titleId="branch-title" sheet
      onDismiss={() => {}}><button type="button">main</button></WorkspaceDialog>);
    await act(async () => { await Promise.resolve(); });
    expect(dialog().className).toBe("modal sheet workspace-branch-sheet desk-form");
    expect(document.body.classList.contains("sheet-open")).toBeFalse();
    unmountReact();
    press("touch");
    renderReact(<WorkspaceDialog className="modal sheet workspace-branch-sheet" title="Branches" titleId="branch-title" sheet
      onDismiss={() => {}}><button type="button">main</button></WorkspaceDialog>);
    await act(async () => { await Promise.resolve(); });
    expect(dialog().className).toBe("modal sheet workspace-branch-sheet");
    expect(document.body.classList.contains("sheet-open")).toBeTrue();
  } finally {
    release();
    happy.happyDOM.setWindowSize({ width: 390, height: 844 });
  }
});
