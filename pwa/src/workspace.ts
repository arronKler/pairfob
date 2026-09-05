import { adoptDiffNoteScope } from "./lib/diff-notes";
import type {
  GitBranches,
  GitDiff,
  GitLayer,
  GitStatus,
  WorkspaceDescriptor,
  WorkspaceEntry,
  WorkspaceFile,
} from "./lib/workspace";
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
let statusVersion = 0;
let branchesVersion = 0;
let workspaceSession: NonNullable<typeof state.live> | null = null;
let pendingRevealToken = 0;
let pendingRevealTimer: ReturnType<typeof setTimeout> | null = null;
let workspacePendingReveal = false;

export function isWorkspacePendingReveal(): boolean {
  return workspacePendingReveal;
}
const workspaceCache = new WeakMap<NonNullable<typeof state.live>, Map<string, WorkspaceModel>>();
const MAX_CACHED_WORKSPACES = 6;

function workspaceError(error: unknown): string {
  if (error instanceof ProtocolError && error.code === "unknown_op") return t("workspace.unsupported");
  return messageOf(error);
}

function current(version: number, session: typeof state.live, paneId = workspaceModel.paneId): boolean {
  return version === requestVersion && session !== null && state.live === session && workspaceModel.paneId === paneId;
}

function cachedModel(session: NonNullable<typeof state.live>, paneId: string): WorkspaceModel | null {
  const cache = workspaceCache.get(session);
  const cached = cache?.get(paneId);
  if (!cache || !cached) return null;
  cache.delete(paneId);
  cache.set(paneId, cached);
  return cached;
}

function cacheCurrentModel(): void {
  if (!workspaceSession || !workspaceModel.paneId || workspaceModel.loading) return;
  let cache = workspaceCache.get(workspaceSession);
  if (!cache) {
    cache = new Map();
    workspaceCache.set(workspaceSession, cache);
  }
  cache.delete(workspaceModel.paneId);
  cache.set(workspaceModel.paneId, {
    ...workspaceModel,
    loading: false,
    loadingMore: false,
    loadingBranches: false,
  });
  while (cache.size > MAX_CACHED_WORKSPACES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function restoreCachedModel(session: NonNullable<typeof state.live>, paneId: string, returnView: WorkspaceReturnView): boolean {
  const cached = cachedModel(session, paneId);
  if (!cached) return false;
  requestVersion++;
  contentVersion++;
  statusVersion++;
  branchesVersion++;
  workspaceSession = session;
  Object.assign(workspaceModel, cached, { returnView });
  bindDiffNotes(session, paneId, cached.diff);
  return true;
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
  statusVersion++;
  branchesVersion++;
  clearWorkspacePendingReveal();
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
): Promise<void> {
  const session = state.live;
  if (!session || !paneId) return;
  cacheCurrentModel();
  if (restoreCachedModel(session, paneId, returnView)) {
    clearWorkspacePendingReveal();
    clearNotice();
    state.screen = "workspace";
    render();
    return;
  }
  workspaceSession = session;
  reset(paneId, returnView);
  clearNotice();
  state.screen = "workspace";
  render();
  const version = requestVersion;
  try {
    const descriptor = await session.workspaceOpen(paneId);
    if (!current(version, session, paneId)) return;
    workspaceModel.descriptor = descriptor;
    const tasks: Promise<void>[] = [loadDirectory("", false, version)];
    if (descriptor.features.git_status) tasks.push(loadStatus(version));
    await Promise.all(tasks);
  } catch (error) {
    if (!current(version, session, paneId)) return;
    workspaceModel.error = workspaceError(error);
  } finally {
    if (current(version, session, paneId)) {
      finishWorkspaceLoad();
      render();
    }
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

export async function loadDirectory(path: string, append = false, version = requestVersion): Promise<void> {
  const session = state.live;
  const paneId = workspaceModel.paneId;
  if (!session || !paneId) return;
  const cursor = append ? workspaceModel.nextCursor ?? "" : "";
  if (append && !cursor) return;
  const contentRequest = ++contentVersion;
  const previousDirectory = workspaceModel.directory;
  const jumped = !append && path !== workspaceModel.directory;
  workspaceModel.error = "";
  workspaceModel.loadingMore = append;
  if (!append) workspaceModel.loading = true;
  if (jumped) {
    workspaceModel.directory = path;
    workspaceModel.entries = [];
    workspaceModel.nextCursor = null;
    armPendingReveal();
  } else if (!append && !workspaceModel.entries.length) {
    armPendingReveal();
  }
  render();
  try {
    const page = await session.workspaceList(paneId, path, cursor, 120);
    if (!current(version, session, paneId) || contentRequest !== contentVersion) return;
    workspaceModel.directory = page.path;
    workspaceModel.entries = append ? [...workspaceModel.entries, ...page.entries] : page.entries;
    workspaceModel.nextCursor = page.next_cursor;
    workspaceModel.directoryTruncated = page.truncated;
    if (!append) {
      workspaceModel.file = null;
      workspaceModel.diff = null;
      workspaceModel.detailPath = "";
      workspaceModel.view = "browser";
    }
  } catch (error) {
    if (current(version, session, paneId) && contentRequest === contentVersion) {
      workspaceModel.error = workspaceError(error);
      if (jumped) workspaceModel.directory = previousDirectory;
    }
  } finally {
    if (current(version, session, paneId) && contentRequest === contentVersion) {
      finishWorkspaceLoad();
      render();
    }
  }
}

export async function loadWorkspaceFile(path: string): Promise<void> {
  const session = state.live;
  const paneId = workspaceModel.paneId;
  if (!session || !paneId) return;
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
  render();
  try {
    const file = await session.workspaceRead(paneId, path);
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
  if (!session || !paneId || workspaceModel.descriptor?.features.git_status === false) return;
  const statusRequest = ++statusVersion;
  try {
    const status = await session.gitStatus(paneId);
    if (current(version, session, paneId) && statusRequest === statusVersion) workspaceModel.status = status;
  } catch (error) {
    if (current(version, session, paneId) && statusRequest === statusVersion) workspaceModel.error = workspaceError(error);
  } finally {
    if (current(version, session, paneId) && statusRequest === statusVersion) render();
  }
}

export async function refreshWorkspace(): Promise<void> {
  const version = requestVersion;
  branchesVersion++;
  workspaceModel.branches = null;
  workspaceModel.loadingBranches = false;
  workspaceModel.error = "";
  const status = workspaceModel.descriptor?.features.git_status ? loadStatus(version) : Promise.resolve();
  if (workspaceModel.view === "file" && workspaceModel.detailPath) {
    await Promise.all([loadWorkspaceFile(workspaceModel.detailPath), status]);
    return;
  }
  if (workspaceModel.view === "diff" && workspaceModel.detailPath) {
    await Promise.all([loadGitDiff(workspaceModel.detailPath, workspaceModel.diffLayer), status]);
    return;
  }
  await Promise.all([loadDirectory(workspaceModel.directory, false, version), status]);
}

export async function loadGitDiff(path: string, layer: GitLayer): Promise<void> {
  const session = state.live;
  const paneId = workspaceModel.paneId;
  if (!session || !paneId) return;
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
  render();
  try {
    const diff = await session.gitDiff(paneId, path, layer);
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
  if (workspaceModel.branches) return workspaceModel.branches;
  const session = state.live;
  const paneId = workspaceModel.paneId;
  if (!session || !paneId) return null;
  const version = requestVersion;
  const branchesRequest = ++branchesVersion;
  workspaceModel.loadingBranches = true;
  render();
  try {
    const branches = await session.gitBranches(paneId);
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
