import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { happy, resetTestDOM } from "../../../test-support/boot-dom";
import { ProtocolError } from "../../lib/protocol/errors";
import { setPhase } from "../connection/connection-store";
import { setScreen } from "../../app/navigation-store";
import { selectPane } from "../session/session-store";
import { attachLiveSession } from "../computers/catalog-store";
import { replaceAgentsFromSnapshot } from "../dashboard/catalog-store";
import { WorkspaceSnapshotRestorer } from "../../../test-support/workspace-snapshot-restore";
import { appHost, type AppHost } from "../../app/host";
import { commitTest, mountTestApp, unmountTestApp } from "../../../test-support/react-harness";
import {
  adoptWorkspaceIdentity,
  ensureBranches,
  enterWorkspace,
  getWorkspaceSnapshot,
  leaveWorkspace,
  loadDirectory,
  loadGitDiff,
  loadWorkspaceFile,
  showMoreWorkspaceChanges,
  subscribeWorkspace,
  workspaceModel,
} from "./index";
import { diffNoteScope } from "../../lib/diff-notes";

const seedRestorer = new WorkspaceSnapshotRestorer();
await resetTestDOM();
// The App-mounted stale case renders the guided pane before the workspace
// screen; its terminal layout effect schedules a frame. Capture the exact
// original globals and restore them in afterAll (they may be absent).
const staleGlobals = globalThis as unknown as Record<string, unknown>;
const origRaf = Object.getOwnPropertyDescriptor(staleGlobals, "requestAnimationFrame");
const origRafCancel = Object.getOwnPropertyDescriptor(staleGlobals, "cancelAnimationFrame");
Object.defineProperty(staleGlobals, "requestAnimationFrame", { configurable: true, writable: true, value: happy.requestAnimationFrame.bind(happy) });
Object.defineProperty(staleGlobals, "cancelAnimationFrame", { configurable: true, writable: true, value: happy.cancelAnimationFrame.bind(happy) });

afterAll(() => {
  if (origRaf) Object.defineProperty(staleGlobals, "requestAnimationFrame", origRaf);
  else delete staleGlobals.requestAnimationFrame;
  if (origRafCancel) Object.defineProperty(staleGlobals, "cancelAnimationFrame", origRafCancel);
  else delete staleGlobals.cancelAnimationFrame;
});

const revision = "a".repeat(64);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function liveFixture() {
  return {
    isConnected: () => true,
    workspaceOpen: async (pane: string) => ({
      name: pane, root: `/work/${pane}`,
      features: { files: true, git_status: true, git_diff: true, git_branches: false },
      git: null,
    }),
    workspaceList: async (_pane: string, path = "") => ({
      path, entries: [{ name: "app.ts", path: "app.ts", kind: "file" as const, size: 1, modified_ms: 1, hidden: false, revision }],
      next_cursor: null, truncated: false, revision,
    }),
    workspaceRead: async (_pane: string, path: string) => ({
      path, kind: "text" as const, size: 1, modified_ms: 1, content: `${path}-ok`, truncated: false, revision,
    }),
    gitStatus: async () => ({
      branch: "main", head: "h", upstream: null, ahead: 0, behind: 0, truncated: false, revision, changes: [],
    }),
    gitDiff: async (_pane: string, path: string, layer: "worktree" | "staged") => ({
      path, layer, patch: "@@ -1 +1 @@\n-a\n+b\n", additions: 1, deletions: 1, binary: false, truncated: false, revision,
    }),
    gitBranches: async () => ({
      items: [{ name: "main", kind: "local" as const, current: true, head: "h", upstream: null }],
      truncated: false, revision,
    }),
  };
}

/** Real App host commit/requestCommit refs, captured and restored around one case. */
let committed = 0;
let requested = 0;
let hostRef: AppHost | null = null;
let realCommit: AppHost["commit"] | null = null;
let realRequestCommit: AppHost["requestCommit"] | null = null;

function watchHostCommits(): void {
  hostRef = appHost();
  committed = 0;
  requested = 0;
  realCommit = hostRef!.commit;
  realRequestCommit = hostRef!.requestCommit;
  hostRef!.commit = (options) => {
    committed += 1;
    realCommit!(options);
  };
  hostRef!.requestCommit = () => {
    requested += 1;
    realRequestCommit!();
  };
}

function restoreHostCommits(): void {
  if (!hostRef) return;
  if (realCommit) hostRef.commit = realCommit;
  if (realRequestCommit) hostRef.requestCommit = realRequestCommit;
  hostRef = null;
  realCommit = null;
  realRequestCommit = null;
}

