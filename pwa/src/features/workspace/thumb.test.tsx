import { act } from "react";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { all, bootWorkspaceScreen, one, press, settle, teardownWorkspaceScreen } from "../../../test-support/workspace-harness";
import { WORKSPACE_CACHE_TTL_MS } from "../../lib/workspace-cache";
import { loadGitDiff, showWorkspaceTab } from "./index";
import { thumbAt } from "./thumb";

/**
 * The chosen tab and the chosen layer are marked by one thumb that slides to
 * the choice. The strip says where the choice is (an index and a count, as
 * custom properties) and the style sheet moves the mark there: a test DOM lays
 * nothing out, so these are the numbers the strip writes and the rules that
 * read them.
 */

const sheet = (name: string) => Bun.file(new URL(`./${name}.scss`, import.meta.url)).text();
const thumb = await sheet("workspace-thumb");
const shell = await sheet("workspace");
const detail = await sheet("workspace-detail");
const inspector = await sheet("workspace-inspector");
const preview = await sheet("workspace-preview");

let changes: Array<{ path: string; index: string; worktree: string }>;

const live = () => ({
  isConnected: () => true,
  workspaceOpen: async () => ({
    name: "pairfob", root: "/work/pairfob",
    features: { files: true, git_status: true, git_diff: true, git_branches: false },
    git: { name: "pairfob", branch: "main", head: "1234567890", detached: false },
  }),
  workspaceList: async (_pane: string, path = "") => ({ path, entries: [], next_cursor: null, truncated: false, revision: "d".repeat(64) }),
  gitStatus: async () => ({
    branch: "main", head: "1234567890", upstream: null, ahead: 0, behind: 0, truncated: false, revision: "s".repeat(64),
    changes: changes.map((change) => ({ ...change, original_path: null })),
  }),
  gitDiff: async (_pane: string, path: string, layer: "worktree" | "staged") => ({
    path, layer, patch: "@@ -1 +1 @@\n-a\n+b\n", additions: 1, deletions: 1, binary: false, truncated: false, revision: "1".repeat(64),
  }),
});

const place = (strip: HTMLElement) => ({ on: strip.style.getPropertyValue("--thumb-on"), count: strip.style.getPropertyValue("--thumb-count") });

beforeEach(async () => {
  await resetBoardTestDOM();
  changes = [{ path: "src/both.ts", index: "M", worktree: "M" }, { path: "src/plain.ts", index: " ", worktree: "M" }];
});
afterEach(async () => {
  setSystemTime();
  await teardownWorkspaceScreen();
});

describe("the strip says where its choice is", () => {
  test("the tabs: the chosen one's place among the two, and the other after it is picked", async () => {
    await bootWorkspaceScreen(live(), { width: 390 });
    const strip = one(".workspace-tabs");
    const tabs = all<HTMLButtonElement>(".workspace-tabs [role='tab']");
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false"]);
    expect(place(strip)).toEqual({ on: "0", count: "2" });
    await press(tabs[1]);
    // The same strip, moved: a transition has somewhere to start from.
    expect(one(".workspace-tabs") === strip).toBeTrue();
    expect(place(strip)).toEqual({ on: "1", count: "2" });
    // Still roles of a tab list, each selected by `aria-selected` as before.
    expect(strip.getAttribute("role")).toBe("tablist");
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true"]);
  });

  test("the two layers of a diff, by the layer that is open", async () => {
    await bootWorkspaceScreen(live(), { width: 390 });
    await act(async () => { await loadGitDiff("src/both.ts", "staged"); });
    await settle();
    const strip = one(".workspace-layer-switch");
    const pressed = () => all(".workspace-layer-switch button").map((button) => button.getAttribute("aria-pressed"));
    expect(pressed()).toEqual(["true", "false"]);
    expect(place(strip)).toEqual({ on: "0", count: "2" });
    await press(all(".workspace-layer-switch button")[1]);
    expect(one(".workspace-layer-switch") === strip).toBeTrue();
    expect(pressed()).toEqual(["false", "true"]);
    expect(place(strip)).toEqual({ on: "1", count: "2" });
  });

  test("nothing chosen shows no mark", () => {
    expect(thumbAt(-1, 3)).toEqual({ "--thumb-on": 0, "--thumb-count": 3, "--thumb-shown": 0 } as never);
    expect(thumbAt(2, 3)).toEqual({ "--thumb-on": 2, "--thumb-count": 3 } as never);
  });
});

