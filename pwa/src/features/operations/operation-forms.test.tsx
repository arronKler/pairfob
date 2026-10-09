import { expectSameNode } from "../../../test-support/node-identity";
import { happy, resetTestDOM } from "../../../test-support/boot-dom";
import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { beforeEach, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { askAgentPrompt, askCreateConversation, askCreateTab, askSplitPane } from "./operation-forms";
import { LAST_AGENT_KIND_KEY } from "./operation-form-model";
import { setLang, t } from "../../lib/i18n";
import { messageOf } from "../../lib/notices";
import { showWorktrees } from "./worktree-dialog";

beforeEach(async () => { await resetTestDOM(); setLang("zh"); localStorage.removeItem(LAST_AGENT_KIND_KEY); });
afterEach(closeTestDialogs);
const form = () => document.querySelector<HTMLFormElement>("dialog.operation-modal form")!;
function field(name: string) { return form().elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement; }
function submit() { act(() => form().dispatchEvent(new happy.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event)); }
function click(label: string) {
  const button = [...form().querySelectorAll("button")].find(item => item.textContent === label)!;
  expect(button).toBeTruthy();
  act(() => button.click());
}

test("conversation validation keeps the field stable and returns a trimmed typed request", async () => {
  let result!: ReturnType<typeof askCreateConversation>;
  act(() => { result = askCreateConversation(["codex", "claude"]); });
  const cwd = field("cwd");
  const buttons = form().querySelectorAll(".action-row button");
  expect(buttons[0]?.classList.contains("btn-primary")).toBeTrue();
  expect(buttons[1]?.classList.contains("btn-ghost")).toBeTrue();
  expectSameNode(document.activeElement, cwd);
  submit();
  expect(cwd.getAttribute("aria-invalid")).toBe("true");
  expect(form().querySelector('[role="alert"]')?.textContent).toBe(t("form.needCwd"));
  expectSameNode(document.activeElement, cwd);
  cwd.value = " /work/project ";
  act(() => cwd.dispatchEvent(new happy.Event("input", { bubbles: true }) as unknown as Event));
  expectSameNode(field("cwd"), cwd);
  expect(cwd.hasAttribute("aria-invalid")).toBeFalse();
  field("agent_kind").value = "claude";
  field("label").value = " Review ";
  submit();
  expect(await result).toEqual({ cwd: "/work/project", agent_kind: "claude", label: "Review" });
  expect(localStorage.getItem(LAST_AGENT_KIND_KEY)).toBe("claude");
  act(() => { result = askCreateConversation(["codex", "claude"], "/work"); });
  expect(field("agent_kind").value).toBe("claude");
  click(t("cancel"));
  expect(await result).toBeNull();
});

test("the desk form's footer reads Cancel then the action and is written that way; the sheet keeps the action on top", async () => {
  const labels = () => [...form().querySelectorAll("button")].map(button => button.textContent);
  let sheet!: ReturnType<typeof askCreateTab>;
  act(() => { sheet = askCreateTab([]); });
  expect(labels()).toEqual([t("form.create"), t("cancel")]);
  expect(form().querySelector(".desk-actions, .desk-close")).toBeNull();
  click(t("cancel"));
  expect(await sheet).toBeNull();

  const { bindOverlayOrigin } = await import("../../shared/ui/overlay/origin");
  happy.happyDOM.setWindowSize({ width: 1024, height: 768 });
  const release = bindOverlayOrigin(document);
  document.body.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
  try {
    let card!: ReturnType<typeof askCreateTab>;
    act(() => { card = askCreateTab([]); });
    expect(form().closest("dialog")!.className).toBe("modal operation-modal desk-form");
    // Fields first, then the footer, then the corner close.
    expect(labels()).toEqual([t("cancel"), t("form.create"), ""]);
    expect(form().querySelector(".action-row")).toBeNull();
    expectSameNode(form().lastElementChild, form().querySelector(".desk-close"));
    click(t("cancel"));
    expect(await card).toBeNull();
    // The list has nothing to confirm: one button puts it away.
    await act(async () => { await showWorktrees(async () => ({ worktrees: [] })); });
    expect(labels()).toEqual([t("close"), ""]);
    expectSameNode(document.activeElement, form().querySelector(".worktree-close"));
  } finally {
    release();
    happy.happyDOM.setWindowSize({ width: 390, height: 844 });
  }
});

test("plain tabs omit optional fields and split panes keep fixed half ratios", async () => {
  let tab!: ReturnType<typeof askCreateTab>;
  act(() => { tab = askCreateTab([]); });
  expect(form().textContent).toContain(t("form.noAgentKinds"));
  submit();
  expect(await tab).toEqual({});
  let split!: ReturnType<typeof askSplitPane>;
  act(() => { split = askSplitPane(["codex"], "/work"); });
  expect(form().querySelector('[name="ratio"]')).toBeNull();
  field("direction").value = "down";
  field("agent_kind").value = "codex";
  submit();
  expect(await split).toEqual({ direction: "down", ratio: 0.5, cwd: "/work", agent_kind: "codex" });
});

test("prompt validation applies UTF-8 limits and retains the editable draft", async () => {
  let result!: ReturnType<typeof askAgentPrompt>;
  act(() => { result = askAgentPrompt(); });
  const input = field("text");
  input.value = "界".repeat(17000);
  submit();
  expectSameNode(field("text"), input);
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(form().textContent).toContain(t("form.taskTooBig"));
  input.value = "  完成代码审查\n保留测试  ";
  submit();
  expect(await result).toBe("完成代码审查\n保留测试");
});

const trees = { worktrees: [{ path: "/repo/feature", branch: "feature", label: "Feature", is_bare: false,
  is_detached: false, is_prunable: false, is_linked_worktree: true, open_workspace_id: null }] };

test("worktree loading is one read; an explicit failed open leaves the same row retryable", async () => {
  let reads = 0, opens = 0;
  let finish!: (value: unknown) => void;
  let pending!: Promise<void>;
  act(() => { pending = showWorktrees(() => { reads++; return new Promise(resolve => { finish = resolve; }); }, async () => {
    opens++;
    throw new Error("open failed");
  }); });
  expect(reads).toBe(1);
  expect(form().querySelector(".operation-body")?.getAttribute("aria-busy")).toBe("true");
  await act(async () => { finish(trees); await pending; });
  const row = form().querySelector<HTMLButtonElement>(".worktree-card")!;
  expect(row.textContent).toContain("Feature");
  expect(opens).toBe(0);
  await act(async () => { row.click(); await Promise.resolve(); });
  expect(opens).toBe(1);
  expectSameNode(form().querySelector(".worktree-card"), row);
  expect(row.disabled).toBeFalse();
  expect(form().querySelector('[role="alert"]')?.textContent).toBe(messageOf(new Error("open failed")));
});

test("a late worktree list cannot resurrect its closed modal or steal newer focus", async () => {
  let finish!: (value: unknown) => void;
  let pending!: Promise<void>;
  act(() => { pending = showWorktrees(() => new Promise(resolve => { finish = resolve; })); });
  click(t("close"));
  await act(async () => { await Promise.resolve(); });
  let next!: ReturnType<typeof askCreateTab>;
  act(() => { next = askCreateTab([], "/next"); });
  const focused = field("cwd");
  await act(async () => { finish(trees); await pending; });
  expect(document.querySelectorAll("dialog")).toHaveLength(1);
  expectSameNode(document.activeElement, focused);
  expect(document.querySelector(".worktree-list")).toBeNull();
  click(t("cancel"));
  expect(await next).toBeNull();
});
