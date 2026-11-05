import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { compileScss } from "../../../test-support/compiled-style";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { all, bootWorkspaceScreen, one, press, settle, teardownWorkspaceScreen } from "../../../test-support/workspace-harness";
import { waitFor } from "../../../test-support/wait";
import { stepWorkspaceDiff, workspaceDiffStep } from "./actions";
import { loadGitDiff, workspaceModel } from "./index";
import { resetReviewProgress } from "./review-progress";
import { foldShut } from "../../../test-support/exit";

/**
 * The change list and the stepper are one order: what is drawn from top to
 * bottom is what `‹ ›` and "next unseen" walk, however long the list is and
 * whichever of its groups are folded. A group says how many files it holds, a
 * row says its size aloud, and the header's totals are the whole or nothing.
 */

type Change = { path: string; index: string; worktree: string; stat?: object };
let changes: Change[];

function liveFixture() {
  return {
    isConnected: () => true,
    workspaceOpen: async () => ({
      name: "pairfob", root: "/work/pairfob",
      features: { files: true, git_status: true, git_diff: true, git_branches: false },
      git: { name: "pairfob", branch: "main", head: "1234567890", detached: false },
    }),
    workspaceList: async (_pane: string, path = "") => ({ path, entries: [], next_cursor: null, truncated: false, revision: "d".repeat(64) }),
    gitStatus: async () => ({
      branch: "main", head: "1234567890", upstream: null, ahead: 0, behind: 0, truncated: false, revision: "s".repeat(64),
      changes: changes.map((change) => ({ original_path: null, ...change })),
    }),
    gitDiff: async (_pane: string, path: string, layer: "worktree" | "staged") => ({
      path, layer, patch: "@@ -1 +1,2 @@\n-a\n+b\n+c\n", additions: 2, deletions: 1, binary: false, truncated: false, revision: "1".repeat(64),
    }),
  };
}

const drawn = () => all(".workspace-change").map((row) => row.dataset.change);
const titles = () => all(".workspace-change-group-title").map((title) => title.textContent);
const open = async (path: string, layer: "worktree" | "staged" = "worktree") => {
  await act(async () => { await loadGitDiff(path, layer); });
  await settle();
};

beforeEach(async () => {
  await resetBoardTestDOM();
  resetReviewProgress();
  changes = [];
});
afterEach(teardownWorkspaceScreen);

describe("a group counts the files it holds", () => {
  test("a row with a staged tag is one file under its title, and two diffs to see in the header", async () => {
    changes = [
      { path: "src/both.ts", index: "M", worktree: "M" },
      { path: "src/plain.ts", index: " ", worktree: "M" },
      { path: "README.md", index: "A", worktree: " " },
    ];
    await bootWorkspaceScreen(liveFixture(), { width: 1024 });
    // The titles count rows, like the tab's badge; the header counts the dots on them.
    expect(titles()).toEqual(["已暂存1", "未暂存2"]);
    expect(one(".workspace-tab .workspace-count").textContent).toBe("3");
    expect(one(".workspace-subline-reviewed").textContent).toBe("已看 0/4");
  });
});

describe("a row says its size", () => {
  test("in words, in the name a screen reader hears; the figures beside it are for the eye", async () => {
    changes = [
      { path: "src/app.ts", index: " ", worktree: "M", stat: { worktree: { additions: 3, deletions: 1 } } },
      { path: "logo.png", index: " ", worktree: "M", stat: { worktree: { additions: 0, deletions: 0, binary: true } } },
      { path: "src/new.ts", index: "?", worktree: "?" },
    ];
    await bootWorkspaceScreen(liveFixture());
    expect(one(`[data-change="worktree:src/app.ts"]`).getAttribute("aria-label")).toBe("src/app.ts · 未暂存 · 修改 · 新增 3 行, 删除 1 行 · 未看");
    expect(one(`[data-change="worktree:logo.png"]`).getAttribute("aria-label")).toContain(" · 二进制 · ");
    // Nothing counted: nothing claimed.
    expect(one(`[data-change="worktree:src/new.ts"]`).getAttribute("aria-label")).not.toContain("行");
    expect(one(`[data-change="worktree:src/app.ts"] .workspace-change-stat`).getAttribute("aria-hidden")).toBe("true");
  });
});

describe("the header's totals", () => {
  test("from a daemon that counts no lines there are none until every diff has been read: a part is not shown as the whole", async () => {
    changes = Array.from({ length: 4 }, (_, index) => ({ path: `src/f${index}.ts`, index: " ", worktree: "M" }));
    await bootWorkspaceScreen(liveFixture(), { width: 1024 });
    expect(document.querySelector(".workspace-subline-totals")).toBeNull();
    for (const [index, change] of changes.entries()) {
      await open(change.path);
      // Three of four read is still not the total.
      if (index < changes.length - 1) expect(document.querySelector(".workspace-subline-totals")).toBeNull();
    }
    expect(one(".workspace-subline-totals").textContent).toBe("+8−4");
  });
});