function prepare(live = liveFixture()) {
  seedRestorer.capture();
  setPhase("live");
  setScreen("pane");
  selectPane("p1");
  replaceAgentsFromSnapshot({
    focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "p1" },
    workspaces: [
      { workspace_id: "w1", label: "demo" },
      { workspace_id: "w2", label: "demo2" },
    ],
    tabs: [
      { tab_id: "w1:t1", workspace_id: "w1", label: "main" },
      { tab_id: "w2:t1", workspace_id: "w2", label: "main" },
    ],
    panes: [
      { pane_id: "p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/work/p1", agent: "codex", agent_status: "idle" },
      { pane_id: "p2", workspace_id: "w2", tab_id: "w2:t1", cwd: "/work/p2", agent: "codex", agent_status: "idle" },
    ],
  });
  attachLiveSession(live as never);
  return live;
}

afterEach(async () => {
  await act(async () => {
    leaveWorkspace();
    restoreHostCommits();
    attachLiveSession(null);
    setScreen("home");
    seedRestorer.restore();
  });
  unmountTestApp();
});

describe("workspace stale request ownership", () => {
  test("leaving a workspace retires in-flight directory pages", async () => {
    const live = prepare();
    const held = deferred<Awaited<ReturnType<typeof live.workspaceList>>>();
    live.workspaceList = () => held.promise;
    const opening = enterWorkspace("p1");
    await Promise.resolve();
    leaveWorkspace();
    held.resolve({
      path: "", entries: [{ name: "leaked", path: "leaked", kind: "file", size: 1, modified_ms: 1, hidden: false, revision }],
      next_cursor: null, truncated: false, revision,
    });
    await opening;
    expect(getWorkspaceSnapshot().entries.map(entry => entry.path)).not.toContain("leaked");
  });

  test("a dropped session cannot complete into a newer connection", async () => {
    const live = prepare();
    // The real App is mounted so the no-paint contract is observed through the
    // installed host's commit/requestCommit, not an empty renderer hook. Every
    // producing mounted-App action runs inside a real act boundary; the host
    // stays installed through the original assertions.
    await act(async () => {
      mountTestApp();
      commitTest();
    });
    watchHostCommits();
    const held = deferred<Awaited<ReturnType<typeof live.workspaceRead>>>();
    live.workspaceRead = () => held.promise;
    await act(async () => { await enterWorkspace("p1"); });
    let stale!: Promise<void>;
    act(() => { stale = loadWorkspaceFile("app.ts"); });
    const next = liveFixture();
    await act(async () => { attachLiveSession(next as never); });
    committed = 0;
    requested = 0;
    await act(async () => { await enterWorkspace("p2"); });
    committed = 0;
    requested = 0;
    await act(async () => {
      held.resolve({ path: "app.ts", kind: "text", size: 1, modified_ms: 1, content: "from-old-session", truncated: false, revision });
      await stale;
    });
    expect(workspaceModel.paneId).toBe("p2");
    expect(workspaceModel.file?.content).not.toBe("from-old-session");
    expect(committed).toBe(0);
    expect(requested).toBe(0);
  });

  test("identity adoption is what file actions observe, not a mutated snapshot object", async () => {
    const live = prepare();
    await enterWorkspace("p1");
    const before = getWorkspaceSnapshot();
    adoptWorkspaceIdentity({ paneId: "other" });
    expect(getWorkspaceSnapshot().paneId).toBe("other");
    expect(getWorkspaceSnapshot()).not.toBe(before);
    expect(Object.isFrozen(getWorkspaceSnapshot())).toBeTrue();
    expect(Object.isFrozen(getWorkspaceSnapshot().changeGroupsExpanded)).toBeTrue();
  });

  test("unchanged nested snapshot fields keep their identity", async () => {
    prepare();
    await enterWorkspace("p1");
    const first = getWorkspaceSnapshot();
    const entries = first.entries;
    const groups = first.changeGroupsExpanded;
    showMoreWorkspaceChanges();
    const second = getWorkspaceSnapshot();
    expect(second).not.toBe(first);
    expect(second.entries).toBe(entries);
    expect(second.changeGroupsExpanded).toBe(groups);
    showMoreWorkspaceChanges();
    expect(getWorkspaceSnapshot().changeGroupsExpanded).toBe(groups);
  });

  test("identity action changing only root retires an outstanding file request", async () => {
    const live = prepare();
    await enterWorkspace("p1");
    const gate = deferred<Awaited<ReturnType<typeof live.workspaceRead>>>();
    live.workspaceRead = async () => gate.promise;
    const pending = loadWorkspaceFile("held.ts");
    adoptWorkspaceIdentity({
      paneId: "p1",
      descriptor: { ...getWorkspaceSnapshot().descriptor!, root: "/new-root" },
    });
    gate.resolve({
      path: "held.ts", kind: "text", size: 1, modified_ms: 1, content: "OLD ROOT", truncated: false, revision,
    });
    await pending;
    expect(getWorkspaceSnapshot().descriptor?.root).toBe("/new-root");
    expect(getWorkspaceSnapshot().file?.content).not.toBe("OLD ROOT");
  });

  test("adopting a new root retires pending reads from the previous root", async () => {
    const live = prepare();
    await enterWorkspace("p1");
    const heldFile = deferred<Awaited<ReturnType<typeof live.workspaceRead>>>();
    const heldList = deferred<Awaited<ReturnType<typeof live.workspaceList>>>();
    const heldDiff = deferred<Awaited<ReturnType<typeof live.gitDiff>>>();
    live.workspaceRead = () => heldFile.promise;
    live.workspaceList = () => heldList.promise;
    live.gitDiff = () => heldDiff.promise;
    const staleFile = loadWorkspaceFile("held.ts");
    const staleDir = loadDirectory("src");
    const staleDiff = loadGitDiff("held.ts", "worktree");
    adoptWorkspaceIdentity({
      paneId: "p1",
      descriptor: {
        name: "p1",
        root: "/new-root",
        features: { files: true, git_status: true, git_diff: true, git_branches: false },
        git: null,
      },
    });
    heldFile.resolve({
      path: "held.ts", kind: "text", size: 1, modified_ms: 1, content: "OLD ROOT", truncated: false, revision,
    });
    heldList.resolve({
      path: "src",
      entries: [{ name: "leaked", path: "src/leaked", kind: "file", size: 1, modified_ms: 1, hidden: false, revision }],
      next_cursor: null, truncated: false, revision,
    });
    heldDiff.resolve({
      path: "held.ts", layer: "worktree", patch: "OLD ROOT", additions: 1, deletions: 0, binary: false, truncated: false, revision,
    });
    await Promise.all([staleFile, staleDir, staleDiff]);
    const now = getWorkspaceSnapshot();
    expect(now.descriptor?.root).toBe("/new-root");
    expect(now.file?.content).not.toBe("OLD ROOT");
    expect(now.entries.map((entry) => entry.path)).not.toContain("src/leaked");
    expect(now.diff?.patch).not.toBe("OLD ROOT");
  });

  test("open failure unbinds diff notes", async () => {
    const live = prepare();
    await enterWorkspace("p1");
    await loadGitDiff("app.ts", "worktree");
    expect(diffNoteScope()).not.toBeNull();
    live.workspaceOpen = async () => { throw new Error("open failed"); };
    await enterWorkspace("p1", "guided", true);
    expect(diffNoteScope()).toBeNull();
    expect(getWorkspaceSnapshot().error.length).toBeGreaterThan(0);
  });

  test("a subscriber entering another pane cannot restore the old diff note scope after notify", async () => {
    const live = prepare();
    await enterWorkspace("p1");
    let rejectOpen!: (error: Error) => void;
    const heldOpen = new Promise<never>((_, reject) => { rejectOpen = reject; });
    live.workspaceOpen = async (pane: string) => {
      if (pane === "p2") return heldOpen;
      return {
        name: pane, root: `/work/${pane}`,
        features: { files: true, git_status: true, git_diff: true, git_branches: false },
        git: null,
      };
    };
    let entered: Promise<void> | undefined;
    const stop = subscribeWorkspace(() => {
      if (!entered && getWorkspaceSnapshot().diff) entered = enterWorkspace("p2");
    });
    await loadGitDiff("a.ts", "worktree");
    expect(getWorkspaceSnapshot().paneId).toBe("p2");
    expect(diffNoteScope()).toBeNull();
    rejectOpen(new Error("p2 failed"));
    await entered;
    stop();
    expect(getWorkspaceSnapshot().paneId).toBe("p2");
    expect(diffNoteScope()).toBeNull();
  });

  test("a cached diff owner effect cannot survive a subscriber selecting a file", async () => {
    prepare();
    await enterWorkspace("p1");
    await loadGitDiff("cached.ts", "worktree");
    await loadWorkspaceFile("initial.ts");
    let nested: Promise<void> | undefined;
    let once = false;
    const stop = subscribeWorkspace(() => {
      if (!once && getWorkspaceSnapshot().diff?.path === "cached.ts") {
        once = true;
        nested = loadWorkspaceFile("new.ts");
      }
    });
    await loadGitDiff("cached.ts", "worktree");
    await nested;
    stop();
    expect(once).toBeTrue();
    expect(getWorkspaceSnapshot().view).toBe("file");
    expect(getWorkspaceSnapshot().file?.path).toBe("new.ts");
    expect(diffNoteScope()).toBeNull();
    expect(getWorkspaceSnapshot().loading).toBeFalse();
  });

  test("entering another workspace immediately retires the prior diff-note scope even when open fails", async () => {
    const live = prepare();
    await enterWorkspace("p1");
    await loadGitDiff("app.ts", "worktree");
    expect(diffNoteScope()?.paneId).toBe("p1");
    live.workspaceOpen = async () => { throw new ProtocolError("workspace_not_found", "missing"); };
    await enterWorkspace("p2");
    expect(diffNoteScope()).toBeNull();
  });

  test("identity retirement clears the file loading flag", async () => {
    const live = prepare();
    await enterWorkspace("p1");
    const gate = deferred<Awaited<ReturnType<typeof live.workspaceRead>>>();
    live.workspaceRead = async () => gate.promise;
    const pending = loadWorkspaceFile("held.ts");
    adoptWorkspaceIdentity({
      paneId: "p1",
      descriptor: { ...getWorkspaceSnapshot().descriptor!, root: "/new" },
    });
    expect(getWorkspaceSnapshot().loading).toBeFalse();
    gate.resolve({ path: "held.ts", kind: "text", size: 1, modified_ms: 1, content: "old", truncated: false, revision });
    await pending;
    expect(getWorkspaceSnapshot().loading).toBeFalse();
  });

  test("identity retirement clears the directory pagination loading flag", async () => {
    const live = prepare();
    live.workspaceList = async (_pane: string, path = "", cursor = "") => {
      if (!cursor) {
        return {
          path, entries: [{ name: "app.ts", path: "app.ts", kind: "file" as const, size: 1, modified_ms: 1, hidden: false, revision }],
          next_cursor: "more", truncated: false, revision,
        };
      }
      return gate.promise;
    };
    const gate = deferred<Awaited<ReturnType<typeof live.workspaceList>>>();
    await enterWorkspace("p1");
    const pending = loadDirectory("", true);
    adoptWorkspaceIdentity({
      paneId: "p1",
      descriptor: { ...getWorkspaceSnapshot().descriptor!, root: "/new" },
    });
    expect(getWorkspaceSnapshot().loadingMore).toBeFalse();
    expect(getWorkspaceSnapshot().revealNav).toBeFalse();
    gate.resolve({
      path: "", entries: [{ name: "more.ts", path: "more.ts", kind: "file", size: 1, modified_ms: 1, hidden: false, revision }],
      next_cursor: null, truncated: false, revision,
    });
    await pending;
    expect(getWorkspaceSnapshot().loadingMore).toBeFalse();
  });

  test("identity retirement clears the branches loading flag", async () => {
    const live = prepare();
    await enterWorkspace("p1");
    const gate = deferred<Awaited<ReturnType<typeof live.gitBranches>>>();
    live.gitBranches = async () => gate.promise;
    const pending = ensureBranches();
    adoptWorkspaceIdentity({
      paneId: "p1",
      descriptor: { ...getWorkspaceSnapshot().descriptor!, root: "/new" },
    });
    expect(getWorkspaceSnapshot().loadingBranches).toBeFalse();
    gate.resolve({ items: [], truncated: false, revision });
    await pending;
    expect(getWorkspaceSnapshot().loadingBranches).toBeFalse();
  });

  test("an older diff cannot replace a newer directory selection", async () => {
    const live = prepare();
    const held = deferred<Awaited<ReturnType<typeof live.gitDiff>>>();
    live.gitDiff = () => held.promise;
    await enterWorkspace("p1");
    const stale = loadGitDiff("app.ts", "worktree");
    await loadDirectory("other");
    held.resolve({
      path: "app.ts", layer: "worktree", patch: "stale", additions: 1, deletions: 0, binary: false, truncated: false, revision,
    });
    await stale;
    expect(workspaceModel.view).toBe("browser");
    expect(workspaceModel.directory).toBe("other");
    expect(workspaceModel.diff).toBeNull();
  });
});