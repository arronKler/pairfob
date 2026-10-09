import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { commitTest, mountTestApp, unmountTestApp } from "../../../test-support/react-harness";
import { WorkspaceSnapshotRestorer } from "../../../test-support/workspace-snapshot-restore";
import { appRoot } from "../../app/dom-root";
import { disposeNoticeLifecycle } from "../../app/notices-store";
import { currentScreen, setScreen } from "../../app/navigation-store";
import { clearAllDiffNotes } from "../../lib/diff-notes";
import { bindKeyboardZones } from "../../lib/dom";
import { setLang } from "../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import { bindOverlayOrigin } from "../../shared/ui/overlay/origin";
import { attachLiveSession } from "../computers/catalog-store";
import { setPhase } from "../connection/connection-store";
import { replaceAgentsFromSnapshot } from "../dashboard/catalog-store";
import { applyCapabilities, setOperationBusy } from "../operations/capabilities-store";
import { selectPane, setAgentChat, setFullTerminal } from "../session/session-store";
import { clearWorkspacePendingReveal, leaveWorkspace, loadDirectory, loadGitDiff, showWorkspaceTab, workspaceModel } from "./index";
import { closeWorkspaceInspector, toggleWorkspaceInspector } from "./inspector";
import { inspectorOpen } from "./inspector-store";

/**
 * The files surfaces' ways back, pressed twice by accident. Each swaps what is
 * under the pointer, and the second half of the doubled press must press
 * nothing on what came up there (`back-press`, `shared/ui/dom/back-tap`). A
 * key is nobody's doubled press.
 */

const seedRestorer = new WorkspaceSnapshotRestorer();
const revision = "a".repeat(64);
let releases: Array<() => void> = [];
let branchReads = 0;

function liveFixture() {
  const file = (path: string) => ({ name: path.split("/").pop()!, path, kind: "file" as const, size: 25, modified_ms: 1, hidden: false, revision });
  const dir = (path: string) => ({ name: path.split("/").pop()!, path, kind: "directory" as const, size: 0, modified_ms: 1, hidden: false });
  const listing: Record<string, unknown[]> = {
    "": [dir("src"), file("app.ts")],
    src: [dir("src/lib"), file("src/main.ts")],
    "src/lib": [dir("src/lib/deep"), file("src/lib/util.ts")],
    "src/lib/deep": [file("src/lib/deep/leaf.ts")],
  };
  return {
    isConnected: () => true,
    paneRead: async () => ({ text: "", hash: "h" }),
    workspaceOpen: async (pane: string) => ({
      name: `repo-${pane}`,
      root: `/work/${pane}`,
      features: { files: true, git_status: true, git_diff: true, git_branches: true },
      git: { name: `repo-${pane}`, branch: "main", head: "1234567890", detached: false },
    }),
    workspaceList: async (_pane: string, path = "") => ({ path, entries: listing[path] ?? [], next_cursor: null, truncated: false, revision }),
    gitStatus: async () => ({
      branch: "main", head: "1234567890", upstream: "origin/main", ahead: 0, behind: 0, truncated: false, revision,
      changes: [{ path: "app.ts", original_path: null, index: " ", worktree: "M" }],
    }),
    gitDiff: async (_pane: string, path: string, layer: "worktree" | "staged") => ({
      path, layer, patch: "@@ -1 +1 @@\n-false\n+true\n", additions: 1, deletions: 1, binary: false, truncated: false, revision,
    }),
    gitBranches: async () => {
      branchReads += 1;
      return { items: [], truncated: false, revision };
    },
  };
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
}

async function bootInspector(): Promise<void> {
  happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
  await act(async () => {
    setLang("zh");
    setPhase("live");
    setScreen("pane");
    selectPane("p1");
    setAgentChat(false);
    setFullTerminal(false);
    setOperationBusy(false);
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES, prompt_agent: true }, []);
    replaceAgentsFromSnapshot({
      focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "p1" },
      workspaces: [{ workspace_id: "w1", label: "pairfob" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
      panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/work/p1", agent: "codex", agent_status: "idle" as const }],
    });
    attachLiveSession(liveFixture() as never);
    mountTestApp();
    commitTest();
  });
  await act(async () => { toggleWorkspaceInspector(); });
  await settle();
}

function one<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = appRoot().querySelector<T>(selector);
  if (!found) throw new Error(`missing ${selector}: ${appRoot().innerHTML.slice(0, 300)}`);
  return found;
}

/** Where the pointer is for the whole doubled press: the screen changes, the pointer does not move. */
const AT = { clientX: 1200, clientY: 80 };

/**
 * One half of a press with a mouse or a finger on `target`. False when its
 * click was taken away before it reached anything.
 */
