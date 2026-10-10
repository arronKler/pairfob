import type { WorkspaceReference } from "./workspace-reference";
import type { RecoveryClock } from "./recovery-diagnostics";
import type { AgentInspection } from "../agent-inspect";
import type { AgentQuota } from "../agent-quota";
import type { MachineLinkStatus, MachineSummary } from "./machine-link.ts";
import type {
  AgentTracePage,
  AgentTraceDetail,
  CreateConversationInput,
  CreateConversationResult,
  CreateTabInput,
  CreateWorktreeInput,
  CreateWorktreeResult,
  CreatedPaneResult,
  LayoutMutationResult,
  ListWorktreesInput,
  OpenWorktreeInput,
  OpenWorktreeResult,
  PromptAgentInput,
  PromptAgentResult,
  ResizePaneInput,
  SplitPaneInput,
  SwapPaneInput,
  ZoomPaneInput,
} from "../operations.ts";
import type {
  UploadBeginInput,
  UploadState,
  UploadWriteInput,
} from "./attachments.ts";
import type { TerminalFramePart, TerminalOpenResult } from "./terminal.ts";
import type {
  GitBranches,
  GitDiff,
  GitLayer,
  GitStatus,
  WorkspaceDescriptor,
  WorkspaceDirectoryPage,
  WorkspaceFile,
} from "../workspace.ts";
import type {
  MediaReadOptions,
  WorkspaceMediaChunk,
  WorkspaceMediaClose,
  WorkspaceMediaOpen,
} from "./workspace-media.ts";

export interface SessionEvent {
  type: "checking" | "connected" | "disconnected" | "reconnecting" | "latency" | "poke" | "terminal" | "terminal_frame" | "terminal_closed";
  code?: string;
  message?: string;
  rttMs?: number;
  reason?: string;
  paneId?: string;
  terminalId?: string;
  terminalFrame?: TerminalFramePart;
  transport?: "relay" | "p2p";
}

/** One Herdr session a daemon can address. name is null for the default session. */
export interface HerdSessionSummary {
  name: string | null;
  running: boolean;
}

export interface DeviceSummary {
  device_id: string;
  label?: string;
  created_at?: number;
  last_seen?: number;
  revoked_at?: number | null;
  self?: boolean;
  connected?: boolean;
  subscription_count?: number;
}

