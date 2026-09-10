import type {
  GitBranches,
  GitDiff,
  GitLayer,
  GitStatus,
  WorkspaceDescriptor,
  WorkspaceEntry,
  WorkspaceFile,
} from "../../lib/workspace";
import type { WorkspaceMediaView } from "./media-model";
import { emptyMediaView } from "./media-model";

export type WorkspaceTab = "files" | "changes";
export type WorkspaceView = "browser" | "file" | "diff";
export type WorkspaceReturnView = "guided" | "full" | "agent";

export type WorkspaceChangeGroups = Readonly<{ staged: boolean; worktree: boolean }>;

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
  media: WorkspaceMediaView;
  revealNav: boolean;
  revealFile: boolean;
  revealDiff: boolean;
};

type DeepReadonly<T> = T extends (...args: never) => unknown ? T
  : T extends ReadonlyArray<infer U> ? ReadonlyArray<DeepReadonly<U>>
  : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

/** Immutable UI snapshot. Nested values are reused when the field did not change. */
export type WorkspaceSnapshot = Readonly<{
  paneId: string;
  returnView: WorkspaceReturnView;
  descriptor: DeepReadonly<WorkspaceDescriptor> | null;
  tab: WorkspaceTab;
  view: WorkspaceView;
  directory: string;
  detailPath: string;
  diffLayer: GitLayer;
  entries: ReadonlyArray<DeepReadonly<WorkspaceEntry>>;
  nextCursor: string | null;
  directoryTruncated: boolean;
  file: DeepReadonly<WorkspaceFile> | null;
  diff: DeepReadonly<GitDiff> | null;
  status: DeepReadonly<GitStatus> | null;
  changeLimit: number;
  changeGroupsExpanded: WorkspaceChangeGroups;
  branches: DeepReadonly<GitBranches> | null;
  loading: boolean;
  loadingMore: boolean;
  loadingBranches: boolean;
  error: string;
  media: DeepReadonly<WorkspaceMediaView>;
  pendingReveal: boolean;
  notesEpoch: number;
  revealNav: boolean;
  revealFile: boolean;
  revealDiff: boolean;
}>;

export const WORKSPACE_PENDING_DELAY_MS = 180;

export function emptyWorkspaceModel(): WorkspaceModel {
  return {
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
    media: emptyMediaView(),
    revealNav: false,
    revealFile: false,
    revealDiff: false,
  };
}

export function loadingWorkspaceModel(paneId: string, returnView: WorkspaceReturnView): WorkspaceModel {
  return {
    ...emptyWorkspaceModel(),
    paneId,
    returnView,
    loading: true,
  };
}
