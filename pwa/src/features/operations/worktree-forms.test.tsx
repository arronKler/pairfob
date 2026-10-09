import { expectSameNode } from "../../../test-support/node-identity";
import { happy, resetTestDOM } from "../../../test-support/boot-dom";
import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { setLang, t } from "../../lib/i18n";
import type { SheetOutcome } from "./operation-form-model";
import { bindOverlayOrigin } from "../../shared/ui/overlay/origin";
import { tabStops } from "../../shared/ui/overlay/tab-stops";
import { showWorktreeForm, type OperationGate } from "./worktree-sheet";
import type { WorktreeFields } from "./worktree-forms";

/**
 * The two Worktree forms as the dialog draws them (the session panel pushes
 * the same components as pages; `pane-menu.test.tsx` walks them there): the
 * fields and their order, a refused submit that keeps the reader in the field
 * it is about, and a run that never drops the keyboard onto the page.
 */
const pause = (ms = 0) => new Promise<void>(resolve => setTimeout(resolve, ms));
const dialog = () => document.querySelector<HTMLDialogElement>("dialog.worktree-form-sheet")!;
const field = (name: string) => dialog().querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
const primary = () => dialog().querySelector<HTMLButtonElement>(".create-submit")!;
const alert = () => dialog().querySelector('[role="alert"]')?.textContent ?? "";
let release = () => {};
let reason = "";
const listeners = new Set<() => void>();
const gate: OperationGate = {
  subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  read: () => reason,
};

function type(input: HTMLInputElement, value: string): void {
  act(() => {
    // Controlled inputs: set through the element's own prototype so React's
    // value tracker sees a change. Under happy-dom React reads a focused text
    // field's change on key events, so focus and follow the input with a keyup.
    input.focus();
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
    input.dispatchEvent(new happy.Event("input", { bubbles: true }) as unknown as Event);
    input.dispatchEvent(new happy.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
  });
}
function enter(target: Element): void {
  act(() => { target.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event); });
}
/** A mouse or the keyboard on a desk layout: the dialog is the centred card. */
function onDesk(): void {
  happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
  release = bindOverlayOrigin(document);
  document.body.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
}

beforeEach(async () => { await resetTestDOM(); setLang("zh"); reason = ""; });
afterEach(async () => {
  await act(async () => { closeTestDialogs(); await pause(); });
  release();
  release = () => {};
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
});

