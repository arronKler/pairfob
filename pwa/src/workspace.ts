import { adoptDiffNoteScope } from "./lib/diff-notes";
import type {
  GitBranches,
  GitDiff,
  GitLayer,
  GitStatus,
  WorkspaceDescriptor,
  WorkspaceDirectoryPage,
  WorkspaceEntry,
  WorkspaceFile,
} from "./lib/workspace";
import { WorkspaceReadCache, type WorkspaceScope } from "./lib/workspace-cache";
import { render } from "./paint";
import { clearNotice, messageOf, state } from "./state";
import { ProtocolError } from "./lib/protocol/errors";
import { t } from "./lib/i18n";

export type WorkspaceTab = "files" | "changes";
export type WorkspaceView = "browser" | "file" | "diff";
export type WorkspaceReturnView = "guided" | "full" | "agent";

export type WorkspaceModel = {
  paneId: string;
  returnView: WorkspaceReturnView;
  descriptor: WorkspaceDescriptor | null;
  tab: WorkspaceTab;
  view: WorkspaceView;
  directory: string;
  detailPath: string;
  diffLayer: GitLayer;
  entries: WorkspaceEntry[];
  nextCursor: string | null;
  directoryTruncated: boolean;
  file: WorkspaceFile | null;
  diff: GitDiff | null;
  status: GitStatus | null;
  changeLimit: number;
  changeGroupsExpanded: Record<GitLayer, boolean>;
  branches: GitBranches | null;
  loading: boolean;
  loadingMore: boolean;
  loadingBranches: boolean;
  error: string;
};

export const workspaceModel: WorkspaceModel = {
  paneId: "",
  returnView: "guided",
  descriptor: null,
  tab: "files",
  view: "browser",
  directory: "",
  detailPath: "",
  diffLayer: "worktree",
  entries: [],
  nextCursor: null,
  directoryTruncated: false,
  file: null,
  diff: null,
  status: null,
  changeLimit: 200,
  changeGroupsExpanded: { staged: true, worktree: true },
  branches: null,
  loading: false,
  loadingMore: false,
  loadingBranches: false,
  error: "",
};

export const WORKSPACE_PENDING_DELAY_MS = 180;

let requestVersion = 0;
let contentVersion = 0;
let directoryVersion = 0;
let statusVersion = 0;
let branchesVersion = 0;
let workspaceSession: NonNullable<typeof state.live> | null = null;
let workspaceScope: WorkspaceScope | null = null;
let directoryPageCount = 1;
let pendingRevealToken = 0;
let pendingRevealTimer: ReturnType<typeof setTimeout> | null = null;
let workspacePendingReveal = false;

export function isWorkspacePendingReveal(): boolean {
  return workspacePendingReveal;
}
type WorkspaceNavigation = {
  root: string;
  directoryPageCount: number;
  navigation: Pick<WorkspaceModel, "tab" | "view" | "directory" | "detailPath" | "diffLayer" | "changeLimit" | "changeGroupsExpanded">;
};
const workspaceCache = new WeakMap<NonNullable<typeof state.live>, Map<string, WorkspaceNavigation>>();
const readCaches = new WeakMap<NonNullable<typeof state.live>, WorkspaceReadCache>();
const MAX_CACHED_WORKSPACES = 6;

function readCache(session: NonNullable<typeof state.live>): WorkspaceReadCache {
  let cache = readCaches.get(session);
  if (!cache) {
    cache = new WorkspaceReadCache(session, (paneId) => state.live === session ? state.agents.find((pane) => pane.paneId === paneId)?.cwd : undefined);
    readCaches.set(session, cache);
  }
  return cache;
}

function workspaceError(error: unknown): string {
  if (error instanceof ProtocolError && error.code === "unknown_op") return t("workspace.unsupported");
  return messageOf(error);
}

function current(version: number, session: typeof state.live, paneId = workspaceModel.paneId): boolean {
  return version === requestVersion && session !== null && state.live === session && workspaceModel.paneId === paneId;
}

function cachedModel(session: NonNullable<typeof state.live>, paneId: string): WorkspaceNavigation | null {
  const cache = workspaceCache.get(session);
  const cached = cache?.get(paneId);
  if (!cache || !cached) return null;
  cache.delete(paneId);
  cache.set(paneId, cached);
  return cached;
}

