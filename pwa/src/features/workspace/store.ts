import { liveSession } from "../computers/catalog-store";
import { dashboardStore } from "../dashboard/catalog-store";
import { adoptDiffNoteScope } from "../../lib/diff-notes";
import type { LiveSession } from "../../lib/protocol/client";
import type { GitBranches, GitDiff, GitLayer, GitStatus, WorkspaceDescriptor, WorkspaceEntry, WorkspaceFile } from "../../lib/workspace";
import { WorkspaceReadCache, type WorkspaceScope } from "../../lib/workspace-cache";
import { cloneData, nestedSlot } from "./immutable";
import {
  emptyWorkspaceModel,
  loadingWorkspaceModel,
  WORKSPACE_PENDING_DELAY_MS,
  type WorkspaceModel,
  type WorkspaceReturnView,
  type WorkspaceSnapshot,
} from "./model";
import { emptyMediaView } from "./media-model";
import { WorkspaceMediaLoader } from "./media-loader";

export type { WorkspaceSnapshot };
export { WORKSPACE_PENDING_DELAY_MS };

type Listener = () => void;
type Session = LiveSession;
type WorkspaceNavigation = {
  root: string;
  directoryPageCount: number;
  navigation: Pick<WorkspaceModel, "tab" | "view" | "directory" | "detailPath" | "diffLayer" | "changeLimit" | "changeGroupsExpanded">;
};

const MAX_CACHED_WORKSPACES = 6;
const listeners = new Set<Listener>();

let model: WorkspaceModel = emptyWorkspaceModel();
let snapshot!: WorkspaceSnapshot;
let pendingReveal = false;
let notesEpoch = 0;
let pendingRevealToken = 0;
let pendingRevealTimer: ReturnType<typeof setTimeout> | null = null;
let requestVersion = 0;
let contentVersion = 0;
let directoryVersion = 0;
let statusVersion = 0;
let branchesVersion = 0;
let workspaceSession: Session | null = null;
let workspaceScope: WorkspaceScope | null = null;
let directoryPageCount = 1;
const workspaceCache = new WeakMap<Session, Map<string, WorkspaceNavigation>>();
const readCaches = new WeakMap<Session, WorkspaceReadCache>();

let descriptorSlot = nestedSlot(undefined, null as WorkspaceDescriptor | null);
let entriesSlot = nestedSlot(undefined, [] as WorkspaceEntry[]);
let fileSlot = nestedSlot(undefined, null as WorkspaceFile | null);
let diffSlot = nestedSlot(undefined, null as GitDiff | null);
let statusSlot = nestedSlot(undefined, null as GitStatus | null);
let branchesSlot = nestedSlot(undefined, null as GitBranches | null);
let mediaSlot = nestedSlot(undefined, emptyMediaView());

/** Staged compatibility object. Nested fields are clones, not snapshot aliases. */
export const workspaceModel: WorkspaceModel = emptyWorkspaceModel();

function freezeGroups(next: WorkspaceModel["changeGroupsExpanded"]): WorkspaceSnapshot["changeGroupsExpanded"] {
  const prev = snapshot?.changeGroupsExpanded;
  if (prev && prev.staged === next.staged && prev.worktree === next.worktree) return prev;
  return Object.freeze({ staged: next.staged, worktree: next.worktree });
}

function publishNested(): void {
  descriptorSlot = nestedSlot(descriptorSlot, model.descriptor);
  entriesSlot = nestedSlot(entriesSlot, model.entries);
  fileSlot = nestedSlot(fileSlot, model.file);
  diffSlot = nestedSlot(diffSlot, model.diff);
  statusSlot = nestedSlot(statusSlot, model.status);
  branchesSlot = nestedSlot(branchesSlot, model.branches);
  mediaSlot = nestedSlot(mediaSlot, model.media);
}

