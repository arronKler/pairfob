import { act } from "react";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { expectDifferentNode, expectSameNode } from "../../../test-support/node-identity";
import { renderReact, unmountReact } from "../../../test-support/react-harness";
import { all, bootWorkspaceScreen, one, press, settle, teardownWorkspaceScreen, type } from "../../../test-support/workspace-harness";
import { clearAllDiffNotes, diffNoteScope } from "../../lib/diff-notes";
import { WORKSPACE_CACHE_TTL_MS } from "../../lib/workspace-cache";
import { useDiffHold, type DiffHold } from "./diff-hold";
import { clearWorkspacePendingReveal, getWorkspaceSnapshot, loadGitDiff } from "./index";
import { emptyWorkspaceModel, type WorkspaceSnapshot } from "./model";
import { clearOpenNotes } from "./note-drafts";

/**
 * From one diff to the next the body keeps the one it was showing, dimmed and
 * out of reach, until the next is read or the wait is long enough for the
 * skeleton; what arrives in place of something else fades in. Neither happens
 * for a first paint, a poll, or the same file read again.
 */

/** What stands under a line to be read and pressed. A piece folding shut on its way out is still on the page, and is not that. */
const UNDER = ".diff-note-fold:not(.is-shut)";

describe("what the body keeps and what it reveals", () => {
  const diffOf = (path: string, revision = "a") => ({
    path, layer: "worktree" as const, patch: "@@ -1 +1 @@\n-old\n+new\n", additions: 1, deletions: 1, binary: false, truncated: false,
    revision: revision.repeat(64),
  });
  const snap = (over: Partial<WorkspaceSnapshot>): WorkspaceSnapshot => ({
    ...emptyWorkspaceModel(), pendingReveal: false, notesEpoch: 0, paneId: "p1", view: "diff", ...over,
  });
  const showing = (path: string, revision?: string) => snap({ detailPath: path, diff: diffOf(path, revision) });
  const reading = (path: string, over: Partial<WorkspaceSnapshot> = {}) => snap({ detailPath: path, diff: null, loading: true, ...over });

  let answer: DiffHold;
  function Probe({ snapshot }: { snapshot: WorkspaceSnapshot }) {
    answer = useDiffHold(snapshot, snapshot.diff ? `${snapshot.diff.path}:${snapshot.diffLayer}` : "");
    return null;
  }
  const draw = (snapshot: WorkspaceSnapshot): DiffHold => {
    renderReact(<Probe snapshot={snapshot} />);
    return answer;
  };

  beforeEach(async () => { await resetBoardTestDOM(); });
  afterEach(() => unmountReact());

  test("a body first drawn with its diff, and that diff drawn again, stand as they are", () => {
    expect(draw(showing("a.ts"))).toEqual({ stale: false, reveal: false });
    expect(draw(showing("a.ts"))).toEqual({ stale: false, reveal: false });
  });

  test("the next diff on its way: the one that was shown is kept, and the one that arrives is revealed", () => {
    draw(showing("a.ts"));
    expect(draw(reading("b.ts"))).toEqual({ stale: true, reveal: false });
    expect(draw(showing("b.ts"))).toEqual({ stale: false, reveal: true });
    // The same diff drawn again is still the one that arrived: the mark neither goes nor starts over.
    expect(draw(showing("b.ts"))).toEqual({ stale: false, reveal: true });
  });

  test("the same file read again at another revision is a repaint, not an arrival", () => {
    draw(showing("a.ts"));
    draw(reading("b.ts"));
    draw(showing("b.ts"));
    expect(draw(showing("b.ts", "c"))).toEqual({ stale: false, reveal: false });
  });

  test("a wait long enough for the skeleton gives the old diff up, and what arrives after it is revealed", () => {
    draw(showing("a.ts"));
    expect(draw(reading("b.ts"))).toEqual({ stale: true, reveal: false });
    expect(draw(reading("b.ts", { pendingReveal: true }))).toEqual({ stale: false, reveal: false });
    // Nothing is kept from here on, though the read is still out.
    expect(draw(reading("b.ts"))).toEqual({ stale: false, reveal: false });
    expect(draw(showing("b.ts"))).toEqual({ stale: false, reveal: true });
  });

  test("a body that waited empty reveals the diff it waited for", () => {
    expect(draw(reading("a.ts"))).toEqual({ stale: false, reveal: false });
    expect(draw(showing("a.ts"))).toEqual({ stale: false, reveal: true });
  });

  test("nothing is kept over an error, for another pane or repository, or once the read is over", () => {
    draw(showing("a.ts"));
    expect(draw(reading("b.ts", { error: "offline" }))).toEqual({ stale: false, reveal: false });
    draw(showing("a.ts"));
    expect(draw(reading("b.ts", { paneId: "p2" }))).toEqual({ stale: false, reveal: false });
    draw(showing("a.ts"));
    expect(draw(reading("b.ts", { loading: false }))).toEqual({ stale: false, reveal: false });
  });
});

