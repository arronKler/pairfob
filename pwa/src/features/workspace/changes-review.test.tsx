import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { barCells } from "./changes";
import { clearWorkspacePendingReveal, enterWorkspace, refreshWorkspace, workspaceModel } from "./index";

/**
 * Reviewing the changes: a row is a ring until its diff has been read to the
 * end and the session list's filled dot after, with the diff's size beside it;
 * the header counts, and the list offers the next diff not yet seen.
 */

const seedRestorer = new WorkspaceSnapshotRestorer();
/** The patch revision each diff is served at; a test bumps one to say the agent changed the file. */
let revisions: Record<string, string>;
/** What a daemon with git_change_stats adds to each change; null for one without. */
let stats: Record<string, { stat?: object; modified_ms?: number }> | null;
/** What the agent's turn wrote, from a daemon with trace_writes; null for one without. */
let written: string[] | null;
/** The diff's box as the browser would measure it; happy-dom measures nothing. */
let box: { height: number; content: number } | null;
const realHeights = {
  client: Object.getOwnPropertyDescriptor(happy.HTMLElement.prototype, "clientHeight"),
  scroll: Object.getOwnPropertyDescriptor(happy.HTMLElement.prototype, "scrollHeight"),
};

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
      changes: [
        { path: "src/app.ts", original_path: null, index: "M", worktree: "M", ...stats?.["src/app.ts"] },
        { path: "src/styles.scss", original_path: null, index: " ", worktree: "M", ...stats?.["src/styles.scss"] },
      ],
    }),
    ...(written ? { agentTurnWrites: async () => written } : {}),
    gitDiff: async (_pane: string, path: string, layer: "worktree" | "staged") => ({
      path, layer, patch: "@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+more\n", additions: 2, deletions: 1, binary: false, truncated: false,
      revision: revisions[`${layer}:${path}`] ?? "1".repeat(64),
    }),
  };
}

const one = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`missing ${selector}`);
  return found;
};
const rowOf = (key: string) => one<HTMLButtonElement>(`[data-change="${key}"]`);
/** The size a diff's row shows: its own, or for a file's one row with a staged tag, the row's tail beside the tag. */
const statOf = (key: string) => rowOf(key).querySelector(".workspace-change-stat")
  ?? rowOf(key).parentElement?.querySelector(":scope > .workspace-change-tail .workspace-change-stat") ?? null;
const seen = (key: string) => rowOf(key).classList.contains("is-reviewed");
const back = () => one<HTMLButtonElement>(".workspace-chrome .back");

async function settle(): Promise<void> {
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
  await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 0)); });
}

async function press(target: HTMLElement): Promise<void> {
  await act(async () => { target.click(); });
  await settle();
}

async function menuRow(label: string): Promise<void> {
  await press(one(".workspace-detail-more"));
  const row = [...one("dialog.workspace-file-menu[open]").querySelectorAll<HTMLElement>("button")].find((button) => button.textContent?.includes(label));
  if (!row) throw new Error(`no menu row ${label}`);
  await press(row);
}

async function boot(): Promise<void> {
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
  await settle();
}

beforeEach(async () => {
  await resetBoardTestDOM();
  clearWorkspacePendingReveal();
  revisions = {};
  box = null;
  stats = null;
  written = null;
  const measured = (own: "height" | "content", real: PropertyDescriptor | undefined) => ({
    configurable: true,
    get(this: HTMLElement) { return box && this.classList.contains("workspace-diff") ? box[own] : real?.get?.call(this) ?? 0; },
  });
  Object.defineProperty(happy.HTMLElement.prototype, "clientHeight", measured("height", realHeights.client));
  Object.defineProperty(happy.HTMLElement.prototype, "scrollHeight", measured("content", realHeights.scroll));
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
  if (realHeights.client) Object.defineProperty(happy.HTMLElement.prototype, "clientHeight", realHeights.client);
  if (realHeights.scroll) Object.defineProperty(happy.HTMLElement.prototype, "scrollHeight", realHeights.scroll);
});

