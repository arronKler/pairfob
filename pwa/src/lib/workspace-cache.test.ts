import { describe, expect, test } from "bun:test";
import { WORKSPACE_CACHE_ENTRY_LIMIT, WORKSPACE_CACHE_ROOT_LIMIT, WORKSPACE_CACHE_TTL_MS, WorkspaceReadCache } from "./workspace-cache";
import type { GitDiff, WorkspaceFile } from "./workspace";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const cwd = new Map([["p1", "/repo"], ["p2", "/repo"]]);
  const calls = { open: 0, list: 0, file: 0, status: 0, diff: 0, branches: 0 };
  const file = (path = "a.ts"): WorkspaceFile => ({ path, kind: "text", size: 1, modified_ms: 1, content: "a", truncated: false, revision: "file1" });
  const diff = (path = "a.ts", layer: "worktree" | "staged" = "worktree"): GitDiff => ({ path, layer, patch: "patch1", additions: 1, deletions: 0, binary: false, truncated: false, revision: "diff1" });
  const session = {
    workspaceOpen: async (pane: string) => {
      calls.open++;
      return { root: cwd.get(pane) || "/repo", name: "repo", features: { files: true, git_status: true, git_diff: true, git_branches: true }, git: null };
    },
    workspaceList: async (_pane: string, path: string, cursor = "") => {
      calls.list++;
      return { path, entries: [], next_cursor: cursor ? null : "120", truncated: false, revision: "list1" };
    },
    workspaceRead: async (_pane: string, path: string) => { calls.file++; return file(path); },
    gitDiff: async (_pane: string, path: string, layer: "worktree" | "staged") => { calls.diff++; return diff(path, layer); },
    gitStatus: async () => {
      calls.status++;
      return { branch: "main", head: "head1", upstream: null, ahead: 0, behind: 0, changes: [], truncated: false, revision: "status1" };
    },
    gitBranches: async () => { calls.branches++; return { items: [], truncated: false, revision: "branches1" }; },
  };
  let time = 100;
  const cache = new WorkspaceReadCache(session, (pane) => cwd.get(pane), () => time);
  return { session, cache, calls, cwd, file, diff, advance: (ms = WORKSPACE_CACHE_TTL_MS) => { time += ms; } };
}

