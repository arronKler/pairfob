import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { expectSameNode } from "../../../test-support/node-identity";
import { commitTest, mountTestApp, unmountTestApp } from "../../../test-support/react-harness";
import { WorkspaceSnapshotRestorer } from "../../../test-support/workspace-snapshot-restore";
import { appRoot } from "../../app/dom-root";
import { disposeNoticeLifecycle } from "../../app/notices-store";
import { currentScreen, setScreen } from "../../app/navigation-store";
import { clearAllDiffNotes } from "../../lib/diff-notes";
import { bindKeyboardZones } from "../../lib/dom";
import { setLang } from "../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import { ProtocolError } from "../../lib/protocol/errors";
import { bindOverlayOrigin } from "../../shared/ui/overlay/origin";
import { attachLiveSession } from "../computers/catalog-store";
import { setPhase } from "../connection/connection-store";
import { replaceAgentsFromSnapshot } from "../dashboard/catalog-store";
import { applyCapabilities, setOperationBusy } from "../operations/capabilities-store";
import { selectPane, setAgentChat, setFullTerminal } from "../session/session-store";
import { clearWorkspacePendingReveal, enterWorkspace, leaveWorkspace, showWorkspaceTab, workspaceModel } from "./index";
import { closeWorkspaceInspector, toggleWorkspaceInspector } from "./inspector";

/**
 * Where focus is after a file is deleted or renamed from its row's menu. The
 * reload that follows draws every row again, so the row is known by what it
 * lists; a row that is gone hands focus to the one that took its place
 * (`focus-keeper`, `focus-landing`).
 */

const seedRestorer = new WorkspaceSnapshotRestorer();
const revision = "a".repeat(64);
let releases: Array<() => void> = [];
/** What the computer lists at the root; a delete or a rename changes it. */
let names: string[] = [];
/** How the next file operation ends on the computer. */
let refuse: (() => never) | null = null;
/** What a file operation waits for first: a slow computer. */
let slow: Promise<void> | null = null;

function liveFixture() {
  return {
    isConnected: () => true,
    paneRead: async () => ({ text: "", hash: "h" }),
    workspaceOpen: async (pane: string) => ({
      name: `repo-${pane}`,
      root: `/work/${pane}`,
      features: { files: true, git_status: true, git_diff: true, git_branches: true },
      git: { name: `repo-${pane}`, branch: "main", head: "1234567890", detached: false },
    }),
    workspaceList: async (_pane: string, path = "") => ({
      path,
      entries: path ? [{ name: "inner.ts", path: `${path}/inner.ts`, kind: "file" as const, size: 25, modified_ms: 1, hidden: false, revision }]
        : names.map((name) => name.endsWith("/")
          ? { name: name.slice(0, -1), path: name.slice(0, -1), kind: "directory" as const, size: 0, modified_ms: 1, hidden: false }
          : { name, path: name, kind: "file" as const, size: 25, modified_ms: 1, hidden: false, revision }),
      next_cursor: null, truncated: false, revision,
    }),
    gitStatus: async () => ({ branch: "main", head: "1234567890", upstream: "origin/main", ahead: 0, behind: 0, truncated: false, revision, changes: [] }),
    workspaceDelete: async (_pane: string, _root: string, path: string) => {
      await slow;
      refuse?.();
      names = names.filter((name) => name !== path);
      return { operation_id: "op-1", outcome: "applied" };
    },
    workspaceRename: async (_pane: string, _root: string, path: string, to: string) => {
      refuse?.();
      names = names.map((name) => name === path ? to : name);
      return { operation_id: "op-2", outcome: "applied" };
    },
  };
}

async function settle(ms = 0): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, ms)); });
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
}

/** The files list: the screen below 900px, the inspector's column at 1440px. */
async function boot(width: number): Promise<void> {
  happy.happyDOM.setWindowSize({ width, height: 900 });
  await act(async () => {
    setLang("zh");
    setPhase("live");
    setScreen("pane");
    selectPane("p1");
    setAgentChat(false);
    setFullTerminal(false);
    setOperationBusy(false);
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES, rename_file: true, delete_file: true }, []);
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
  await act(async () => {
    if (width >= 900) toggleWorkspaceInspector();
    else await enterWorkspace("p1");
  });
  await settle();
  await act(async () => { showWorkspaceTab("files"); });
  await settle();
}

type Input = "mouse" | "touch" | "key";

/** Press a control the way `input` does: a pointer goes down first, a key is pressed on what has focus. */
async function press(target: HTMLElement, input: Input): Promise<void> {
  await act(async () => {
    if (input === "key") {
      target.focus();
      target.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event);
    } else {
      target.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerType: input }) as unknown as Event);
      target.focus();
    }
    target.click();
  });
  await settle();
}

const more = (path: string) => appRoot().querySelector<HTMLButtonElement>(`.workspace-row-more[data-trigger-of="${path}"]`);
const main = (path: string) => appRoot().querySelector<HTMLButtonElement>(`.workspace-row-main[data-trigger-of="${path}"]`);
const inDialog = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("dialog[open] button")]
  .find((button) => button.textContent?.replace(/…$/, "").trim() === text)!;