describe("a change row says whether its diff was seen", () => {
  test("every row starts unseen, without a size, and the header counts them", async () => {
    await boot();
    expect(workspaceModel.tab).toBe("changes");
    for (const key of ["staged:src/app.ts", "worktree:src/app.ts", "worktree:src/styles.scss"]) {
      expect(seen(key)).toBeFalse();
      expect(rowOf(key).getAttribute("aria-label")).toContain("未看");
      expect(rowOf(key).querySelector(".workspace-change-stat")).toBeNull();
    }
    expect(one(".workspace-subline-reviewed").textContent).toBe("已看 0/3");
    // Nothing is seen yet: the first row is where a review starts.
    expect(document.querySelector(".workspace-next-unseen")).toBeNull();
  });

  test("a diff that fits its box is seen on arrival: the row fills its dot and shows the diff's size", async () => {
    await boot();
    await press(rowOf("worktree:src/app.ts"));
    expect(workspaceModel.view).toBe("diff");
    await press(back());
    expect(seen("worktree:src/app.ts")).toBeTrue();
    expect(rowOf("worktree:src/app.ts").getAttribute("aria-label")).toContain("已看");
    expect(statOf("worktree:src/app.ts")?.textContent).toBe("+2−1");
    // The same file's staged layer is another diff.
    expect(seen("staged:src/app.ts")).toBeFalse();
    expect(one(".workspace-subline-reviewed").textContent).toBe("已看 1/3");
  });

  test("a long diff is seen once the reader has scrolled to its end", async () => {
    await boot();
    box = { height: 400, content: 1200 };
    await press(rowOf("worktree:src/styles.scss"));
    const diff = one(".workspace-diff");
    await act(async () => { diff.scrollTop = 300; diff.dispatchEvent(new window.Event("scroll")); });
    await press(back());
    expect(seen("worktree:src/styles.scss")).toBeFalse();

    await press(rowOf("worktree:src/styles.scss"));
    const again = one(".workspace-diff");
    await act(async () => { again.scrollTop = 790; again.dispatchEvent(new window.Event("scroll")); });
    await press(back());
    expect(seen("worktree:src/styles.scss")).toBeTrue();
  });
});

describe("going on through the review", () => {
  test("once something is seen the list offers the next diff that is not, in review order", async () => {
    await boot();
    await press(rowOf("staged:src/app.ts"));
    await press(back());
    const next = one<HTMLButtonElement>(".workspace-next-unseen");
    expect(next.textContent).toBe("下一个未看");
    await press(next);
    expect(workspaceModel.view).toBe("diff");
    expect(workspaceModel.detailPath).toBe("src/app.ts");
    expect(workspaceModel.diffLayer).toBe("worktree");
  });

  test("with everything seen there is nowhere to go on to", async () => {
    await boot();
    for (const key of ["staged:src/app.ts", "worktree:src/app.ts", "worktree:src/styles.scss"]) {
      await press(rowOf(key));
      await press(back());
    }
    expect(one(".workspace-subline-reviewed").textContent).toBe("已看 3/3");
    expect(document.querySelector(".workspace-next-unseen")).toBeNull();
  });
});

describe("the reader's own answer, from the diff's menu", () => {
  test("a seen diff can be marked unseen, and reading it to the end again leaves it so", async () => {
    await boot();
    await press(rowOf("worktree:src/app.ts"));
    await menuRow("标为未看");
    await press(back());
    expect(seen("worktree:src/app.ts")).toBeFalse();
    await press(rowOf("worktree:src/app.ts"));
    await press(back());
    expect(seen("worktree:src/app.ts")).toBeFalse();
  });

  test("a long diff can be marked seen without scrolling to its end", async () => {
    await boot();
    box = { height: 400, content: 1200 };
    await press(rowOf("worktree:src/styles.scss"));
    await menuRow("标为已看");
    await press(back());
    expect(seen("worktree:src/styles.scss")).toBeTrue();
  });
});

describe("a file the agent changed again", () => {
  test("the next status load reads the seen diffs, and the one that changed is unseen again", async () => {
    await boot();
    await press(rowOf("worktree:src/app.ts"));
    await press(back());
    await press(rowOf("worktree:src/styles.scss"));
    await press(back());
    expect(one(".workspace-subline-reviewed").textContent).toBe("已看 2/3");

    revisions["worktree:src/app.ts"] = "2".repeat(64);
    await act(async () => { await refreshWorkspace(); });
    await settle();
    expect(seen("worktree:src/app.ts")).toBeFalse();
    expect(seen("worktree:src/styles.scss")).toBeTrue();
    expect(one(".workspace-subline-reviewed").textContent).toBe("已看 1/3");
  });
});