function cacheCurrentModel(): void {
  if (!workspaceSession || !workspaceModel.paneId || !workspaceModel.descriptor) return;
  let cache = workspaceCache.get(workspaceSession);
  if (!cache) {
    cache = new Map();
    workspaceCache.set(workspaceSession, cache);
  }
  cache.delete(workspaceModel.paneId);
  cache.set(workspaceModel.paneId, {
    root: workspaceModel.descriptor.root,
    navigation: {
      tab: workspaceModel.tab,
      view: workspaceModel.view,
      directory: workspaceModel.directory,
      detailPath: workspaceModel.detailPath,
      diffLayer: workspaceModel.diffLayer,
      changeLimit: workspaceModel.changeLimit,
      changeGroupsExpanded: { ...workspaceModel.changeGroupsExpanded },
    },
    directoryPageCount,
  });
  while (cache.size > MAX_CACHED_WORKSPACES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function clearWorkspacePendingReveal(): void {
  pendingRevealToken++;
  if (pendingRevealTimer !== null) {
    clearTimeout(pendingRevealTimer);
    pendingRevealTimer = null;
  }
  workspacePendingReveal = false;
}

function armPendingReveal(): void {
  if (workspacePendingReveal || pendingRevealTimer !== null) return;
  const token = pendingRevealToken;
  pendingRevealTimer = setTimeout(() => {
    if (token !== pendingRevealToken) return;
    workspacePendingReveal = true;
    pendingRevealTimer = null;
    if (workspaceModel.loading) render();
  }, WORKSPACE_PENDING_DELAY_MS);
}

function finishWorkspaceLoad(): void {
  clearWorkspacePendingReveal();
  workspaceModel.loading = false;
  workspaceModel.loadingMore = false;
}

function reset(paneId: string, returnView: WorkspaceReturnView): void {
  requestVersion++;
  contentVersion++;
  directoryVersion++;
  statusVersion++;
  branchesVersion++;
  clearWorkspacePendingReveal();
  workspaceScope = null;
  directoryPageCount = 1;
  Object.assign(workspaceModel, {
    paneId,
    returnView,
    descriptor: null,
    tab: "files",
    view: "browser",
    directory: "",
    detailPath: "",
    diffLayer: "worktree",
    entries: [],
    nextCursor: null,
    directoryTruncated: false,
    file: null,
    diff: null,
    status: null,
    changeLimit: 200,
    changeGroupsExpanded: { staged: true, worktree: true },
    branches: null,
    loading: true,
    loadingMore: false,
    loadingBranches: false,
    error: "",
  } satisfies WorkspaceModel);
  adoptDiffNoteScope(null);
  armPendingReveal();
}

export async function enterWorkspace(
  paneId = state.paneId,
  returnView: WorkspaceReturnView = state.fullTerminal ? "full" : state.agentChat ? "agent" : "guided",
  force = false,
): Promise<void> {
  const session = state.live;
  if (!session || !paneId) return;
  cacheCurrentModel();
  const cached = cachedModel(session, paneId);
  workspaceSession = session;
  reset(paneId, returnView);
  clearNotice();
  state.screen = "workspace";
  render();
  const version = requestVersion;
  let initialContentRequest = contentVersion;
  try {
    const scope = await readCache(session).open(paneId, force);
    if (!current(version, session, paneId)) return;
    workspaceScope = scope;
    const descriptor = scope.descriptor;
    workspaceModel.descriptor = descriptor;
    let pages = 1;
    if (cached?.root === descriptor.root) {
      Object.assign(workspaceModel, cached.navigation);
      if (!force) pages = cached.directoryPageCount;
    }
    const detail = workspaceModel.view !== "browser";
    const tasks: Promise<void>[] = [];
    if (workspaceModel.view === "file") tasks.push(loadWorkspaceFile(workspaceModel.detailPath));
    else if (workspaceModel.view === "diff") tasks.push(loadGitDiff(workspaceModel.detailPath, workspaceModel.diffLayer));
    tasks.push(restoreDirectory(workspaceModel.directory, pages, version, detail));
    initialContentRequest = contentVersion;
    if (descriptor.features.git_status) tasks.push(loadStatus(version));
    await Promise.all(tasks);
  } catch (error) {
    if (!current(version, session, paneId)) return;
    workspaceModel.error = workspaceError(error);
  } finally {
    if (current(version, session, paneId)) {
      if (initialContentRequest === contentVersion) finishWorkspaceLoad();
      render();
    }
  }
}

async function restoreDirectory(path: string, pages: number, version: number, preserveDetail: boolean): Promise<void> {
  for (let page = 0; page < pages; page++) {
    const loading = loadDirectory(path, page > 0, version, preserveDetail);
    const directoryRequest = directoryVersion;
    const contentRequest = contentVersion;
    await loading;
    if (version !== requestVersion || directoryRequest !== directoryVersion || contentRequest !== contentVersion
      || workspaceModel.directory !== path || !workspaceModel.nextCursor || workspaceModel.error) return;
  }
}

function bindDiffNotes(session: object, paneId: string, diff: GitDiff | null): void {
  adoptDiffNoteScope(diff?.revision ? { session, paneId, revision: diff.revision } : null);
}

export function leaveWorkspace(): void {
  const paneId = workspaceModel.paneId;
  const session = state.live;
  requestVersion++;
  contentVersion++;
  directoryVersion++;
  statusVersion++;
  branchesVersion++;
  clearWorkspacePendingReveal();
  cacheCurrentModel();
  adoptDiffNoteScope(null);
  clearNotice();
  if (!paneId || !session) {
    state.screen = "home";
    render();
    return;
  }
  if (state.live !== session) {
    state.screen = "home";
    render();
    return;
  }
  state.paneId = paneId;
  state.screen = "pane";
  state.fullTerminal = workspaceModel.returnView === "full";
  state.agentChat = workspaceModel.returnView === "agent";
  render();
}

export async function loadDirectory(path: string, append = false, version = requestVersion, preserveDetail = false): Promise<void> {
  const session = state.live;
  const paneId = workspaceModel.paneId;
  const scope = workspaceScope;
  if (!session || !paneId || !scope) return;
  const cursor = append ? workspaceModel.nextCursor ?? "" : "";
  if (append && !cursor) return;
  const contentRequest = preserveDetail ? contentVersion : ++contentVersion;
  const directoryRequest = ++directoryVersion;
  const active = () => current(version, session, paneId) && directoryRequest === directoryVersion && (preserveDetail || contentRequest === contentVersion);
  const previousDirectory = workspaceModel.directory;
  const previousEntries = workspaceModel.entries;
  const jumped = !append && path !== workspaceModel.directory;
  workspaceModel.error = "";
  workspaceModel.loadingMore = append;
  if (!append && !preserveDetail) workspaceModel.loading = true;
  if (jumped) {
    workspaceModel.directory = path;
    workspaceModel.entries = [];
    workspaceModel.nextCursor = null;
    armPendingReveal();
  } else if (!append && !workspaceModel.entries.length) {
    armPendingReveal();
  }
  const apply = (page: WorkspaceDirectoryPage) => {
    workspaceModel.directory = page.path;
    workspaceModel.entries = append ? [...previousEntries, ...page.entries] : page.entries;
    workspaceModel.nextCursor = page.next_cursor;
    workspaceModel.directoryTruncated = page.truncated;
    if (!append && !preserveDetail) {
      workspaceModel.file = null;
      workspaceModel.diff = null;
      workspaceModel.detailPath = "";
      workspaceModel.view = "browser";
      adoptDiffNoteScope(null);
    }
  };
  const read = scope.directory(path, cursor);
  if (read.cached) apply(read.cached);
  render();
  try {
    const page = await read.value;
    if (!active()) return;
    apply(page);
    directoryPageCount = append ? directoryPageCount + 1 : 1;
  } catch (error) {
    if (active()) {
      workspaceModel.error = workspaceError(error);
      if (jumped) workspaceModel.directory = previousDirectory;
    }
  } finally {
    if (active()) {
      if (!preserveDetail) finishWorkspaceLoad();
      workspaceModel.loadingMore = false;
      render();
    }
  }
}

export async function loadWorkspaceFile(path: string): Promise<void> {
  const session = state.live;
  const paneId = workspaceModel.paneId;
  const scope = workspaceScope;
  if (!session || !paneId || !scope) return;
  const version = requestVersion;
  const contentRequest = ++contentVersion;
  const keep = workspaceModel.file?.path === path;
  workspaceModel.loading = true;
  workspaceModel.error = "";
  workspaceModel.view = "file";
  workspaceModel.detailPath = path;
  if (!keep) {
    workspaceModel.file = null;
    armPendingReveal();
  }
  const read = scope.file(path);
  if (read.cached) workspaceModel.file = read.cached;
  adoptDiffNoteScope(null);
  render();
  try {
    const file = await read.value;
    if (current(version, session, paneId) && contentRequest === contentVersion) workspaceModel.file = file;
  } catch (error) {
    if (current(version, session, paneId) && contentRequest === contentVersion) workspaceModel.error = workspaceError(error);
  } finally {
    if (current(version, session, paneId) && contentRequest === contentVersion) {
      finishWorkspaceLoad();
      render();
    }
  }
}

export async function loadStatus(version = requestVersion): Promise<void> {
  const session = state.live;
  const paneId = workspaceModel.paneId;
  const scope = workspaceScope;
  if (!session || !paneId || !scope || workspaceModel.descriptor?.features.git_status === false) return;
  const statusRequest = ++statusVersion;
  const read = scope.status();
  if (read.cached) workspaceModel.status = read.cached;
  try {
    const status = await read.value;
    if (current(version, session, paneId) && statusRequest === statusVersion) workspaceModel.status = status;
  } catch (error) {
    if (current(version, session, paneId) && statusRequest === statusVersion) workspaceModel.error = workspaceError(error);
  } finally {
    if (current(version, session, paneId) && statusRequest === statusVersion) render();
  }
}

export async function refreshWorkspace(): Promise<void> {
  await enterWorkspace(workspaceModel.paneId, workspaceModel.returnView, true);
}

export async function loadGitDiff(path: string, layer: GitLayer): Promise<void> {
  const session = state.live;
  const paneId = workspaceModel.paneId;
  const scope = workspaceScope;
  if (!session || !paneId || !scope) return;
  const version = requestVersion;
  const contentRequest = ++contentVersion;
  const keep = Boolean(workspaceModel.diff && workspaceModel.diff.path === path && workspaceModel.diffLayer === layer);
  workspaceModel.loading = true;
  workspaceModel.error = "";
  workspaceModel.view = "diff";
  workspaceModel.detailPath = path;
  workspaceModel.diffLayer = layer;
  if (!keep) {
    workspaceModel.diff = null;
    adoptDiffNoteScope(null);
    armPendingReveal();
  }
  const read = scope.diff(path, layer);
  if (read.cached) {
    workspaceModel.diff = read.cached;
    bindDiffNotes(session, paneId, read.cached);
  }
  render();
  try {
    const diff = await read.value;
    if (current(version, session, paneId) && contentRequest === contentVersion) {
      workspaceModel.diff = diff;
      bindDiffNotes(session, paneId, diff);
    }
  } catch (error) {
    if (current(version, session, paneId) && contentRequest === contentVersion) workspaceModel.error = workspaceError(error);
  } finally {
    if (current(version, session, paneId) && contentRequest === contentVersion) {
      finishWorkspaceLoad();
      render();
    }
  }
}

export function showWorkspaceTab(tab: WorkspaceTab): void {
  contentVersion++;
  workspaceModel.tab = tab;
  workspaceModel.view = "browser";
  finishWorkspaceLoad();
  workspaceModel.error = "";
  render();
  if (tab === "changes") void loadStatus();
}

export function closeWorkspaceDetail(): void {
  contentVersion++;
  workspaceModel.view = "browser";
  finishWorkspaceLoad();
  workspaceModel.file = null;
  workspaceModel.diff = null;
  workspaceModel.detailPath = "";
  workspaceModel.error = "";
  render();
}

export function showMoreWorkspaceChanges(): void {
  workspaceModel.changeLimit += 200;
  render();
}

export function toggleWorkspaceChangeGroup(layer: GitLayer): void {
  workspaceModel.changeGroupsExpanded = {
    ...workspaceModel.changeGroupsExpanded,
    [layer]: !workspaceModel.changeGroupsExpanded[layer],
  };
  render();
}

export async function ensureBranches(): Promise<GitBranches | null> {
  const session = state.live;
  const paneId = workspaceModel.paneId;
  const scope = workspaceScope;
  if (!session || !paneId || !scope) return null;
  const version = requestVersion;
  const branchesRequest = ++branchesVersion;
  workspaceModel.loadingBranches = true;
  const read = scope.branches();
  if (read.cached) workspaceModel.branches = read.cached;
  render();
  try {
    const branches = await read.value;
    if (!current(version, session, paneId) || branchesRequest !== branchesVersion) return null;
    workspaceModel.branches = branches;
    return branches;
  } catch (error) {
    if (current(version, session, paneId) && branchesRequest === branchesVersion) workspaceModel.error = messageOf(error);
    return null;
  } finally {
    if (current(version, session, paneId) && branchesRequest === branchesVersion) {
      workspaceModel.loadingBranches = false;
      render();
    }
  }
}