function freezeSnapshot(next: WorkspaceModel, reveal: boolean, epoch: number): WorkspaceSnapshot {
  publishNested();
  const groups = freezeGroups(next.changeGroupsExpanded);
  if (
    snapshot
    && snapshot.paneId === next.paneId
    && snapshot.returnView === next.returnView
    && snapshot.descriptor === descriptorSlot.frozen
    && snapshot.tab === next.tab
    && snapshot.view === next.view
    && snapshot.directory === next.directory
    && snapshot.detailPath === next.detailPath
    && snapshot.diffLayer === next.diffLayer
    && snapshot.entries === entriesSlot.frozen
    && snapshot.nextCursor === next.nextCursor
    && snapshot.directoryTruncated === next.directoryTruncated
    && snapshot.file === fileSlot.frozen
    && snapshot.diff === diffSlot.frozen
    && snapshot.status === statusSlot.frozen
    && snapshot.changeLimit === next.changeLimit
    && snapshot.changeGroupsExpanded === groups
    && snapshot.branches === branchesSlot.frozen
    && snapshot.media === mediaSlot.frozen
    && snapshot.loading === next.loading
    && snapshot.loadingMore === next.loadingMore
    && snapshot.loadingBranches === next.loadingBranches
    && snapshot.error === next.error
    && snapshot.pendingReveal === reveal
    && snapshot.notesEpoch === epoch
    && snapshot.revealNav === next.revealNav
    && snapshot.revealFile === next.revealFile
    && snapshot.revealDiff === next.revealDiff
  ) return snapshot;
  return Object.freeze({
    paneId: next.paneId,
    returnView: next.returnView,
    descriptor: descriptorSlot.frozen,
    tab: next.tab,
    view: next.view,
    directory: next.directory,
    detailPath: next.detailPath,
    diffLayer: next.diffLayer,
    entries: entriesSlot.frozen,
    nextCursor: next.nextCursor,
    directoryTruncated: next.directoryTruncated,
    file: fileSlot.frozen,
    diff: diffSlot.frozen,
    status: statusSlot.frozen,
    changeLimit: next.changeLimit,
    changeGroupsExpanded: groups,
    branches: branchesSlot.frozen,
    media: mediaSlot.frozen,
    loading: next.loading,
    loadingMore: next.loadingMore,
    loadingBranches: next.loadingBranches,
    error: next.error,
    pendingReveal: reveal,
    notesEpoch: epoch,
    revealNav: next.revealNav,
    revealFile: next.revealFile,
    revealDiff: next.revealDiff,
  });
}

snapshot = freezeSnapshot(model, false, 0);

function syncCompatibilityModel(): void {
  workspaceModel.paneId = snapshot.paneId;
  workspaceModel.returnView = snapshot.returnView;
  workspaceModel.descriptor = descriptorSlot.compat;
  workspaceModel.tab = snapshot.tab;
  workspaceModel.view = snapshot.view;
  workspaceModel.directory = snapshot.directory;
  workspaceModel.detailPath = snapshot.detailPath;
  workspaceModel.diffLayer = snapshot.diffLayer;
  workspaceModel.entries = entriesSlot.compat;
  workspaceModel.nextCursor = snapshot.nextCursor;
  workspaceModel.directoryTruncated = snapshot.directoryTruncated;
  workspaceModel.file = fileSlot.compat;
  workspaceModel.diff = diffSlot.compat;
  workspaceModel.status = statusSlot.compat;
  workspaceModel.changeLimit = snapshot.changeLimit;
  workspaceModel.changeGroupsExpanded = { ...snapshot.changeGroupsExpanded };
  workspaceModel.branches = branchesSlot.compat;
  workspaceModel.media = mediaSlot.compat;
  workspaceModel.loading = snapshot.loading;
  workspaceModel.loadingMore = snapshot.loadingMore;
  workspaceModel.loadingBranches = snapshot.loadingBranches;
  workspaceModel.error = snapshot.error;
  workspaceModel.revealNav = snapshot.revealNav;
  workspaceModel.revealFile = snapshot.revealFile;
  workspaceModel.revealDiff = snapshot.revealDiff;
}

function emit(notify = true): void {
  const next = freezeSnapshot(model, pendingReveal, notesEpoch);
  if (next === snapshot) {
    syncCompatibilityModel();
    return;
  }
  snapshot = next;
  syncCompatibilityModel();
  if (!notify || !listeners.size) return;
  for (const listener of [...listeners]) listener();
}

const NESTED_MODEL_KEYS = ["descriptor", "entries", "file", "diff", "status", "branches", "media", "changeGroupsExpanded"] as const;

function ownPatch(patch: Partial<WorkspaceModel>): Partial<WorkspaceModel> {
  const next: Partial<WorkspaceModel> = { ...patch };
  for (const key of NESTED_MODEL_KEYS) {
    if (!Object.hasOwn(next, key)) continue;
    next[key] = cloneData(next[key]) as never;
  }
  return next;
}

function applyModel(patch: Partial<WorkspaceModel>, effect?: () => void): void {
  model = { ...model, ...ownPatch(patch) };
  effect?.();
  emit();
}

function retirePending(): void {
  requestVersion++;
  contentVersion++;
  directoryVersion++;
  statusVersion++;
  branchesVersion++;
  clearWorkspacePendingReveal();
  workspaceScope = null;
  adoptDiffNoteScope(null);
  // Drop every owned media resource (AbortController, blob URL, remote handle)
  // when the session/pane/root/identity is retired. Media view resets too; any
  // in-flight media load has both its ticket and media generation invalidated.
  mediaGeneration++;
  mediaResources.release();
  model = {
    ...model,
    loading: false,
    loadingMore: false,
    loadingBranches: false,
    media: emptyMediaView(),
    revealNav: false,
    revealFile: false,
    revealDiff: false,
  };
}

