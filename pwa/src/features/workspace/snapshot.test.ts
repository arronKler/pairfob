import { afterEach, describe, expect, test } from "bun:test";
import { resetTestDOM } from "../../../test-support/boot-dom";
import { WorkspaceSnapshotRestorer } from "../../../test-support/workspace-snapshot-restore";
import { setPhase } from "../connection/connection-store";
import { setScreen } from "../../app/navigation-store";
import { selectPane } from "../session/session-store";
import { attachLiveSession } from "../computers/catalog-store";
import { replaceAgentsFromSnapshot } from "../dashboard/catalog-store";
import {
  adoptWorkspaceIdentity,
  bumpWorkspaceNotes,
  ensureBranches,
  enterWorkspace,
  getWorkspaceSnapshot,
  leaveWorkspace,
  loadWorkspaceFile,
  showMoreWorkspaceChanges,
  subscribeWorkspace,
  workspaceModel,
} from "./index";
import * as workspaceApi from "./index";

const seedRestorer = new WorkspaceSnapshotRestorer();
await resetTestDOM();

const revision = "a".repeat(64);

function liveFixture() {
  return {
    isConnected: () => true,
    workspaceOpen: async (pane: string) => ({
      name: pane, root: `/work/${pane}`,
      features: { files: true, git_status: true, git_diff: true, git_branches: true },
      git: { name: pane, branch: "main", head: "h", detached: false },
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
    gitDiff: async () => ({
      path: "app.ts", layer: "worktree" as const, patch: "", additions: 0, deletions: 0, binary: false, truncated: false, revision,
    }),
    gitBranches: async () => ({
      items: [{ name: "main", kind: "local" as const, current: true, head: "h", upstream: null }],
      truncated: false, revision,
    }),
  };
}

function prepare() {
  seedRestorer.capture();
  setPhase("live");
  setScreen("pane");
  selectPane("p1");
  replaceAgentsFromSnapshot({
    focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "p1" },
    workspaces: [{ workspace_id: "w1", label: "demo" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
    panes: [{ pane_id: "p1", workspace_id: "w1", tab_id: "w1:t1", cwd: "/work/p1", agent: "codex", agent_status: "idle" }],
  });
  attachLiveSession(liveFixture() as never);
}

afterEach(() => {
  leaveWorkspace();
  attachLiveSession(null);
  setScreen("home");
  seedRestorer.restore();
});

describe("workspace snapshot identity", () => {
  test("public API is subscribe/getSnapshot plus typed actions, not request counters", () => {
    for (const name of [
      "peekRequestVersion", "peekContentVersion", "peekDirectoryVersion", "peekStatusVersion", "peekBranchesVersion",
      "bumpContentVersion", "bumpDirectoryVersion", "commitWorkspace", "isCurrentWorkspace", "issueTicket",
      "applyWorkspacePatch", "getWorkspaceSession", "setWorkspaceSession", "getWorkspaceScope", "setWorkspaceScope",
      "getDirectoryPageCount", "setDirectoryPageCount", "isWorkspacePendingReveal",
    ]) {
      expect(name in workspaceApi).toBeFalse();
    }
    expect("subscribeWorkspace" in workspaceApi).toBeTrue();
    expect("getWorkspaceSnapshot" in workspaceApi).toBeTrue();
    expect("enterWorkspace" in workspaceApi).toBeTrue();
    expect("setWorkspaceNavigationSeam" in workspaceApi).toBeTrue();
  });

  test("compatibility and input aliases cannot mutate a published snapshot", async () => {
    prepare();
    await enterWorkspace("p1");
    const snap = getWorkspaceSnapshot();
    let notices = 0;
    const stop = subscribeWorkspace(() => { notices++; });
    workspaceModel.entries[0]!.name = "mutated";
    workspaceModel.descriptor!.features.files = false;
    workspaceModel.descriptor!.git!.branch = "other";
    expect(getWorkspaceSnapshot()).toBe(snap);
    expect(snap.entries[0]?.name).toBe("app.ts");
    expect(snap.descriptor?.features.files).toBeTrue();
    expect(snap.descriptor?.git?.branch).toBe("main");
    expect(notices).toBe(0);

    const descriptor = {
      name: "seeded",
      root: "/seeded",
      features: { files: true, git_status: false, git_diff: false, git_branches: false },
      git: { name: "seeded", branch: "main", head: "h", detached: false },
    };
    adoptWorkspaceIdentity({ paneId: "p1", descriptor });
    const adopted = getWorkspaceSnapshot();
    descriptor.root = "/mutated";
    descriptor.features.files = false;
    descriptor.git.branch = "other";
    expect(getWorkspaceSnapshot()).toBe(adopted);
    expect(adopted.descriptor?.root).toBe("/seeded");
    expect(adopted.descriptor?.features.files).toBeTrue();
    expect(adopted.descriptor?.git?.branch).toBe("main");
    expect(Object.isFrozen(adopted.entries)).toBeTrue();
    expect(Object.isFrozen(adopted.descriptor)).toBeTrue();
    expect(Object.isFrozen(adopted.descriptor?.features)).toBeTrue();
    stop();
  });

  test("notes bumps and unrelated patches reuse nested snapshot identity", async () => {
    prepare();
    await enterWorkspace("p1");
    const first = getWorkspaceSnapshot();
    showMoreWorkspaceChanges();
    const limited = getWorkspaceSnapshot();
    expect(limited).not.toBe(first);
    expect(limited.entries).toBe(first.entries);
    expect(limited.descriptor).toBe(first.descriptor);
    expect(limited.changeGroupsExpanded).toBe(first.changeGroupsExpanded);
    bumpWorkspaceNotes();
    const noted = getWorkspaceSnapshot();
    expect(noted).not.toBe(limited);
    expect(noted.entries).toBe(limited.entries);
    expect(noted.descriptor).toBe(limited.descriptor);
    expect(noted.file).toBe(limited.file);
    expect(noted.status).toBe(limited.status);
  });

  test("identity input alias cannot alter later root-based navigation restoration", async () => {
    prepare();
    await enterWorkspace("p1");
    await loadWorkspaceFile("app.ts");
    const descriptor = structuredClone(getWorkspaceSnapshot().descriptor!);
    adoptWorkspaceIdentity({ paneId: "p1", descriptor });
    descriptor.root = "/external-poison";
    expect(getWorkspaceSnapshot().descriptor?.root).toBe("/work/p1");
    leaveWorkspace();
    await enterWorkspace("p1");
    expect(getWorkspaceSnapshot().descriptor?.root).toBe("/work/p1");
    expect(getWorkspaceSnapshot().view).toBe("file");
    expect(getWorkspaceSnapshot().detailPath).toBe("app.ts");
  });

  test("returned branches cannot poison the cached authority after leaving and reopening", async () => {
    const live = liveFixture();
    let reads = 0;
    live.gitBranches = async () => {
      reads++;
      return {
        items: [{ name: "main", kind: "local" as const, current: true, head: "h", upstream: null }],
        truncated: false, revision,
      };
    };
    prepare();
    attachLiveSession(live as never);
    await enterWorkspace("p1");
    const branches = await ensureBranches();
    try { branches!.items[0]!.name = "EXTERNAL POISON"; } catch { /* frozen or isolated */ }
    expect(getWorkspaceSnapshot().branches?.items[0]?.name).toBe("main");
    const firstReads = reads;
    leaveWorkspace();
    await enterWorkspace("p1");
    await ensureBranches();
    expect(reads).toBe(firstReads);
    expect(getWorkspaceSnapshot().branches?.items[0]?.name).toBe("main");
  });
});