/** The row's menu, its Delete, and the confirmation. */
async function remove(path: string, input: Input): Promise<void> {
  await press(more(path)!, input);
  await press(inDialog("删除文件"), input);
  await settle(20);
  await press(inDialog("删除文件"), input);
  await settle(60);
}

beforeEach(async () => {
  await resetBoardTestDOM();
  clearWorkspacePendingReveal();
  clearAllDiffNotes();
  seedRestorer.capture();
  names = ["lib/", "a.ts", "b.ts", "c.ts"];
  refuse = null;
  slow = null;
  releases = [bindOverlayOrigin(document), bindKeyboardZones(document)];
});

afterEach(async () => {
  unmountTestApp();
  await act(async () => {
    closeWorkspaceInspector();
    if (currentScreen() === "workspace") leaveWorkspace();
    clearWorkspacePendingReveal();
    closeTestDialogs();
    disposeNoticeLifecycle();
    setOperationBusy(false);
    attachLiveSession(null);
    setScreen("home");
    seedRestorer.restore();
    await Promise.resolve();
  });
  for (const release of releases) release();
  appRoot().replaceChildren();
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
});

describe("a file deleted from its row's menu", () => {
  for (const [width, input] of [[800, "key"], [800, "mouse"], [1440, "key"], [1440, "mouse"], [1440, "touch"]] as const) {
    test(`hands focus to the row that took its place (${width}px, ${input})`, async () => {
      await boot(width);
      await remove("b.ts", input);
      expect(names).toEqual(["lib/", "a.ts", "c.ts"]);
      expect(more("b.ts")).toBeNull();
      expectSameNode(document.activeElement, more("c.ts"));
    });
  }

  test("the last row hands it to the one above", async () => {
    await boot(800);
    await remove("c.ts", "key");
    expectSameNode(document.activeElement, more("b.ts"));
  });

  test("the last file hands it to the rows that are left, and the last row of all to what the list starts with", async () => {
    names = ["lib/", "a.ts"];
    await boot(800);
    await remove("a.ts", "key");
    expectSameNode(document.activeElement, main("lib"));

    unmountTestApp();
    names = ["a.ts"];
    await boot(800);
    await remove("a.ts", "key");
    expect(appRoot().querySelector(".workspace-empty")).not.toBeNull();
    expectSameNode(document.activeElement, appRoot().querySelector(".workspace-crumb.is-current"));
  });

  test("a delete the computer refused leaves the reader on the row, drawn again by the reload", async () => {
    await boot(800);
    refuse = () => { throw new ProtocolError("conflict", "changed on disk"); };
    const before = more("b.ts");
    await remove("b.ts", "key");
    expect(names).toContain("b.ts");
    expect(more("b.ts") === before).toBeFalse();
    expectSameNode(document.activeElement, more("b.ts"));
  });

  test("a reader who pressed somewhere else meanwhile keeps the place they chose", async () => {
    await boot(800);
    let finish!: () => void;
    slow = new Promise<void>((resolve) => { finish = resolve; });
    await remove("b.ts", "mouse");
    expect(names).toContain("b.ts");
    const back = appRoot().querySelector<HTMLButtonElement>(".workspace-chrome .back")!;
    await act(async () => {
      back.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }) as unknown as Event);
      back.focus();
    });
    await act(async () => { finish(); });
    await settle(60);
    expect(more("b.ts")).toBeNull();
    expectSameNode(document.activeElement, back);
  });

  test("a finger on a phone is left alone, as before", async () => {
    await boot(390);
    await remove("b.ts", "touch");
    expect(more("b.ts")).toBeNull();
    expect(document.activeElement?.matches(".workspace-row-more, .workspace-row-main") ?? false).toBeFalse();
  });
});

describe("a file renamed from its row's menu", () => {
  test("keeps the reader on its row under the new name", async () => {
    await boot(800);
    await press(more("b.ts")!, "key");
    await press(inDialog("改文件名"), "key");
    await settle(20);
    const field = document.querySelector<HTMLInputElement>("dialog[open] input")!;
    await act(async () => {
      field.value = "zz.ts";
      field.dispatchEvent(new happy.Event("input", { bubbles: true }) as unknown as Event);
      field.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event);
      field.closest("dialog")!.close("confirm");
    });
    await settle(60);
    expect(names).toEqual(["lib/", "a.ts", "zz.ts", "c.ts"]);
    expectSameNode(document.activeElement, more("zz.ts"));
  });
});

describe("a row that led somewhere else", () => {
  test("Enter on a folder goes on from the first row of what it holds, not from where the folder stood", async () => {
    await boot(800);
    await press(main("lib")!, "key");
    await settle(20);
    expect(workspaceModel.directory).toBe("lib");
    expectSameNode(document.activeElement, main("lib/inner.ts"));
  });
});
