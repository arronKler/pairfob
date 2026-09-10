import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "bun:test";
import { resetTestDOM } from "../../../test-support/boot-dom";
import { setPhase } from "../connection/connection-store";
import { setScreen } from "../../app/navigation-store";
import { selectPane } from "../session/session-store";
import { attachLiveSession } from "../computers/catalog-store";
import { replaceAgentsFromSnapshot } from "../dashboard/catalog-store";
import { WorkspaceSnapshotRestorer } from "../../../test-support/workspace-snapshot-restore";
import type { WorkspaceSnapshot } from "./model";
import { emptyMediaView } from "./media-model";
import { FileDetail } from "./file-detail";
import { FileList } from "./files";
import {
  enterWorkspace,
  getWorkspaceSnapshot,
  leaveWorkspace,
  loadWorkspaceFile,
  WORKSPACE_PENDING_DELAY_MS,
} from "./index";
import { setLang } from "../../lib/i18n";

await resetTestDOM();

const seedRestorer = new WorkspaceSnapshotRestorer();
const revision = "a".repeat(64);

function fileSnapshot(revealFile: boolean): WorkspaceSnapshot {
  return {
    paneId: "p1",
    returnView: "guided",
    descriptor: null,
    tab: "files",
    view: "file",
    directory: "",
    detailPath: "a.ts",
    diffLayer: "worktree",
    entries: [],
    nextCursor: null,
    directoryTruncated: false,
    file: { path: "a.ts", kind: "text", size: 1, modified_ms: 1, content: "x\n", truncated: false, revision },
    diff: null,
    media: emptyMediaView(),
    status: null,
    changeLimit: 200,
    changeGroupsExpanded: { staged: true, worktree: true },
    branches: null,
    loading: false,
    loadingMore: false,
    loadingBranches: false,
    error: "",
    pendingReveal: false,
    notesEpoch: 0,
    revealNav: false,
    revealFile,
    revealDiff: false,
  };
}

function listSnapshot(revealNav: boolean): WorkspaceSnapshot {
  return {
    ...fileSnapshot(false),
    view: "browser",
    detailPath: "",
    file: null,
    entries: [{ name: "a.ts", path: "a.ts", kind: "file", size: 1, modified_ms: 1, hidden: false, revision }],
    revealNav,
  };
}

function liveFixture() {
  return {
    isConnected: () => true,
    workspaceOpen: async (pane: string) => ({
      name: pane, root: `/work/${pane}`,
      features: { files: true, git_status: false, git_diff: false, git_branches: false },
      git: null,
    }),
    workspaceList: async (_pane: string, path = "") => ({
      path, entries: [{ name: "app.ts", path: "app.ts", kind: "file" as const, size: 1, modified_ms: 1, hidden: false, revision }],
      next_cursor: null, truncated: false, revision,
    }),
    workspaceRead: async (_pane: string, path: string) => ({
      path, kind: "text" as const, size: 1, modified_ms: 1, content: `${path}-ok`, truncated: false, revision,
    }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("workspace reveal is a snapshot, not a render-time consume", () => {
  let host: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(() => {
    if (root) act(() => root.unmount());
    host?.remove();
    host = undefined;
    root = undefined;
    leaveWorkspace();
    attachLiveSession(null);
    setScreen("home");
    seedRestorer.restore();
  });

  function mountHost() {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }

  test("StrictMode and repeated renders keep the ready reveal class", () => {
    mountHost();
    const snap = fileSnapshot(true);
    act(() => { root!.render(<FileDetail snapshot={snap} />); });
    expect(host!.querySelector(".workspace-code.workspace-reveal")).toBeTruthy();
    act(() => { root!.render(null); });
    act(() => { root!.render(<StrictMode><FileDetail snapshot={snap} /></StrictMode>); });
    expect(host!.querySelector(".workspace-code.workspace-reveal")).toBeTruthy();
    act(() => { root!.render(<StrictMode><FileDetail snapshot={snap} /></StrictMode>); });
    expect(host!.querySelector(".workspace-code.workspace-reveal")).toBeTruthy();
    act(() => { root!.render(<FileList snapshot={listSnapshot(true)} />); });
    expect(host!.querySelector(".workspace-panel.workspace-reveal")).toBeTruthy();
    act(() => { root!.render(<FileList snapshot={listSnapshot(true)} />); });
    expect(host!.querySelector(".workspace-panel.workspace-reveal")).toBeTruthy();
  });

  test("a new workspace owner does not inherit the previous reveal flags", async () => {
    setLang("zh");
    seedRestorer.capture();
    setPhase("live");
    setScreen("pane");
    selectPane("p1");
    replaceAgentsFromSnapshot({
      focused: { workspace_id: "w1", tab_id: "w1:t1", pane_id: "p1" },
      workspaces: [
        { workspace_id: "w1", label: "p1" },
        { workspace_id: "w2", label: "p2" },
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
    const live = liveFixture();
    const held = deferred<Awaited<ReturnType<typeof live.workspaceRead>>>();
    live.workspaceRead = () => held.promise;
    attachLiveSession(live as never);
    await enterWorkspace("p1");
    const loading = loadWorkspaceFile("app.ts");
    await act(async () => { await new Promise<void>((done) => window.setTimeout(done, WORKSPACE_PENDING_DELAY_MS + 20)); });
    expect(getWorkspaceSnapshot().pendingReveal).toBeTrue();
    held.resolve({ path: "app.ts", kind: "text", size: 1, modified_ms: 1, content: "ready\n", truncated: false, revision });
    await act(async () => { await loading; });
    expect(getWorkspaceSnapshot().revealFile).toBeTrue();
    await enterWorkspace("p2");
    expect(getWorkspaceSnapshot().paneId).toBe("p2");
    expect(getWorkspaceSnapshot().revealFile).toBeFalse();
    expect(getWorkspaceSnapshot().file?.content).not.toBe("ready\n");
  });
});