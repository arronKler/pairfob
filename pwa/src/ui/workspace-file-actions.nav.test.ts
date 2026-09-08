import { Window } from "happy-dom";
import { afterEach, expect, test } from "bun:test";

const happy = new Window({ url: "https://pairfob.com/pair" });
const globals = globalThis as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLDialogElement", "Node", "DocumentFragment", "localStorage", "sessionStorage"] as const) globals[key] = (happy as unknown as Record<string, unknown>)[key];
globals.location = happy.location;
globals.matchMedia = happy.matchMedia.bind(happy);
happy.document.body.innerHTML = '<main id="app"></main>';
const { state, app } = await import("../state.ts");
const { setRenderer } = await import("../paint.ts");
const { renderWorkspace } = await import("./workspace.ts");
const { enterWorkspace, workspaceModel, leaveWorkspace } = await import("../workspace.ts");
const { ProtocolError } = await import("../lib/protocol/errors.ts");
const { NO_OPERATION_CAPABILITIES } = await import("../lib/operations.ts");
const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
let calls: unknown[][] = [];
let reads = 0;
let mutation: () => Promise<unknown> = async () => ({});
async function boot(enabled = true) {
  document.body.append(document.adoptNode(app));
  calls = []; reads = 0;
  mutation = async () => ({});
  const live = {
    workspaceOpen: async () => ({ name: "repo", root: "/repo", features: { files: true, git_status: false, git_diff: false, git_branches: false }, git: null }),
    workspaceList: async () => { reads++; return { path: "", entries: [{ name: "a.txt", path: "a.txt", kind: "file", revision: "a".repeat(64), size: 12, modified_ms: 1, hidden: false }], next_cursor: null, truncated: false, revision: "a".repeat(64) }; },
    workspaceRename: async (...args: unknown[]) => { calls.push(["rename", ...args]); return mutation(); },
    workspaceDelete: async (...args: unknown[]) => { calls.push(["delete", ...args]); return mutation(); },
    workspaceRead: async () => { throw new Error("unexpected file open"); },
  };
  state.live = live as unknown as typeof state.live;
  state.agents = [{ paneId: "p1", cwd: "/repo" }] as typeof state.agents;
  state.operationCapabilities = { ...NO_OPERATION_CAPABILITIES, rename_file: enabled, delete_file: enabled };
  state.operationBusy = false;
  setRenderer(renderWorkspace);
  await enterWorkspace("p1", "guided");
}
function row() { return app.querySelector<HTMLButtonElement>(".workspace-file")!; }
function button(text: string) { return [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find((b) => b.textContent === text)!; }
function menu() { row().dispatchEvent(new happy.MouseEvent("contextmenu", { bubbles: true, cancelable: true }) as unknown as Event); }
function pointer(target: HTMLElement, type: string, x = 10) {
  target.dispatchEvent(new happy.PointerEvent(type, { bubbles: true, isPrimary: true, pointerId: 1, pointerType: "touch", clientX: x, clientY: 10 }) as unknown as Event);
}
afterEach(() => {
  leaveWorkspace();
  state.live = null;
  state.operationBusy = false;
  state.operationCapabilities = { ...NO_OPERATION_CAPABILITIES };
  setRenderer(() => {});
  document.querySelectorAll("dialog").forEach((d) => d.remove());
});

test("old daemon has no file actions", async () => {
  await boot(false); menu();
  expect(document.querySelector("dialog")).toBeNull();
});
test("long hold opens once and releasing after a second does not open the file", async () => {
  await boot(); const target = row();
  pointer(target, "pointerdown"); await pause(1000);
  expect(document.querySelector("dialog.sheet")?.textContent).toContain("重命名");
  pointer(target, "pointerup"); target.click();
  expect(workspaceModel.view).toBe("browser");
  expect(calls).toHaveLength(0);
});
test("scroll and cancelled gestures do not open actions", async () => {
  await boot();
  pointer(row(), "pointerdown"); pointer(row(), "pointermove", 40); await pause(480);
  expect(document.querySelector("dialog")).toBeNull();
  pointer(row(), "pointerdown"); pointer(row(), "pointercancel"); await pause(480);
  expect(document.querySelector("dialog")).toBeNull();
});
test("rename pre-fills filename and refreshes once after submitting", async () => {
  await boot(); menu(); button("重命名").click(); await pause();
  const input = document.querySelector<HTMLInputElement>("dialog input")!;
  expect(input.value).toBe("a.txt"); input.value = "b.txt";
  document.querySelector<HTMLDialogElement>("dialog")!.close("confirm"); await pause(60);
  expect(calls).toEqual([["rename", "p1", "/repo", "a.txt", "b.txt", 12, 1, "a".repeat(64)]]);
  expect(reads).toBe(2);
});
test("deletion requires confirmation and cancellation has no effect", async () => {
  await boot(); menu(); button("删除文件").click(); await pause();
  expect(document.querySelector("dialog")?.textContent).toContain("a.txt");
  expect(calls).toHaveLength(0);
  button("取消").click(); await pause(); expect(calls).toHaveLength(0);
  menu(); button("删除文件").click(); await pause(); button("删除文件").click(); await pause(60);
  expect(calls).toEqual([["delete", "p1", "/repo", "a.txt", 12, 1, "a".repeat(64)]]);
  expect(reads).toBe(2);
});
test("uncertain deletion refreshes without replay and displays the error", async () => {
  await boot(); mutation = async () => { throw new ProtocolError("unknown_outcome", "结果未知，请刷新"); };
  menu(); button("删除文件").click(); await pause(); button("删除文件").click(); await pause(60);
  expect(calls).toHaveLength(1); expect(reads).toBe(2);
  expect(workspaceModel.error).toContain("不要立即重试");
});
test("switching workspace while confirming cancels the operation", async () => {
  await boot(); menu(); button("删除文件").click(); await pause();
  workspaceModel.paneId = "p2";
  button("删除文件").click(); await pause(); expect(calls).toHaveLength(0);
});

test("an old connection cannot clear a new connection's operation lock", async () => {
  await boot();
  let finish: () => void = () => {};
  mutation = () => new Promise((resolve) => { finish = () => resolve({}); });
  menu(); button("删除文件").click(); await pause(); button("删除文件").click(); await pause();
  expect(state.operationBusy).toBe(true);
  state.live = {} as NonNullable<typeof state.live>;
  state.operationBusy = true;
  finish(); await pause();
  expect(state.operationBusy).toBe(true);
});

test("long-hold release retargeted to the sheet cannot dismiss it or select an action", async () => {
  await boot();
  const target = row();
  pointer(target, "pointerdown"); await pause(1000);
  const dialog = document.querySelector<HTMLDialogElement>("dialog.sheet")!;
  pointer(target, "pointerup");
  dialog.dispatchEvent(new happy.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
  expect(dialog.open).toBe(true);
  expect(calls).toHaveLength(0);
  // The next intentional press must work normally.
  const rename = button("重命名");
  pointer(rename, "pointerdown"); pointer(rename, "pointerup"); rename.click(); await pause();
  expect(document.querySelector<HTMLInputElement>('dialog input')?.value).toBe("a.txt");
});