describe("stepping through the changes on the screen", () => {
  /** Reads of these paths wait until the test lets them go. */
  let slow: Set<string>;
  let release: Map<string, () => void>;
  let revision: string;

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
      changes: ["src/app.ts", "src/b.ts"].map((path) => ({ path, original_path: null, index: " ", worktree: "M" })),
    }),
    gitDiff: async (_pane: string, path: string, layer: "worktree" | "staged") => {
      if (slow.has(path)) await new Promise<void>((resolve) => { release.set(path, resolve); });
      return {
        path, layer, patch: `@@ -1 +1,2 @@\n-old ${path}\n+new ${path}\n+more\n@@ -20 +21 @@\n-was\n+is\n`, additions: 3, deletions: 2, binary: false, truncated: false, revision,
      };
    },
  });

  const body = () => one(".workspace-diff-body");
  const lines = () => one(".workspace-diff");
  const next = () => all<HTMLButtonElement>(".workspace-step")[1];
  const open = async (path: string) => {
    await act(async () => { await loadGitDiff(path, "worktree"); });
    await settle();
  };
  /** A press whose first paint is what is asked about: drawn before this returns, so the wait for the skeleton cannot run out. */
  const tap = (target: HTMLElement): void => { act(() => { target.click(); }); };
  /** Wait, inside act, until the page shows it: a loaded machine can delay the pending timer past any fixed sleep. */
  const showingUp = async (selector: string): Promise<void> => {
    const deadline = Date.now() + 5000;
    while (!document.querySelector(selector)) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${selector}`);
      await act(async () => { await new Promise<void>((done) => window.setTimeout(done, 10)); });
    }
  };
  const arrive = async (path: string) => {
    await act(async () => {
      // The read is asked for a turn after the press that wanted it.
      for (let turn = 0; turn < 50 && !release.has(path); turn++) await new Promise<void>((done) => window.setTimeout(done, 0));
      release.get(path)!();
    });
    await settle();
  };

  beforeEach(async () => {
    await resetBoardTestDOM();
    clearWorkspacePendingReveal();
    clearAllDiffNotes();
    clearOpenNotes();
    slow = new Set();
    release = new Map();
    revision = "1".repeat(64);
  });
  afterEach(async () => {
    setSystemTime();
    await teardownWorkspaceScreen();
    clearAllDiffNotes();
    clearOpenNotes();
  });

  test("the open diff stays where it is, dimmed and out of reach, with its notes, until the next one is read", async () => {
    await bootWorkspaceScreen(live(), { width: 390, capabilities: { prompt_agent: true } });
    await open("src/app.ts");
    await press(one(".diff-add .diff-comment-btn"));
    await type(one<HTMLTextAreaElement>(`${UNDER} form.diff-note-inline textarea`), "why new");
    await press(one(`${UNDER} .diff-note-inline-save`));
    const was = lines();
    const bar = one(".workspace-notes-bar");
    expect(body().classList.contains("is-stale")).toBeFalse();
    expect(body().hasAttribute("inert")).toBeFalse();
    expect(one(".workspace-tools").hasAttribute("inert")).toBeFalse();

    slow.add("src/b.ts");
    tap(next());
    // This test is about the hold before the skeleton: the read stays out for as
    // long as the test needs, without the wait for the skeleton running out first.
    clearWorkspacePendingReveal();
    // The store has let the diff and its notes go; the picture has not.
    expect(getWorkspaceSnapshot().diff).toBeNull();
    expect(diffNoteScope()).toBeNull();
    expect(body().classList.contains("is-stale")).toBeTrue();
    expect(body().hasAttribute("inert")).toBeTrue();
    expect(lines() === was).toBeTrue();
    expect(was.dataset.diffKey).toBe("src/app.ts:worktree");
    expect(was.querySelector(`${UNDER} .workspace-diff-note .diff-note-body`)?.textContent).toBe("why new");
    expect(document.querySelector(".workspace-diff-spacer, .workspace-diff-pending")).toBeNull();
    // What belongs to those lines waits with them, out of reach: the tools over them and the notes' bar under them.
    expect(one(".workspace-tools").hasAttribute("inert")).toBeTrue();
    expect(one(".workspace-tools .workspace-hunk-nav").isConnected).toBeTrue();
    expect(one(".workspace-diff-footer").hasAttribute("inert")).toBeTrue();
    expect(one(".workspace-notes-bar") === bar).toBeTrue();
    expect(bar.querySelector(".workspace-notes-count")?.textContent).toBe("1 条批注待发送");
    // The header is already the next file's: its name and its place mark the change.
    expect(one(".workspace-detail-title .workspace-name").textContent).toBe("b.ts");
    expect(one(".workspace-detail-title .workspace-name").classList.contains("swap-in")).toBeTrue();
    expect(one(".workspace-step-where").textContent).toBe("2 / 2");
    expect(one(".workspace-step-where").getAttribute("aria-live")).toBe("polite");
    expect(one(".workspace-step-where > span").classList.contains("swap-in")).toBeTrue();

    await arrive("src/b.ts");
    expect(body().classList.contains("is-stale")).toBeFalse();
    expect(body().hasAttribute("inert")).toBeFalse();
    expect(lines() === was).toBeFalse();
    expect(was.isConnected).toBeFalse();
    expect(lines().dataset.diffKey).toBe("src/b.ts:worktree");
    expect(lines().classList.contains("workspace-reveal")).toBeTrue();
    expect(lines().textContent).toContain("new src/b.ts");
    expect(one(".workspace-tools").hasAttribute("inert")).toBeFalse();
    expect(one(".workspace-diff-footer").hasAttribute("inert")).toBeFalse();
    // One bar from file to file: it says what waits elsewhere now, and its entrance has nothing to start over on.
    expect(one(".workspace-notes-bar") === bar).toBeTrue();
    expect(bar.className).toBe("workspace-notes-bar is-elsewhere");
  });

  test("the keyboard does not stay on a line of the diff that is being replaced", async () => {
    await bootWorkspaceScreen(live(), { width: 390, capabilities: { prompt_agent: true } });
    await open("src/app.ts");
    const number = one<HTMLButtonElement>(".diff-add .diff-comment-btn");
    await act(async () => { number.focus(); });
    expectSameNode(document.activeElement, number);
    slow.add("src/b.ts");
    tap(next());
    expect(body().classList.contains("is-stale")).toBeTrue();
    // Still on the page, as part of the picture, and no longer where the keys go.
    expect(number.isConnected).toBeTrue();
    expectDifferentNode(document.activeElement, number);
    await arrive("src/b.ts");
  });

  test("a read that outlasts the wait gives the old diff up to the skeleton", async () => {
    await bootWorkspaceScreen(live(), { width: 390 });
    await open("src/app.ts");
    const was = lines();
    slow.add("src/b.ts");
    tap(next());
    expect(lines() === was).toBeTrue();
    await showingUp(".workspace-diff-pending");
    expect(was.isConnected).toBeFalse();
    expect(body().classList.contains("is-stale")).toBeFalse();
    expect(body().hasAttribute("inert")).toBeFalse();
    expect(one(".workspace-diff-pending").getAttribute("aria-busy")).toBe("true");
    await arrive("src/b.ts");
    expect(lines().classList.contains("workspace-reveal")).toBeTrue();
  });

  test("the open diff read again, same or changed, is drawn without a fade", async () => {
    await bootWorkspaceScreen(live(), { width: 390 });
    await open("src/app.ts");
    slow.add("src/b.ts");
    tap(next());
    await arrive("src/b.ts");
    slow.clear();
    const arrived = lines();
    expect(arrived.classList.contains("workspace-reveal")).toBeTrue();
    // The same patch again: the same lines, and nothing that would start their fade over.
    await open("src/b.ts");
    expect(lines() === arrived).toBeTrue();
    expect(body().classList.contains("is-stale")).toBeFalse();
    // Another revision of it, read once the last read is too old to stand: new lines, drawn as they are.
    revision = "2".repeat(64);
    setSystemTime(new Date(Date.now() + WORKSPACE_CACHE_TTL_MS + 1));
    await open("src/b.ts");
    expect(lines() === arrived).toBeFalse();
    expect(lines().classList.contains("workspace-reveal")).toBeFalse();
    expect(body().classList.contains("is-stale")).toBeFalse();
  });
});

describe("the style sheet", () => {
  test("dims what is kept over --dur-1 and lays the body's box out as its parts", async () => {
    const css = await Bun.file(new URL("./workspace-detail.scss", import.meta.url)).text();
    expect(css).toContain(".workspace-diff-body { display: contents; }");
    expect(css).toContain(".workspace-diff-body > * { transition: opacity var(--dur-1) var(--ease); }");
    expect(css).toContain(".workspace-diff-body.is-stale > * { opacity: 0.45; }");
  });
});