export type LiveSession = {
  connectionRecovery?: () => RecoveryClock | undefined;
  ping: (t: number) => Promise<unknown>;
  agentInspect?: (paneId: string) => Promise<AgentInspection>;
  agentQuota: () => Promise<AgentQuota[]>;
  daemonUpdateStatus?: () => Promise<unknown>;
  daemonUpdate?: (target: string) => Promise<unknown>;
  listMachines?: () => Promise<MachineSummary[]>;
  linkMachineStatus?: () => Promise<MachineLinkStatus>;
  linkMachine?: (machineId: string, install: boolean) => Promise<MachineLinkStatus>;
  linkMachineCancel?: (operationId: string) => Promise<MachineLinkStatus>;
  getConfig: () => Promise<Record<string, unknown>>;
  snapshot: () => Promise<Record<string, unknown>>;
  paneRead: (paneId: string, lines?: number, format?: "ansi" | "text") => Promise<{ text: string; truncated?: boolean; hash?: string }>;
  sendKeys: (
    paneId: string,
    keys: string[],
    extra?: { intent?: "pad" | "dialog" | "submit"; expected_prompt?: string; expected_signature?: string },
  ) => Promise<unknown>;
  sendText: (paneId: string, text: string) => Promise<unknown>;
  listDevices: () => Promise<{ devices?: DeviceSummary[] }>;
  /**
   * Herdr sessions this daemon can address. Rejects with "unknown_op" on a
   * daemon that predates ListSessions and "unsupported" when the daemon has not
   * opted into PAIRFOB_MULTI_SESSION; both mean "no switcher here".
   */
  listHerdSessions?: () => Promise<HerdSessionSummary[]>;
  /** The Herdr session this connection targets; null is the default. */
  herdSession?: () => string | null;
  /**
   * Retarget session-scoped RPCs issued from now on. Calls already issued keep
   * their target, so callers must retire the old session's view themselves.
   */
  selectHerdSession?: (name: string | null) => void;
  revokeDevice: (deviceId: string) => Promise<unknown>;
  pushSubscribe: (subscription: PushSubscriptionJSON) => Promise<unknown>;
  renamePane: (paneId: string, label: string | null) => Promise<unknown>;
  renameTab: (tabId: string, label: string) => Promise<unknown>;
  renameWorkspace: (workspaceId: string, label: string) => Promise<unknown>;
  closePane: (paneId: string) => Promise<unknown>;
  closeTab: (tabId: string) => Promise<unknown>;
  closeWorkspace: (workspaceId: string) => Promise<unknown>;
  createConversation: (params: CreateConversationInput) => Promise<CreateConversationResult>;
  createTab: (params: CreateTabInput) => Promise<CreatedPaneResult>;
  splitPane: (params: SplitPaneInput) => Promise<CreatedPaneResult>;
  promptAgent: (params: PromptAgentInput) => Promise<PromptAgentResult>;
  history: (paneId: string, cursor?: string | null, limit?: number) => Promise<unknown>;
  agentTrace: (paneId: string, cursor?: string | null, limit?: number) => Promise<AgentTracePage>;
  agentTraceDetail: (paneId: string, detailRef: string) => Promise<AgentTraceDetail>;
  listWorktrees: (params: ListWorktreesInput) => Promise<unknown>;
  workspaceRename: (paneId: string, root: string, path: string, newName: string, size: number, modifiedMS: number, revision: string) => Promise<unknown>;
  workspaceDelete: (paneId: string, root: string, path: string, size: number, modifiedMS: number, revision: string) => Promise<unknown>;
  workspaceResolve?: (paneId: string, root: string, path: string) => Promise<WorkspaceReference>;
  workspaceOpen: (paneId: string) => Promise<WorkspaceDescriptor>;
  workspaceList: (paneId: string, path?: string, cursor?: string, limit?: number, root?: string) => Promise<WorkspaceDirectoryPage>;
  workspaceRead: (paneId: string, path: string, root?: string) => Promise<WorkspaceFile>;
  workspaceMediaOpen: (paneId: string, path: string, root?: string, options?: MediaReadOptions) => Promise<WorkspaceMediaOpen>;
  workspaceMediaRead: (handle: string, offset: number, length: number, options?: MediaReadOptions) => Promise<WorkspaceMediaChunk>;
  workspaceMediaClose: (handle: string) => Promise<WorkspaceMediaClose>;
  /** Optional attachment uploads; absent on older daemons and mocks. */
  workspaceUploadBegin?: (input: UploadBeginInput) => Promise<UploadState>;
  workspaceUploadWrite?: (input: UploadWriteInput) => Promise<UploadState>;
  workspaceUploadStatus?: (paneId: string, uploadId: string) => Promise<UploadState>;
  workspaceUploadCommit?: (paneId: string, uploadId: string) => Promise<UploadState>;
  workspaceUploadCancel?: (paneId: string, uploadId: string) => Promise<UploadState>;
  /** V2 attachment uploads (131072-byte chunks); only callable when supportsUploadV2() is true. */
  supportsUploadV2?: () => boolean;
  workspaceUploadBeginV2?: (input: UploadBeginInput) => Promise<UploadState>;
  workspaceUploadWriteV2?: (input: UploadWriteInput) => Promise<UploadState>;
  workspaceUploadStatusV2?: (paneId: string, uploadId: string) => Promise<UploadState>;
  workspaceUploadCommitV2?: (paneId: string, uploadId: string) => Promise<UploadState>;
  workspaceUploadCancelV2?: (paneId: string, uploadId: string) => Promise<UploadState>;
  gitStatus: (paneId: string) => Promise<GitStatus>;
  gitDiff: (paneId: string, path: string, layer: GitLayer) => Promise<GitDiff>;
  gitBranches: (paneId: string) => Promise<GitBranches>;
  createWorktree: (params: CreateWorktreeInput) => Promise<CreateWorktreeResult>;
  openWorktree: (params: OpenWorktreeInput) => Promise<OpenWorktreeResult>;
  resizePane: (params: ResizePaneInput) => Promise<LayoutMutationResult>;
  swapPane: (params: SwapPaneInput) => Promise<LayoutMutationResult>;
  zoomPane: (params: ZoomPaneInput) => Promise<LayoutMutationResult>;
  terminalOpen: (paneId: string, cols: number, rows: number, takeover?: boolean) => Promise<TerminalOpenResult>;
  terminalInput: (terminalId: string, sequence: number, data: Uint8Array) => Promise<unknown>;
  terminalResize: (terminalId: string, sequence: number, cols: number, rows: number, cellWidthPX?: number, cellHeightPX?: number) => Promise<unknown>;
  terminalScroll: (
    terminalId: string,
    sequence: number,
    direction: "up" | "down",
    lines: number,
    source?: "wheel" | "page_key",
    at?: { column: number; row: number },
  ) => Promise<unknown>;
  terminalClose: (terminalId: string) => Promise<unknown>;
  onEvent: (listener: (event: SessionEvent) => void) => () => void;
  isConnected: () => boolean;
  /** Existing transport is being verified or undergoing its first recovery attempt. */
  isChecking?: () => boolean;
  switchTransport: (target: "auto" | "p2p" | "relay") => Promise<void>;
  /** `path` is a real network change; `probe` is foreground/visibility only. */
  reconnectNow: (reason?: ReconnectReason) => void;
  setNetworkAvailable: (available: boolean) => void;
  close: () => void;
};

export type ReconnectReason = "probe" | "path";