describe("shared workspace reads", () => {
  test("two verified panes share every read, while paths, pages and diff layers stay distinct", async () => {
    const f = fixture();
    const a = await f.cache.open("p1");
    const b = await f.cache.open("p2");
    for (const scope of [a, b]) {
      await Promise.all([scope.directory("").value, scope.file("a.ts").value, scope.diff("a.ts", "worktree").value, scope.status().value, scope.branches().value]);
    }
    expect(f.calls).toEqual({ open: 2, list: 1, file: 1, status: 1, diff: 1, branches: 1 });
    await Promise.all([b.directory("", "120").value, b.directory("src").value, b.file("b.ts").value, b.diff("a.ts", "staged").value]);
    expect(f.calls).toEqual({ open: 2, list: 3, file: 2, status: 1, diff: 2, branches: 1 });
  });

  test("shares a pending request and revalidates stale content even with unchanged status and HEAD", async () => {
    const f = fixture();
    const a = await f.cache.open("p1");
    const b = await f.cache.open("p2");
    await a.diff("a.ts", "worktree").value;
    f.advance();
    const pending = deferred<GitDiff>();
    f.session.gitDiff = async () => { f.calls.diff++; return pending.promise; };
    const one = a.diff("a.ts", "worktree");
    const two = b.diff("a.ts", "worktree");
    expect(one.cached?.patch).toBe("patch1");
    expect(two.cached?.patch).toBe("patch1");
    await Promise.resolve();
    expect(f.calls.diff).toBe(2);
    pending.resolve({ ...f.diff(), patch: "patch2", revision: "diff2" });
    expect((await one.value).patch).toBe("patch2");
    expect((await two.value).patch).toBe("patch2");
    expect(b.diff("a.ts", "worktree").cached?.patch).toBe("patch2");
  });

  test("keeps different roots and connections separate", async () => {
    const f = fixture();
    f.cwd.set("p2", "/repo-worktree");
    await (await f.cache.open("p1")).file("a.ts").value;
    await (await f.cache.open("p2")).file("a.ts").value;
    const other = new WorkspaceReadCache(f.session, () => "/repo");
    await (await other.open("p1")).file("a.ts").value;
    expect(f.calls.file).toBe(3);
  });

  test("rechecking an expired pane binding preserves a pending read when its root is unchanged", async () => {
    const f = fixture();
    const first = await f.cache.open("p1");
    const pending = deferred<WorkspaceFile>();
    f.session.workspaceRead = async () => { f.calls.file++; return pending.promise; };
    const oldRead = first.file("a.ts").value;
    await Promise.resolve();
    f.advance();
    const reopened = await f.cache.open("p1");
    const joined = reopened.file("a.ts").value;
    pending.resolve(f.file());
    expect((await oldRead).content).toBe("a");
    expect((await joined).content).toBe("a");
    expect(f.calls).toMatchObject({ open: 2, file: 1 });
  });

  test("a changed verified root revokes the former scope even when the cwd hint is unchanged", async () => {
    const f = fixture();
    const first = await f.cache.open("p1");
    const descriptor = await f.session.workspaceOpen("p1");
    f.advance();
    f.session.workspaceOpen = async () => ({ ...descriptor, root: "/new-target" });
    const reopened = await f.cache.open("p1");
    expect(reopened.descriptor.root).toBe("/new-target");
    await expect(first.file("a.ts").value).rejects.toMatchObject({ code: "workspace_not_found" });
    expect(reopened.file("a.ts").cached).toBeUndefined();
    await reopened.file("a.ts").value;
  });

  test("a changed cwd cannot publish a late response into the former root", async () => {
    const f = fixture();
    const old = await f.cache.open("p1");
    const pending = deferred<WorkspaceFile>();
    f.session.workspaceRead = async () => pending.promise;
    const read = old.file("a.ts").value;
    const rejected = read.catch((error) => error);
    await Promise.resolve();
    f.cwd.set("p1", "/other");
    const moved = await f.cache.open("p1");
    expect(moved.descriptor.root).toBe("/other");
    pending.resolve({ ...f.file(), content: "other directory" });
    expect(await rejected).toMatchObject({ code: "workspace_not_found" });
    f.session.workspaceRead = async () => { f.calls.file++; return f.file(); };
    const sibling = await f.cache.open("p2");
    expect(sibling.file("a.ts").cached).toBeUndefined();
    expect((await sibling.file("a.ts").value).content).toBe("a");
  });

  test("manual refresh drops shared data and prevents an older flight from overwriting it", async () => {
    const f = fixture();
    const a = await f.cache.open("p1");
    const b = await f.cache.open("p2");
    const pending = deferred<WorkspaceFile>();
    f.session.workspaceRead = async () => pending.promise;
    const old = a.file("a.ts").value;
    const rejected = old.catch((error) => error);
    await Promise.resolve();
    const refreshed = await f.cache.open("p1", true);
    f.session.workspaceRead = async () => ({ ...f.file(), content: "new" });
    await refreshed.file("a.ts").value;
    pending.resolve({ ...f.file(), content: "old" });
    expect(await rejected).toMatchObject({ code: "workspace_not_found" });
    expect(b.file("a.ts").cached?.content).toBe("new");
    expect(f.calls.open).toBe(3);
  });

  test("a rejected request can be retried, without caching an error as data", async () => {
    const f = fixture();
    const scope = await f.cache.open("p1");
    f.session.workspaceRead = async () => { throw new Error("offline"); };
    await expect(scope.file("a.ts").value).rejects.toThrow("offline");
    f.session.workspaceRead = async () => f.file();
    expect(scope.file("a.ts").cached).toBeUndefined();
    expect((await scope.file("a.ts").value).content).toBe("a");
  });

  test("known Git status changes invalidate even recently cached files", async () => {
    const f = fixture();
    const scope = await f.cache.open("p1");
    await scope.status().value;
    f.advance(WORKSPACE_CACHE_TTL_MS - 1);
    await scope.file("a.ts").value;
    f.advance(1);
    const previous = f.session.gitStatus;
    f.session.gitStatus = async () => ({ ...await previous(), revision: "status2" });
    await scope.status().value;
    expect(scope.file("a.ts").cached).toBeUndefined();
    await scope.file("a.ts").value;
    expect(f.calls.file).toBe(2);
  });

  test("bounds retained roots, entries, and file bytes", async () => {
    const f = fixture();
    const scope = await f.cache.open("p1");
    for (let index = 0; index <= WORKSPACE_CACHE_ENTRY_LIMIT; index++) await scope.file(`${index}.ts`).value;
    expect(scope.file("0.ts").cached).toBeUndefined();
    await scope.file("0.ts").value;
    for (let index = 0; index < WORKSPACE_CACHE_ROOT_LIMIT; index++) {
      const pane = `other${index}`;
      f.cwd.set(pane, `/root${index}`);
      await (await f.cache.open(pane)).file("a.ts").value;
    }
    expect(scope.file("0.ts").cached).toBeUndefined();
    await scope.file("0.ts").value;
    f.cache.invalidate("/repo");
    f.session.workspaceRead = async (_pane, path) => ({ ...f.file(path), content: "a".repeat(128 * 1024) });
    for (let index = 0; index < 9; index++) await scope.file(`${index}.ts`).value;
    expect(scope.file("0.ts").cached).toBeUndefined();
    await scope.file("0.ts").value;
  });
});
