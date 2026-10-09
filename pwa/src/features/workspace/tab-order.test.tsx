import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { act } from "react";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { renderReact, unmountReact } from "../../../test-support/react-harness";
import { WorkspaceSnapshotRestorer } from "../../../test-support/workspace-snapshot-restore";
import { appRoot } from "../../app/dom-root";
import { setScreen } from "../../app/navigation-store";
import { setLang } from "../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import { WorkspaceScreen } from "../../pages/workspace/screen";
import { attachLiveSession } from "../computers/catalog-store";
import { setPhase } from "../connection/connection-store";
import { replaceAgentsFromSnapshot } from "../dashboard/catalog-store";
import { applyCapabilities } from "../operations/capabilities-store";
import { selectPane } from "../session/session-store";
import { clearWorkspacePendingReveal, enterWorkspace, workspaceModel } from "./index";
import { INSPECTOR_TAB_ORDER } from "./tab-order";

/**
 * The two tabs stand in one order wherever the list sits beside the page:
 * changes first, as in the inspector and as the tab a first look opens on. A
 * phone keeps its files first, upright or on its side.
 */

const seedRestorer = new WorkspaceSnapshotRestorer();
const revision = "a".repeat(64);
const realScreen = Object.getOwnPropertyDescriptor(globalThis, "screen");

function liveFixture() {
  return {
    isConnected: () => true,
    workspaceOpen: async () => ({
      name: "pairfob", root: "/work/pairfob",
      features: { files: true, git_status: true, git_diff: true, git_branches: false },
      git: { name: "pairfob", branch: "main", head: "1234567890", detached: false },
    }),
    workspaceList: async (_pane: string, path = "") => ({ path, entries: [], next_cursor: null, truncated: false, revision }),
    gitStatus: async () => ({
      branch: "main", head: "1234567890", upstream: null, ahead: 0, behind: 0, truncated: false, revision,
      changes: [{ path: "app.ts", original_path: null, index: " ", worktree: "M" }],
    }),
  };
}

/** A window of this width on a screen of this size; a phone's short side is under 500px. */
function device(width: number, height: number, screen = { width, height }): void {
  happy.happyDOM.setWindowSize({ width, height });
  Object.defineProperty(globalThis, "screen", { value: screen, configurable: true });
}

async function open(): Promise<void> {
  await act(async () => {
    setLang("zh");
    seedRestorer.capture();
    setPhase("live");
    setScreen("pane");
    selectPane("p1");
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, []);
    replaceAgentsFromSnapshot({
      focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "p1" },
      workspaces: [{ workspace_id: "w1", label: "pairfob" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
      panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/work/pairfob", agent: "codex", agent_status: "idle" }],
    });
    attachLiveSession(liveFixture() as never);
    renderReact(<WorkspaceScreen />);
    await enterWorkspace("p1");
  });
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
}

const tabs = () => [...appRoot().querySelectorAll<HTMLButtonElement>(".workspace-tabs [role='tab']")]
  .map((tab) => tab.textContent?.replace(/\d+\+?$/, ""));

beforeEach(async () => {
  await resetBoardTestDOM();
  clearWorkspacePendingReveal();
});

afterEach(async () => {
  await act(async () => { unmountReact(); });
  clearWorkspacePendingReveal();
  await act(async () => { closeTestDialogs(); await Promise.resolve(); });
  await act(async () => {
    seedRestorer.restore();
    attachLiveSession(null);
    setScreen("home");
    selectPane("");
  });
  if (realScreen) Object.defineProperty(globalThis, "screen", realScreen);
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
});

test("the inspector leads with changes", () => {
  expect([...INSPECTOR_TAB_ORDER]).toEqual(["changes", "files"]);
});

test("beside the list the screen shows them in the inspector's order, and opens on the first", async () => {
  for (const [width, height] of [[720, 700], [800, 700], [820, 1180], [1440, 900]]) {
    device(width, height);
    await open();
    expect(tabs()).toEqual(["更改", "文件"]);
    expect(workspaceModel.tab).toBe("changes");
    await act(async () => { unmountReact(); });
  }
});

test("a phone keeps files first, upright and on its side", async () => {
  for (const [width, height] of [[390, 844], [844, 390], [932, 430]]) {
    device(width, height);
    await open();
    expect(tabs()).toEqual(["文件", "更改"]);
    expect(workspaceModel.tab).toBe("files");
    await act(async () => { unmountReact(); });
  }
});

test("the order follows the window as it crosses the tier, with the screen open", async () => {
  device(800, 700, { width: 1440, height: 900 });
  await open();
  expect(tabs()).toEqual(["更改", "文件"]);
  await act(async () => {
    happy.happyDOM.setWindowSize({ width: 600, height: 700 });
    window.dispatchEvent(new window.Event("resize"));
  });
  expect(tabs()).toEqual(["文件", "更改"]);
  // The tab the reader is on does not change with it.
  expect(workspaceModel.tab).toBe("changes");
});
