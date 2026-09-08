import { happy, resetTestDOM } from "../../test-support/boot-dom";
import { closeTestDialogs } from "../../test-support/close-dialogs";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { askAgentPrompt, askWorktree } from "./operation-forms";
import { showWorktrees } from "./worktree-dialog";
import { setLang } from "./i18n";
import { messageOf } from "./notices";

beforeEach(async () => { await resetTestDOM(); setLang("zh"); });
afterEach(() => closeTestDialogs());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function dialog(): HTMLDialogElement {
  return document.querySelector<HTMLDialogElement>("dialog[data-react-modal][open]")!;
}

function worktree(path: string, label: string | null = null, branch: string | null = null) {
  return { path, branch, label, is_bare: false, is_detached: false,
    is_prunable: false, is_linked_worktree: true, open_workspace_id: null };
}

test("late worktree load and load failure leave a newer modal and its focus untouched", async () => {
  for (const fail of [false, true]) {
    const load = deferred<unknown>();
    let loaded!: Promise<void>;
    act(() => { loaded = showWorktrees(() => load.promise); });
    const old = dialog();
    act(() => old.querySelector<HTMLButtonElement>(".btn-ghost")!.click());
    await Promise.resolve();
    let prompted!: Promise<string | null>;
    act(() => { prompted = askAgentPrompt(); });
    const newer = dialog();
    const input = newer.querySelector("textarea")!;
    input.value = "unsaved prompt";
    input.setSelectionRange(2, 6);
    await act(async () => {
      if (fail) load.reject(new Error("late load failure"));
      else load.resolve({ worktrees: [worktree("/repo/late")] });
      await loaded;
    });
    expect(old.isConnected).toBeFalse();
    expect(dialog() === newer).toBeTrue();
    expect(document.activeElement === input).toBeTrue();
    expect(input.value).toBe("unsaved prompt");
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 6]);
    expect(document.querySelectorAll(".worktree-card")).toHaveLength(0);
    act(() => newer.close("cancel"));
    expect(await prompted).toBeNull();
  }
});

test("worktree open failures preserve cards and concurrent pending actions until completion", async () => {
  const first = deferred<void>();
  const second = deferred<void>();
  const calls: string[] = [];
  await act(async () => {
    await showWorktrees(async () => ({ worktrees: [worktree("/repo/one", "One", "topic"), worktree("/repo/two")] }), item => {
      calls.push(item.path);
      return item.path === "/repo/one" ? first.promise : second.promise;
    });
  });
  const modal = dialog();
  const body = modal.querySelector(".operation-body")!;
  const [one, two] = [...modal.querySelectorAll<HTMLButtonElement>(".worktree-card")];
  act(() => { one.click(); one.click(); two.click(); });
  expect(calls).toEqual(["/repo/one", "/repo/two"]);
  expect(one.disabled).toBeTrue();
  expect(two.disabled).toBeTrue();
  expect(body.getAttribute("aria-busy")).toBe("true");
  const failure = new Error("open failed");
  await act(async () => { first.reject(failure); await Promise.resolve(); });
  expect(modal.querySelectorAll(".worktree-card")[0] === one).toBeTrue();
  expect(one.disabled).toBeFalse();
  expect(two.disabled).toBeTrue();
  expect(body.getAttribute("aria-busy")).toBe("true");
  expect(modal.querySelector('[role="alert"]')?.textContent).toBe(messageOf(failure));
  await act(async () => { second.resolve(); await Promise.resolve(); });
  expect(modal.isConnected).toBeFalse();
});

test("closing a pending worktree open prevents its late rejection from changing another modal", async () => {
  const opened = deferred<void>();
  await act(async () => { await showWorktrees(async () => ({ worktrees: [worktree("/repo/one")] }), () => opened.promise); });
  const old = dialog();
  act(() => old.querySelector<HTMLButtonElement>(".worktree-card")!.click());
  act(() => old.querySelector<HTMLButtonElement>(".btn-ghost")!.click());
  await Promise.resolve();
  let result!: Promise<string | null>;
  act(() => { result = askAgentPrompt(); });
  const newer = dialog();
  await act(async () => { opened.reject(new Error("late open failure")); await Promise.resolve(); });
  expect(dialog() === newer).toBeTrue();
  expect(newer.textContent).not.toContain("late open failure");
  expect(newer.querySelector("textarea") === document.activeElement).toBeTrue();
  act(() => newer.close("cancel"));
  expect(await result).toBeNull();
});

test("validation rerender keeps field nodes, entered drafts and selection while clearing linked errors", async () => {
  let result!: ReturnType<typeof askWorktree>;
  act(() => { result = askWorktree("open", { cwd: "/repo", path: "/repo/work", branch: "topic" }); });
  const modal = dialog();
  const form = modal.querySelector("form")!;
  const path = form.elements.namedItem("path") as HTMLInputElement;
  const branch = form.elements.namedItem("branch") as HTMLInputElement;
  act(() => form.dispatchEvent(new happy.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  expect(document.activeElement === branch).toBeTrue();
  const errorId = branch.getAttribute("aria-describedby")!;
  expect(document.getElementById(errorId)?.getAttribute("role")).toBe("alert");
  expect(branch.getAttribute("aria-invalid")).toBe("true");
  path.focus();
  path.setSelectionRange(3, 7);
  act(() => path.dispatchEvent(new happy.Event("input", { bubbles: true }) as unknown as Event));
  expect(form.elements.namedItem("path") === path).toBeTrue();
  expect(form.elements.namedItem("branch") === branch).toBeTrue();
  expect(path.value).toBe("/repo/work");
  expect(branch.value).toBe("topic");
  expect([path.selectionStart, path.selectionEnd]).toEqual([3, 7]);
  expect(document.activeElement === path).toBeTrue();
  expect(branch.hasAttribute("aria-invalid")).toBeFalse();
  expect(branch.hasAttribute("aria-describedby")).toBeFalse();
  expect(document.getElementById(errorId)?.hidden).toBeTrue();
  branch.value = "";
  act(() => form.dispatchEvent(new happy.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  expect(await result).toEqual({ cwd: "/repo", path: "/repo/work" });
});