test("new Worktree: branch, base, name, the path under Advanced, then Cancel, Create and the close", async () => {
  onDesk();
  const started: WorktreeFields[] = [];
  let finish!: (outcome: SheetOutcome) => void;
  let result!: Promise<boolean>;
  act(() => { result = showWorktreeForm({ kind: "create", gate, dir: "/work/app",
    start: (fields) => { started.push(fields); return new Promise(resolve => { finish = resolve; }); } }); });
  expect(dialog().className).toBe("modal sheet desk-form worktree-form-sheet");
  expect(dialog().querySelector("h2")?.textContent).toBe(t("pm.wtNew"));
  expect([...dialog().querySelectorAll("input")].map(input => input.name)).toEqual(["branch", "base", "label", "path"]);
  expect([...dialog().querySelectorAll("input")].map(input => input.placeholder))
    .toEqual([t("create.branchHint"), t("create.baseHint"), t("pm.wtNameHint"), t("create.pathPlaceholder")]);
  expect(dialog().querySelector(".create-summary")?.textContent).toBe(t("pm.wtCreateSummary", { dir: "/work/app" }));
  expectSameNode(document.activeElement, field("branch"));
  expect(tabStops(dialog()).map(stop => stop.getAttribute("aria-label") ?? stop.getAttribute("name") ?? stop.textContent))
    .toEqual(["branch", "base", "label", t("pm.wtAdvanced"), t("cancel"), t("pm.wtCreate"), t("close")]);

  type(field("branch"), " feat/keys ");
  enter(field("branch"));
  expect(started).toEqual([{ branch: " feat/keys ", base: "", label: "", path: "" }]);
  // Under way: the fields are locked, and the button that says so holds the keyboard instead of the page.
  expect(dialog().querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBeTrue();
  expectSameNode(document.activeElement, primary());
  expect(primary().disabled).toBeFalse();
  expect(primary().getAttribute("aria-disabled")).toBe("true");
  expect(primary().getAttribute("aria-busy")).toBe("true");
  expect(primary().textContent).toBe(t("pm.wtCreateStarted"));
  expect(dialog().querySelector('.create-footer [role="status"].sr-only')?.textContent).toBe(t("pm.wtCreateStarted"));
  // The job goes on without the dialog, so Cancel stays a way out; a second press starts nothing.
  expect(dialog().querySelector<HTMLButtonElement>(".desk-cancel")!.disabled).toBeFalse();
  act(() => primary().click());
  enter(primary());
  expect(started).toHaveLength(1);

  // It failed: the reason is on the form and the reader is back in the field they left.
  await act(async () => { finish({ ok: false, message: "branch exists" }); await pause(); });
  expect(alert()).toBe("branch exists");
  expect(dialog().querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBeFalse();
  expectSameNode(document.activeElement, field("branch"));
  expect(primary().hasAttribute("aria-disabled")).toBeFalse();
  expect(primary().textContent).toBe(t("pm.wtCreate"));

  // Created: the dialog closes on the result.
  act(() => primary().click());
  expect(started).toHaveLength(2);
  await act(async () => { finish({ ok: true }); await pause(); });
  expect(await result).toBeTrue();
  expect(document.querySelector("dialog[open]")).toBeNull();
});

test("new Worktree that cannot start a job says so and keeps the form", () => {
  onDesk();
  act(() => { void showWorktreeForm({ kind: "create", gate, dir: "", start: () => null }); });
  expect(dialog().querySelector(".create-summary")).toBeNull();
  act(() => primary().click());
  expect(alert()).toBe(t("op.worktreeJobLimit"));
  expect(dialog().querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBeFalse();
});

test("open Worktree: an empty target is refused in the field, which keeps the keyboard", async () => {
  onDesk();
  const opened: unknown[] = [];
  let finish!: (outcome: SheetOutcome) => void;
  let result!: Promise<boolean>;
  act(() => { result = showWorktreeForm({ kind: "open", gate,
    open: (target) => { opened.push(target); return new Promise(resolve => { finish = resolve; }); } }); });
  expect(dialog().querySelector("h2")?.textContent).toBe(t("menu.openWorktree"));
  const target = field("target");
  expectSameNode(document.activeElement, target);
  enter(target);
  expect(opened).toEqual([]);
  expect(alert()).toBe(t("form.needPathOrBranch"));
  expect(target.getAttribute("aria-invalid")).toBe("true");
  expect(target.getAttribute("aria-describedby")).toBe(dialog().querySelector('[role="alert"]')!.id);
  expectSameNode(document.activeElement, target);
  // Nothing ran, so nothing was locked on the way.
  expect(dialog().querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBeFalse();
  // Refused from the button too: the reader is put in the field the message is about.
  primary().focus();
  act(() => primary().click());
  expectSameNode(document.activeElement, target);

  type(target, " feat/keys ");
  expect(alert()).toBe("");
  expect(target.hasAttribute("aria-invalid")).toBeFalse();
  enter(target);
  expect(opened).toEqual([{ branch: "feat/keys" }]);
  expectSameNode(document.activeElement, primary());
  // A fast operation is not left half way: Cancel waits for it.
  expect(dialog().querySelector<HTMLButtonElement>(".desk-cancel")!.disabled).toBeTrue();
  await act(async () => { finish({ ok: false, message: "no such branch" }); await pause(); });
  expect(alert()).toBe("no such branch");
  expectSameNode(document.activeElement, target);

  // By path, as the other half of the one choice.
  act(() => [...dialog().querySelectorAll<HTMLButtonElement>(".seg-item")].find(item => item.textContent === t("pm.wtByPath"))!.click());
  expect(alert()).toBe("");
  expect(field("target").placeholder).toBe(t("create.pathPlaceholder"));
  type(field("target"), "/work/app-keys");
  enter(field("target"));
  expect(opened.at(-1)).toEqual({ path: "/work/app-keys" });
  await act(async () => { finish({ ok: true }); await pause(); });
  expect(await result).toBeTrue();
});

test("a reason it cannot run right now holds the button and is said above it; putting the dialog away resolves false", async () => {
  onDesk();
  reason = t("boardMenu.offline");
  let result!: Promise<boolean>;
  act(() => { result = showWorktreeForm({ kind: "open", gate, open: async () => ({ ok: true }) }); });
  expect(primary().disabled).toBeTrue();
  expect(dialog().querySelector('.create-footer [role="status"]:not(.sr-only)')?.textContent).toBe(t("boardMenu.offline"));
  reason = "";
  act(() => { for (const listener of listeners) listener(); });
  expect(primary().disabled).toBeFalse();
  act(() => dialog().querySelector<HTMLButtonElement>(".desk-cancel")!.click());
  await act(async () => { await pause(); });
  expect(await result).toBeFalse();
});

test("a finger's refused tap leaves focus where it is: there is no keyboard position to move, and no keyboard to raise", () => {
  act(() => { void showWorktreeForm({ kind: "open", gate, open: async () => ({ ok: true }) }); });
  primary().focus();
  act(() => primary().click());
  expect(alert()).toBe(t("form.needPathOrBranch"));
  expect(field("target").getAttribute("aria-invalid")).toBe("true");
  expectSameNode(document.activeElement, primary());
});

test("a finger gets the same form in a bottom sheet, its footer pinned in the scroller", () => {
  act(() => { void showWorktreeForm({ kind: "create", gate, dir: "/work/app", start: () => null }); });
  expect(dialog().className).toBe("modal sheet worktree-form-sheet");
  expect([...dialog().querySelectorAll("input")].map(input => input.name)).toEqual(["branch", "base", "label", "path"]);
  expect(dialog().querySelector(".sheet-body .create-footer .create-submit")?.textContent).toBe(t("pm.wtCreate"));
  expect(dialog().querySelector(".desk-cancel")).toBeNull();
  expect(dialog().querySelector(".sheet-head .sheet-close")).not.toBeNull();
});

test("in the sheet a focused field is shown again once the keyboard has slid in; the desk card has none under it", async () => {
  const shown: string[] = [];
  const watch = () => { for (const input of dialog().querySelectorAll("input")) input.scrollIntoView = () => { shown.push(input.name); }; };
  act(() => { void showWorktreeForm({ kind: "create", gate, dir: "/work/app", start: () => null }); });
  watch();
  act(() => field("label").focus());
  expect(shown).toEqual([]);
  await act(async () => { await pause(340); });
  expect(shown).toEqual(["label"]);
  // The field the reader has moved on from is left where it is.
  act(() => field("base").focus());
  act(() => primary().focus());
  await act(async () => { await pause(340); });
  expect(shown).toEqual(["label"]);
  await act(async () => { closeTestDialogs(); await pause(); });

  onDesk();
  act(() => { void showWorktreeForm({ kind: "create", gate, dir: "/work/app", start: () => null }); });
  watch();
  act(() => field("label").focus());
  await act(async () => { await pause(340); });
  expect(shown).toEqual(["label"]);
});
