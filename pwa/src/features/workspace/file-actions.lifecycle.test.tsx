import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { setLang } from "../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import type { LiveSession } from "../../lib/protocol/client";
import { WorkspaceSnapshotRestorer } from "../../../test-support/workspace-snapshot-restore";
import { setScreen } from "../../app/navigation-store";
import { advertisedAgentKinds, applyCapabilities, setOperationBusy } from "../operations/capabilities-store";
import { attachLiveSession } from "../computers/catalog-store";
import { replaceAgentsFromSnapshot } from "../dashboard/catalog-store";
import { adoptWorkspaceIdentity } from "./index";
import { bindWorkspaceFileActions } from "./file-actions";

const seedRestorer = new WorkspaceSnapshotRestorer();

const pause = (ms = 0) => new Promise<void>(resolve => setTimeout(resolve, ms));
const sheet = () => document.querySelector<HTMLDialogElement>("dialog.sheet")!;
const action = () => sheet().querySelector<HTMLButtonElement>(".menu-item")!;
const rowDisposers: Array<() => void> = [];

function trigger(): HTMLButtonElement {
  const button = document.createElement("button");
  button.textContent = "Page trigger";
  button.dataset.reviewTrigger = "";
  document.body.append(button);
  button.focus();
  return button;
}

function fileRow(): { row: HTMLButtonElement; mutations: string[] } {
  const mutations: string[] = [];
  seedRestorer.capture();
  attachLiveSession({
    isConnected: () => true,
    workspaceRename: async () => { mutations.push("rename"); },
    workspaceDelete: async () => { mutations.push("delete"); },
  } as unknown as LiveSession);
  setScreen("workspace");
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, rename_file: true, delete_file: true }, advertisedAgentKinds());
  replaceAgentsFromSnapshot({
    focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "p1" },
    workspaces: [{ workspace_id: "w1", label: "repo" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
    panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/repo", agent: "codex", agent_status: "idle" }],
  });
  adoptWorkspaceIdentity({
    paneId: "p1",
    directory: "",
    descriptor: { root: "/repo", name: "repo", features: { files: true, git_status: false, git_diff: false, git_branches: false }, git: null },
  });
  const row = trigger();
  rowDisposers.push(bindWorkspaceFileActions(row, { name: "file.txt", path: "file.txt", kind: "file",
    revision: "a".repeat(64), size: 12, modified_ms: 1, hidden: false }));
  act(() => row.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true }) as unknown as Event));
  return { row, mutations };
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  setOperationBusy(false);
});
afterEach(async () => {
  for (const dispose of rowDisposers.splice(0)) dispose();
  await act(async () => { closeTestDialogs(); await pause(); });
  for (const node of document.querySelectorAll("[data-review-trigger]")) node.remove();
  await act(async () => {
    seedRestorer.restore();
    attachLiveSession(null);
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, advertisedAgentKinds());
  });
});

test("a file action cannot open a confirmation on a new session after the sheet closes", async () => {
  const { mutations } = fileRow();
  const remove = [...sheet().querySelectorAll<HTMLButtonElement>(".menu-item")].find(button => button.textContent === "删除文件")!;
  await act(async () => {
    remove.click();
    attachLiveSession({} as unknown as LiveSession);
    await pause();
  });
  expect(document.querySelector("dialog")).toBeNull();
  expect(mutations).toEqual([]);
});

test("revoked file capability is rechecked before a deferred rename dialog opens", async () => {
  const { mutations } = fileRow();
  await act(async () => {
    action().click();
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES, rename_file: false, delete_file: true }, advertisedAgentKinds());
    await pause();
  });
  expect(document.querySelector("dialog")).toBeNull();
  expect(mutations).toEqual([]);
});

test("the returned file binding disposer prevents future keyboard and context-menu opens", async () => {
  const { row, mutations } = fileRow();
  act(() => sheet().close());
  rowDisposers.at(-1)!();
  await act(async () => {
    row.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }) as unknown as Event);
    row.dispatchEvent(new happy.MouseEvent("contextmenu", { bubbles: true, cancelable: true }) as unknown as Event);
    await pause();
  });
  expect(document.querySelector("dialog")).toBeNull();
  expect(row.hasAttribute("aria-haspopup")).toBeFalse();
  expect(row.classList.contains("workspace-file-actionable")).toBeFalse();
  expect(mutations).toEqual([]);
});