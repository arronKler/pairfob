import { describe, expect, test } from "bun:test";
import { gitChangeKind, gitLayers, parseDiffLines, parseGitStatus, parseWorkspaceDescriptor, workspaceBreadcrumbs } from "./workspace";

const revision = "a".repeat(64);

describe("workspace protocol boundary", () => {
  test("parses an exact workspace descriptor", () => {
    expect(parseWorkspaceDescriptor({
      name: "pairfob",
      root: "/work/pairfob",
      features: { files: true, git_status: true, git_diff: true, git_branches: true },
      git: { name: "pairfob", branch: "main", head: "abc", detached: false },
    }).git?.branch).toBe("main");
  });

  test("rejects extra fields and traversal paths", () => {
    expect(() => parseWorkspaceDescriptor({
      name: "pairfob",
      root: "/work/pairfob",
      features: { files: true, git_status: true, git_diff: true, git_branches: true, write: true },
      git: null,
    })).toThrow();
    expect(() => parseGitStatus({
      branch: "main", head: "abc", upstream: null, ahead: 0, behind: 0, truncated: false, revision,
      changes: [{ path: "../secret", original_path: null, index: "?", worktree: "?" }],
    })).toThrow();
    expect(() => parseGitStatus({
      branch: "main", head: "abc", upstream: null, ahead: 0, behind: 0, truncated: false, revision,
      changes: [{ path: "line\nbreak.ts", original_path: null, index: "?", worktree: "?" }],
    })).toThrow();
  });
});

describe("workspace view helpers", () => {
  test("maps staged and worktree layers independently", () => {
    expect(gitLayers({ path: "a", original_path: null, index: "M", worktree: "M" })).toEqual(["staged", "worktree"]);
    expect(gitLayers({ path: "new", original_path: null, index: "?", worktree: "?" })).toEqual(["worktree"]);
  });

  test("maps source-control decorations by layer", () => {
    expect(gitChangeKind({ path: "both", original_path: null, index: "A", worktree: "M" }, "staged")).toBe("added");
    expect(gitChangeKind({ path: "both", original_path: null, index: "A", worktree: "M" }, "worktree")).toBe("modified");
    expect(gitChangeKind({ path: "new", original_path: null, index: "?", worktree: "?" }, "worktree")).toBe("untracked");
    expect(gitChangeKind({ path: "gone", original_path: null, index: "D", worktree: " " }, "staged")).toBe("deleted");
  });

  test("tracks both line number columns in unified diff", () => {
    expect(parseDiffLines("@@ -4,2 +4,2 @@\n-old\n+new\n same")).toEqual([
      { kind: "hunk", text: "@@ -4,2 +4,2 @@", oldLine: null, newLine: null },
      { kind: "delete", text: "old", oldLine: 4, newLine: null },
      { kind: "add", text: "new", oldLine: null, newLine: 4 },
      { kind: "context", text: "same", oldLine: 5, newLine: 5 },
    ]);
  });

  test("builds stable breadcrumb targets", () => {
    expect(workspaceBreadcrumbs("src/ui/session")).toEqual([
      { label: "root", path: "" },
      { label: "src", path: "src" },
      { label: "ui", path: "src/ui" },
      { label: "session", path: "src/ui/session" },
    ]);
  });
});