describe("a daemon that counts lines and stamps files", () => {
  test("every row has its size before any diff is opened, and the header adds them up", async () => {
    const NOW = Date.now();
    stats = {
      "src/app.ts": { stat: { staged: { additions: 4, deletions: 0 }, worktree: { additions: 1, deletions: 2 } }, modified_ms: NOW - 2 * 60_000 },
      "src/styles.scss": { stat: { worktree: { additions: 10, deletions: 0 } }, modified_ms: NOW - 3 * 3_600_000 },
    };
    await boot();
    expect(statOf("staged:src/app.ts")?.textContent).toBe("+4");
    expect(statOf("worktree:src/app.ts")?.textContent).toBe("+1−2");
    expect(statOf("worktree:src/styles.scss")?.textContent).toBe("+10");
    expect(one(".workspace-subline-totals").textContent).toBe("+15−2");
    // Sizes do not make a diff seen.
    expect(seen("worktree:src/app.ts")).toBeFalse();
    expect(one(".workspace-subline-reviewed").textContent).toBe("已看 0/3");
  });

  test("the bar shows the same proportion in five cells, and neither side that changed loses its cell", () => {
    // A change of a few lines is a cell a line, and the rest of the bar stays empty.
    expect(barCells(3, 1)).toEqual({ added: 3, removed: 1, cells: 5 });
    expect(barCells(30, 10)).toEqual({ added: 4, removed: 1, cells: 5 });
    expect(barCells(1, 99)).toEqual({ added: 1, removed: 4, cells: 5 });
    expect(barCells(99, 1)).toEqual({ added: 4, removed: 1, cells: 5 });
    expect(barCells(7, 0)).toEqual({ added: 5, removed: 0, cells: 5 });
    expect(barCells(0, 2)).toEqual({ added: 0, removed: 2, cells: 5 });
    expect(barCells(1, 1)).toEqual({ added: 1, removed: 1, cells: 5 });
    expect(barCells(0, 0)).toEqual({ added: 0, removed: 0, cells: 0 });
  });

  test("a row says when its file last changed, warm while that is minutes ago", async () => {
    const NOW = Date.now();
    stats = {
      "src/app.ts": { modified_ms: NOW - 2 * 60_000 },
      "src/styles.scss": { modified_ms: NOW - 3 * 3_600_000 },
    };
    await boot();
    const recent = rowOf("worktree:src/app.ts").querySelector(".workspace-change-age")!;
    expect(recent.textContent).toBe("2 分钟前");
    expect(recent.classList.contains("is-recent")).toBeTrue();
    const older = rowOf("worktree:src/styles.scss").querySelector(".workspace-change-age")!;
    expect(older.textContent).toBe("3 小时前");
    expect(older.classList.contains("is-recent")).toBeFalse();
  });

  test("a binary change says so where its size would be", async () => {
    stats = { "src/styles.scss": { stat: { worktree: { additions: 0, deletions: 0, binary: true } } } };
    await boot();
    expect(statOf("worktree:src/styles.scss")?.textContent).toBe("二进制");
  });
});

describe("the files the agent's turn wrote", () => {
  test("are marked on their rows, in place of the clock, and said aloud", async () => {
    stats = { "src/app.ts": { modified_ms: Date.now() - 60_000 }, "src/styles.scss": { modified_ms: Date.now() - 60_000 } };
    written = ["/work/pairfob/src/app.ts", "/etc/hosts"];
    await boot();
    // The file is one row; its staged diff is a tag on it and repeats nothing the row says of the file.
    const row = rowOf("worktree:src/app.ts");
    expect(row.querySelector(".workspace-turn-mark")?.textContent).toBe("本轮");
    expect(row.querySelector(".workspace-change-age")).toBeNull();
    expect(row.getAttribute("aria-label")).toContain("Agent 本轮改过");
    expect(rowOf("staged:src/app.ts").querySelector(".workspace-turn-mark")).toBeNull();
    expect(rowOf("worktree:src/styles.scss").querySelector(".workspace-turn-mark")).toBeNull();
    expect(rowOf("worktree:src/styles.scss").querySelector(".workspace-change-age")?.textContent).toBe("1 分钟前");
  });

  test("follow the turn while the changes are open: coming back to the tab, and the agent stopping, read it again", async () => {
    const marked = () => [...document.querySelectorAll(".workspace-change")].filter((row) => row.querySelector(".workspace-turn-mark"))
      .map((row) => (row as HTMLElement).dataset.change);
    const agent = (status: "idle" | "working" | "done") => replaceAgentsFromSnapshot({
      focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "p1" },
      workspaces: [{ workspace_id: "w1", label: "pairfob" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
      panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/work/pairfob", agent: "codex", agent_status: status }],
    });
    written = ["src/app.ts"];
    await boot();
    expect(marked()).toEqual(["worktree:src/app.ts"]);

    // A new prompt, and the agent writes another file: the reader looks at the files and comes back.
    written = ["src/styles.scss"];
    const [changesTab, filesTab] = [...document.querySelectorAll<HTMLElement>(".workspace-tabs [role='tab']")];
    await press(filesTab);
    await press(changesTab);
    expect(marked()).toEqual(["worktree:src/styles.scss"]);

    // Without touching anything: the agent goes to work and stops, having written the first file again.
    written = ["src/styles.scss", "src/app.ts"];
    await act(async () => { agent("working"); });
    await act(async () => { agent("done"); });
    await settle();
    expect(marked()).toEqual(["worktree:src/app.ts", "worktree:src/styles.scss"]);
  });

  test("a daemon that cannot say leaves the rows as they are", async () => {
    await boot();
    expect(document.querySelector(".workspace-turn-mark")).toBeNull();
  });
});