describe("a list longer than it draws", () => {
  test("its first row is the first step, and the stepper draws the list on to the row it opens", async () => {
    // The status lists the working tree's files first, then one that is only staged.
    changes = [
      ...Array.from({ length: 201 }, (_, index) => ({ path: `src/f${String(index).padStart(3, "0")}.ts`, index: " ", worktree: "M" })),
      { path: "README.md", index: "A", worktree: " " },
    ];
    await bootWorkspaceScreen(liveFixture(), { width: 1024 });
    // 200 rows are drawn: the staged file's, which the list puts first, and 199 of the working tree's.
    expect(drawn()).toHaveLength(200);
    expect(drawn()[0]).toBe("staged:README.md");
    expect(one(".workspace-more").textContent).toBe("再显示 2 项更改");
    // A group says how many files it holds, drawn or not.
    expect(titles()).toEqual(["已暂存1", "未暂存201"]);
    expect(one(".workspace-subline-reviewed").textContent).toBe("已看 0/202");

    await press(one(`[data-change="staged:README.md"]`));
    expect(workspaceDiffStep()).toMatchObject({ index: 0, total: 202, prev: null });
    expect(one(".workspace-step-where").textContent).toBe("1 / 202");

    // The last drawn row, then one step on: a row the list had not drawn yet.
    await open("src/f198.ts");
    expect(workspaceDiffStep().index).toBe(199);
    await act(async () => { stepWorkspaceDiff(1); });
    await waitFor(() => workspaceModel.detailPath === "src/f199.ts", "the step reached the row the list had not drawn");
    expect(workspaceModel.detailPath).toBe("src/f199.ts");
    expect(drawn()).toContain("worktree:src/f199.ts");
    expect(one(`[data-change="worktree:src/f199.ts"]`).classList.contains("active")).toBeTrue();
    expect(document.querySelector(".workspace-more")).toBeNull();
  });
});

describe("a folded group", () => {
  test("opens again when the review goes on into it, so the open diff's row is always there", async () => {
    changes = [
      { path: "README.md", index: "A", worktree: " " },
      { path: "src/app.ts", index: " ", worktree: "M" },
    ];
    await bootWorkspaceScreen(liveFixture(), { width: 1024 });
    const worktree = () => all<HTMLButtonElement>("button.workspace-change-group-title")[1];
    await press(worktree());
    expect(worktree().getAttribute("aria-expanded")).toBe("false");
    await foldShut();
    expect(drawn()).toEqual(["staged:README.md"]);

    await press(one(`[data-change="staged:README.md"]`));
    await act(async () => { stepWorkspaceDiff(1); });
    await waitFor(() => workspaceModel.detailPath === "src/app.ts", "the step opened the folded group's row");
    expect(workspaceModel.detailPath).toBe("src/app.ts");
    expect(worktree().getAttribute("aria-expanded")).toBe("true");
    expect(drawn()).toEqual(["staged:README.md", "worktree:src/app.ts"]);
  });
});

/**
 * What the rows rest on in the style sheet. A row's room is its list's, not
 * the window's: the list is a 304px column beside an open file from 900px and
 * the whole page at 820px. The widths themselves are checked in a browser.
 */
describe("the change list's styles", () => {
  const css = compileScss(new URL("../../style.scss", import.meta.url)).css
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const declared = (selector: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1].split(",").map((part) => part.trim()).includes(selector)).map((match) => match[2]).join("\n");
  const within = (query: string) => css.slice(css.indexOf(query)).match(/\{([\s\S]*?\})\s*\}/)?.[1] ?? "";

  test("a group's title stays above the rows it scrolls over, staged tags included", () => {
    const head = Number(declared(".workspace-change-group-head").match(/z-index:\s*(\d+)/)![1]);
    const tag = Number(declared(".workspace-change-pair > .workspace-change-layer").match(/z-index:\s*(\d+)/)![1]);
    expect(declared(".workspace-change-group-head")).toMatch(/position:\s*sticky/);
    expect(head).toBeGreaterThan(tag);
  });

  test("the list is the container its rows ask: a tag's size and a tagged row's bar need 480px of list", () => {
    expect(declared(".workspace-change-groups")).toMatch(/container:\s*changes\s*\/\s*inline-size/);
    expect(within("@container changes (min-width: 480px)")).toMatch(/\.workspace-change-layer \.workspace-change-stat\s*\{\s*display:\s*inline-flex/);
    expect(within("@container changes (max-width: 479.98px)")).toMatch(/\.workspace-change-tail \.workspace-change-bar\s*\{\s*display:\s*none/);
    // Not the window: a 304px list in a 1024px window is no wider for it.
    expect(css).not.toMatch(/@media \(min-width: 720px\)\s*\{\s*\.workspace-shell \.workspace-change-layer \.workspace-change-stat/);
  });
});