async function pointerPress(target: Element): Promise<boolean> {
  let delivered = false;
  await act(async () => {
    target.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerId: 1, isPrimary: true, ...AT }) as unknown as Event);
    delivered = target.dispatchEvent(new happy.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1, ...AT }) as unknown as Event);
  });
  await settle();
  return delivered;
}

/** Enter on a button: a click that no pointer made. */
async function keyPress(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event);
    target.dispatchEvent(new happy.MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }) as unknown as Event);
  });
  await settle();
}

const crumbs = () => [...appRoot().querySelectorAll<HTMLButtonElement>(".workspace-crumb")].map((crumb) => crumb.textContent);

beforeEach(async () => {
  await resetBoardTestDOM();
  clearWorkspacePendingReveal();
  clearAllDiffNotes();
  seedRestorer.capture();
  branchReads = 0;
  releases = [bindOverlayOrigin(document), bindKeyboardZones(document)];
});

afterEach(async () => {
  // A key ends whatever guard a test left armed.
  document.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Shift", bubbles: true }) as unknown as Event);
  unmountTestApp();
  await act(async () => {
    closeWorkspaceInspector();
    if (currentScreen() === "workspace") leaveWorkspace();
    clearWorkspacePendingReveal();
    closeTestDialogs();
    disposeNoticeLifecycle();
    attachLiveSession(null);
    setScreen("home");
    seedRestorer.restore();
    await Promise.resolve();
  });
  for (const release of releases) release();
  appRoot().replaceChildren();
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
});

describe("the inspector's file chip", () => {
  test("pressed twice, it returns to the list and the second press does not open the branch sheet under it", async () => {
    await bootInspector();
    await act(async () => { await loadGitDiff("app.ts", "worktree"); });
    await settle();
    expect(await pointerPress(one(".inspector-switch-file"))).toBeTrue();
    expect(workspaceModel.view).toBe("browser");
    expect(await pointerPress(one(".inspector-list .workspace-branch"))).toBeFalse();
    expect(branchReads).toBe(0);
    expect(document.querySelector("dialog.workspace-branch-sheet")).toBeNull();
  });

  test("Enter on it arms nothing: the next press is the reader's own", async () => {
    await bootInspector();
    await act(async () => { await loadGitDiff("app.ts", "worktree"); });
    await settle();
    await keyPress(one(".inspector-switch-file"));
    expect(workspaceModel.view).toBe("browser");
    expect(await pointerPress(one(".inspector-list .workspace-branch"))).toBeTrue();
    expect(branchReads).toBe(1);
  });
});

describe("the inspector's Close", () => {
  test("pressed twice, it closes the column and the second press does not reach the session's own actions", async () => {
    await bootInspector();
    expect(await pointerPress(one(".inspector .inspector-close"))).toBeTrue();
    expect(inspectorOpen()).toBeFalse();
    // The session header's trailing actions stand where the column's corner was.
    expect(await pointerPress(one(".main .chrome-actions .icon-more"))).toBeFalse();
    expect(document.querySelector("dialog[open]")).toBeNull();
    expect(await pointerPress(one(".main .chrome-actions .icon-workspace"))).toBeFalse();
    expect(inspectorOpen()).toBeFalse();
  });
});

describe("the directory's ways up", () => {
  async function openAt(directory: string): Promise<void> {
    await bootInspector();
    await act(async () => {
      showWorkspaceTab("files");
      await loadDirectory(directory);
    });
    await settle();
    expect(workspaceModel.directory).toBe(directory);
  }

  test("Up pressed twice climbs one folder, not two", async () => {
    await openAt("src/lib");
    expect(await pointerPress(one(".workspace-up"))).toBeTrue();
    expect(workspaceModel.directory).toBe("src");
    expect(await pointerPress(one(".workspace-up"))).toBeFalse();
    expect(workspaceModel.directory).toBe("src");
  });

  test("Enter on Up twice climbs two: keys are counted one by one", async () => {
    await openAt("src/lib");
    await keyPress(one(".workspace-up"));
    await keyPress(one(".workspace-up"));
    expect(workspaceModel.directory).toBe("");
  });

  test("a folder above pressed twice lands in that folder, whatever the trail draws under the pointer next", async () => {
    await openAt("src/lib/deep");
    const lib = [...appRoot().querySelectorAll<HTMLButtonElement>(".workspace-crumb")].find((crumb) => crumb.textContent === "lib")!;
    expect(await pointerPress(lib)).toBeTrue();
    expect(workspaceModel.directory).toBe("src/lib");
    const src = [...appRoot().querySelectorAll<HTMLButtonElement>(".workspace-crumb")].find((crumb) => crumb.textContent === "src")!;
    expect(await pointerPress(src)).toBeFalse();
    expect(workspaceModel.directory).toBe("src/lib");
    expect(crumbs().at(-1)).toBe("lib");
  });
});