describe("the count of changes on its tab", () => {
  const count = () => one(".workspace-tab .workspace-count");
  /** The status read again, as coming back to the tab reads it once the last read is too old to stand. */
  const reread = async () => {
    setSystemTime(new Date(Date.now() + WORKSPACE_CACHE_TTL_MS + 1));
    await act(async () => { showWorkspaceTab("changes"); });
    await settle();
  };

  test("is still when it is drawn, and when the same count is drawn again", async () => {
    await bootWorkspaceScreen(live(), { width: 390 });
    expect(count().textContent).toBe("2");
    expect(count().classList.contains("swap-in")).toBeFalse();
    await reread();
    expect(count().textContent).toBe("2");
    expect(count().classList.contains("swap-in")).toBeFalse();
  });

  test("marks the change when another count arrives", async () => {
    await bootWorkspaceScreen(live(), { width: 390 });
    changes = [...changes, { path: "src/new.ts", index: " ", worktree: "M" }];
    await reread();
    expect(count().textContent).toBe("3");
    expect(count().classList.contains("swap-in")).toBeTrue();
  });
});

describe("the style sheet moves one mark there", () => {
  test("by index over --dur-2, under the words, for every strip", () => {
    for (const strip of [".workspace-tabs", ".inspector-tabs", ".workspace-layer-switch"]) expect(thumb).toContain(`${strip}::before`);
    expect(thumb).toContain("transform: translateX(calc(var(--thumb-on, 0) * (100% + var(--thumb-gap))));");
    expect(thumb).toContain("transition: transform var(--dur-2) var(--ease);");
    expect(thumb).toContain("width: calc((100% - 2 * var(--thumb-pad) - (var(--thumb-count, 2) - 1) * var(--thumb-gap)) / var(--thumb-count, 2));");
    // Behind the segments, not over them.
    expect(thumb).toContain("isolation: isolate;");
    expect(thumb).toContain("z-index: -1;");
  });

  test("the chosen segment has no ground of its own left to jump, and its words ease with the mark", () => {
    const rule = (source: string, selector: string) => {
      const start = source.indexOf(`\n${selector} {`);
      if (start < 0) throw new Error(`missing rule ${selector}`);
      return source.slice(start, source.indexOf("}", start));
    };
    for (const [source, chosen, segment] of [
      [shell, ".workspace-tab.on", ".workspace-tab"],
      [inspector, ".inspector-tab.on", ".inspector-tab"],
      [detail, '.workspace-layer-switch button[aria-pressed="true"]', ".workspace-layer-switch button"],
    ] as const) {
      expect(rule(source, chosen)).not.toContain("background");
      expect(rule(source, segment)).toContain("transition: color var(--dur-2) var(--ease);");
    }
  });

  test("every strip's segments are equal shares, and each says its own inset and gap", () => {
    expect(shell).toMatch(/\.workspace-tabs \{[^}]*--thumb-pad: 3px;[^}]*--thumb-gap: 3px;[^}]*grid-auto-columns: minmax\(0, 1fr\);[^}]*gap: 3px;[^}]*padding: 3px;/);
    // Beside the detail the strip shrinks to its names, and the two stay equal.
    expect(shell).not.toContain("grid-auto-columns: auto");
    expect(inspector).toMatch(/\.inspector-tabs \{[^}]*--thumb-pad: 0px;[^}]*--thumb-gap: 2px;[^}]*grid-auto-columns: 1fr;[^}]*gap: 2px;/);
    expect(detail).toMatch(/\.workspace-layer-switch \{[^}]*--thumb-pad: 2px;[^}]*--thumb-gap: 2px;[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);[^}]*gap: 2px;[^}]*padding: 2px;/);
    // Under a finger the column's switch has no inset, and the mark follows.
    expect(inspector).toContain(".workspace-inspector .workspace-layer-switch { --thumb-pad: 0px; padding: 0; }");
    // The preview's widths are the strip's own count: three or four, whichever the stage offers.
    expect(preview).toContain(".workspace-layer-switch.workspace-preview-width { grid-template-columns: repeat(var(--thumb-count, 3), minmax(0, 1fr)); }");
  });
});