export function subscribeWorkspace(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getWorkspaceSnapshot(): WorkspaceSnapshot {
  return snapshot;
}

type TicketFlags = {
  content?: boolean;
  directory?: boolean;
  status?: boolean;
  branches?: boolean;
};

type TicketCapture = {
  session: Session;
  paneId: string;
  generation: number;
  content: number;
  directory: number;
  status: number;
  branches: number;
};

export type WorkspaceTicket = {
  current(): boolean;
  sameContent(): boolean;
  /** Apply patch, run owner side effects, then notify. False if retired before or during notify. */
  commit(patch: Partial<WorkspaceModel>, effect?: () => void): boolean;
  finishLoad(): boolean;
};

function ownerLive(captured: TicketCapture): boolean {
  return captured.session === liveSession() && captured.paneId === model.paneId && captured.generation === requestVersion;
}

function makeTicket(captured: TicketCapture, flags: TicketFlags): WorkspaceTicket {
  const current = () => {
    if (!ownerLive(captured)) return false;
    if (flags.content && captured.content !== contentVersion) return false;
    if (flags.directory && captured.directory !== directoryVersion) return false;
    if (flags.status && captured.status !== statusVersion) return false;
    if (flags.branches && captured.branches !== branchesVersion) return false;
    return true;
  };
  return {
    current,
    sameContent: () => ownerLive(captured) && captured.content === contentVersion,
    commit(patch, effect) {
      if (!current()) return false;
      applyModel(patch, effect);
      return current();
    },
    finishLoad() {
      if (!current()) return false;
      finishWorkspaceLoad();
      return current();
    },
  };
}

function capture(session: Session, paneId: string): TicketCapture {
  return {
    session,
    paneId,
    generation: requestVersion,
    content: contentVersion,
    directory: directoryVersion,
    status: statusVersion,
    branches: branchesVersion,
  };
}

export function issueTicket(opts?: {
  content?: "keep" | "bump";
  directory?: "bump";
  status?: "bump";
  branches?: "bump";
}): WorkspaceTicket | null {
  const session = workspaceSession;
  const paneId = model.paneId;
  if (!session || !paneId) return null;
  if (opts?.content === "bump") contentVersion++;
  if (opts?.directory === "bump") directoryVersion++;
  if (opts?.status === "bump") statusVersion++;
  if (opts?.branches === "bump") branchesVersion++;
  return makeTicket(capture(session, paneId), {
    content: opts?.content === "bump",
    directory: opts?.directory === "bump",
    status: opts?.status === "bump",
    branches: opts?.branches === "bump",
  });
}

export function beginEnter(session: Session, paneId: string, returnView: WorkspaceReturnView): {
  ticket: WorkspaceTicket;
  cached: WorkspaceNavigation | null;
} {
  const cached = takeCachedModel(session, paneId);
  workspaceSession = session;
  retirePending();
  directoryPageCount = 1;
  notesEpoch++;
  model = loadingWorkspaceModel(paneId, returnView);
  armPendingReveal();
  emit(false);
  return {
    ticket: makeTicket(capture(session, paneId), {}),
    cached,
  };
}

export function bindScope(ticket: WorkspaceTicket, scope: WorkspaceScope): boolean {
  if (!ticket.current()) return false;
  workspaceScope = scope;
  return true;
}

export function activeScope(): WorkspaceScope | null {
  return workspaceScope;
}

export function noteDirectoryPage(append: boolean): void {
  directoryPageCount = append ? directoryPageCount + 1 : 1;
}

export function readCache(session: Session): WorkspaceReadCache {
  let cache = readCaches.get(session);
  if (!cache) {
    cache = new WorkspaceReadCache(session, (id) => (
      liveSession() === session
        ? dashboardStore.get().agents.find((pane) => pane.paneId === id)?.cwd
        : undefined
    ));
    readCaches.set(session, cache);
  }
  return cache;
}

function takeCachedModel(session: Session, paneId: string): WorkspaceNavigation | null {
  cacheCurrent();
  const cache = workspaceCache.get(session);
  const cached = cache?.get(paneId);
  if (!cache || !cached) return null;
  cache.delete(paneId);
  cache.set(paneId, cached);
  return cached;
}

function cacheCurrent(): void {
  if (!workspaceSession || !model.paneId || !model.descriptor) return;
  let cache = workspaceCache.get(workspaceSession);
  if (!cache) {
    cache = new Map();
    workspaceCache.set(workspaceSession, cache);
  }
  cache.delete(model.paneId);
  cache.set(model.paneId, {
    root: model.descriptor.root,
    navigation: {
      tab: model.tab,
      view: model.view,
      directory: model.directory,
      detailPath: model.detailPath,
      diffLayer: model.diffLayer,
      changeLimit: model.changeLimit,
      changeGroupsExpanded: { ...model.changeGroupsExpanded },
    },
    directoryPageCount,
  });
  while (cache.size > MAX_CACHED_WORKSPACES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function beginLeave(): { paneId: string; returnView: WorkspaceReturnView } {
  const paneId = model.paneId;
  const returnView = model.returnView;
  retirePending();
  cacheCurrent();
  return { paneId, returnView };
}

export function clearWorkspacePendingReveal(): void {
  pendingRevealToken++;
  if (pendingRevealTimer !== null) {
    clearTimeout(pendingRevealTimer);
    pendingRevealTimer = null;
  }
  pendingReveal = false;
}

export function armPendingReveal(): void {
  if (pendingReveal || pendingRevealTimer !== null) return;
  const token = pendingRevealToken;
  pendingRevealTimer = setTimeout(() => {
    if (token !== pendingRevealToken) return;
    pendingReveal = true;
    pendingRevealTimer = null;
    if (model.loading) emit();
  }, WORKSPACE_PENDING_DELAY_MS);
}

export function finishWorkspaceLoad(): void {
  const pending = pendingReveal;
  clearWorkspacePendingReveal();
  applyModel({
    loading: false,
    loadingMore: false,
    revealNav: pending && model.view === "browser",
    revealFile: pending && model.view === "file",
    revealDiff: pending && model.view === "diff",
  });
}

export function adoptWorkspaceIdentity(identity: {
  paneId: string;
  directory?: string;
  descriptor?: WorkspaceDescriptor | null;
}): void {
  const previousRoot = model.descriptor?.root;
  const nextRoot = identity.descriptor !== undefined ? identity.descriptor?.root : previousRoot;
  const rootChanged = nextRoot !== previousRoot;
  retirePending();
  applyModel({
    paneId: identity.paneId,
    loading: false,
    loadingMore: false,
    loadingBranches: false,
    revealNav: false,
    revealFile: false,
    revealDiff: false,
    ...(identity.directory !== undefined ? { directory: identity.directory } : {}),
    ...(identity.descriptor !== undefined ? { descriptor: identity.descriptor } : {}),
    ...(rootChanged ? {
      file: null,
      diff: null,
      entries: [],
      status: null,
      branches: null,
      view: "browser" as const,
      detailPath: "",
      error: "",
    } : {}),
  });
}

export function setWorkspaceError(error: string): void {
  applyModel({ error });
}

export function bumpWorkspaceNotes(): void {
  notesEpoch++;
  emit();
}

export function toggleChangeGroup(layer: GitLayer): void {
  applyModel({
    changeGroupsExpanded: {
      ...model.changeGroupsExpanded,
      [layer]: !model.changeGroupsExpanded[layer],
    },
  });
}

export function invalidateWorkspaceFiles(session: Session, root: string): void {
  readCaches.get(session)?.invalidate(root);
}

// The media loader is a private owner lifetime (AbortController/URL/handle). It
// is never part of the snapshot; a single instance survives across loads and is
// cancelled/released only when the workspace itself is retired.
const mediaResources = new WorkspaceMediaLoader();

// Independent media-operation generation. A ticket proves session/pane/root/content
// ownership, but two media loads on the SAME owner (e.g. a fast switch that keeps
// content) still need an ordering token so a stale continuation neither starts a
// loader RPC nor publishes after a newer load / a loading-publication retirement.
let mediaGeneration = 0;

/** Claim the newest media generation. Any older in-flight media action is stale. */
export function claimMediaGeneration(): number {
	mediaGeneration++;
	return mediaGeneration;
}

export function currentMediaGeneration(): number {
	return mediaGeneration
}

/** Current owned media loader. Actions hold this while a load is in flight. */
export function workspaceMediaLoader(): WorkspaceMediaLoader {
  return mediaResources;
}

export function workspacePaneCwd(paneId: string): string | undefined {
  return dashboardStore.get().agents.find((pane) => pane.paneId === paneId)?.cwd;
}

export function clearWorkspaceError(): void {
  applyModel({ error: "" });
}

export function markWorkspaceBrowser(): void {
  applyModel({ view: "browser" });
}

export function bumpWorkspaceChangeLimit(by = 200): void {
  applyModel({ changeLimit: model.changeLimit + by });
}

export function applyBrowserTab(tab: WorkspaceModel["tab"]): void {
  applyModel({ tab, view: "browser", error: "" });
}
