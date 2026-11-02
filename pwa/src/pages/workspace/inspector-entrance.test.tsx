import { act } from "react";
import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { expectSameNode } from "../../../test-support/node-identity";
import { commitTest, mountTestApp, unmountTestApp } from "../../../test-support/react-harness";
import { WorkspaceSnapshotRestorer } from "../../../test-support/workspace-snapshot-restore";
import { loadConnectedRuntime } from "../../app/connected-loader";
import { appRoot } from "../../app/dom-root";
import { setScreen } from "../../app/navigation-store";
import { disposeNoticeLifecycle } from "../../app/notices-store";
import { attachLiveSession } from "../../features/computers/catalog-store";
import { setPhase } from "../../features/connection/connection-store";
import { replaceAgentsFromSnapshot } from "../../features/dashboard/catalog-store";
import { applyCapabilities, setOperationBusy } from "../../features/operations/capabilities-store";
import { selectPane, setAgentChat, setFullTerminal } from "../../features/session/session-store";
import { closeWorkspaceDetail, loadWorkspaceFile } from "../../features/workspace/actions";
import { closeWorkspaceInspector, toggleWorkspaceInspector } from "../../features/workspace/inspector";
import { inspectorOpen } from "../../features/workspace/inspector-store";
import { setLang } from "../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import { MOTION_MS } from "../../shared/ui/dom/motion";

/**
 * The column's entrance is the reader's own opening of it, seen once. The
 * column takes its place in the same commit either way (its width is never
 * eased: the session beside it may be the complete terminal); what is marked is
 * only that its content should be seen arriving. A column that comes back with
 * the window's room, and content drawn anew for another session, are not that.
 */
const seedRestorer = new WorkspaceSnapshotRestorer();
const revision = "a".repeat(64);

const live = {
  isConnected: () => true,
  paneRead: async () => ({ text: "", hash: "h" }),
  workspaceOpen: async (pane: string) => ({
    name: `repo-${pane}`, root: `/work/${pane}`,
    features: { files: true, git_status: false, git_diff: false, git_branches: false }, git: null,
  }),
  workspaceList: async (_pane: string, path = "") => ({
    path, entries: [{ name: "app.ts", path: "app.ts", kind: "file" as const, size: 25, modified_ms: 1, hidden: false, revision }],
    next_cursor: null, truncated: false, revision,
  }),
};

const column = () => appRoot().querySelector<HTMLElement>("aside.inspector");
/** Advance the fake clock and flush the promises the entrance resolves on. */
const settle = (ms = 0) => act(async () => {
  jest.advanceTimersByTime(ms);
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
});

async function resize(width: number): Promise<void> {
  await act(async () => {
    happy.happyDOM.setWindowSize({ width, height: 900 });
    window.dispatchEvent(new window.Event("resize"));
    commitTest();
  });
  await settle();
}

beforeEach(async () => {
  await resetBoardTestDOM();
  seedRestorer.capture();
  await loadConnectedRuntime();
  happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
  await act(async () => {
    setLang("zh");
    setPhase("live");
    setScreen("pane");
    selectPane("p1");
    setAgentChat(false);
    setFullTerminal(false);
    setOperationBusy(false);
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, []);
    replaceAgentsFromSnapshot({
      focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "p1" },
      workspaces: [{ workspace_id: "w1", label: "pairfob" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
      panes: ["p1", "p2"].map((pane_id) => ({
        pane_id, workspace_id: "w1", tab_id: "w1:t1", cwd: `/work/${pane_id}`, agent: "codex", agent_status: "idle" as const,
      })),
    });
    attachLiveSession(live as never);
    mountTestApp();
    commitTest();
  });
  // The entrance class lives for one motion window. Advance that window
  // explicitly so a starved event loop cannot end it before the assertion.
  jest.useFakeTimers();
});

afterEach(async () => {
  jest.useRealTimers();
  unmountTestApp();
  await act(async () => {
    closeWorkspaceInspector();
    closeTestDialogs();
    disposeNoticeLifecycle();
    attachLiveSession(null);
    setScreen("home");
    seedRestorer.restore();
    await Promise.resolve();
  });
  appRoot().replaceChildren();
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
});

test("the column the reader opens is marked as entering for the length of the move, and is in place at once", async () => {
  await act(async () => { toggleWorkspaceInspector(); });
  const opened = column()!;
  expect(appRoot().classList.contains("inspector")).toBe(true);
  expect(opened.classList.contains("is-entering")).toBe(true);
  await settle(MOTION_MS.panel + 40);
  // The same column, at rest: content drawn anew in it from here on is still.
  expectSameNode(column(), opened);
  expect(opened.classList.contains("is-entering")).toBe(false);
  await act(async () => { selectPane("p2"); commitTest(); });
  await settle();
  expect(column()!.classList.contains("is-entering")).toBe(false);
});

test("a column that comes back with the window's room was open all along: nothing enters", async () => {
  await act(async () => { toggleWorkspaceInspector(); });
  await settle(MOTION_MS.panel + 40);
  await resize(800);
  expect(column()).toBeNull();
  expect(inspectorOpen()).toBe(true);
  await resize(1440);
  expect(column()).not.toBeNull();
  expect(column()!.classList.contains("is-entering")).toBe(false);
});

test("closing takes the column away in the commit that closes it", async () => {
  await act(async () => { toggleWorkspaceInspector(); });
  await act(async () => { closeWorkspaceInspector(); });
  expect(column()).toBeNull();
  expect(appRoot().classList.contains("inspector")).toBe(false);
});

test("a file opened from the list walks into the open column and the list comes back the other way; another session's column does neither", async () => {
  const travel = () => [...column()!.classList].filter((name) => name === "is-pushing" || name === "is-popping");
  await act(async () => { toggleWorkspaceInspector(); });
  await settle(MOTION_MS.panel + 40);
  const opened = column()!;
  await act(async () => { await loadWorkspaceFile("app.ts"); });
  // The column and its head are the ones that were there: what is marked is its content's way in.
  expectSameNode(column(), opened);
  expect(travel()).toEqual(["is-pushing"]);
  await settle(MOTION_MS.panel + 40);
  expect(travel()).toEqual([]);
  await act(async () => { closeWorkspaceDetail(); });
  expect(travel()).toEqual(["is-popping"]);
  await settle(MOTION_MS.panel + 40);
  expect(travel()).toEqual([]);
  // Open on a file, the column is given another session: its list is not a way back from that file.
  await act(async () => { await loadWorkspaceFile("app.ts"); });
  await settle(MOTION_MS.panel + 40);
  await act(async () => { selectPane("p2"); commitTest(); });
  await settle();
  expect(travel()).toEqual([]);
});
