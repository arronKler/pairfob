import type {
  AgentTracePage,
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

export interface SessionEvent {
  type: "connected" | "disconnected" | "reconnecting" | "latency" | "poke" | "terminal" | "terminal_frame" | "terminal_closed";
  code?: string;
  message?: string;
  rttMs?: number;
  reason?: string;
  paneId?: string;
  terminalId?: string;
  terminalFrame?: TerminalFramePart;
  transport?: "relay" | "p2p";
}

export interface DeviceSummary {
  device_id: string;
  label?: string;
  created_at?: number;
  last_seen?: number;
  revoked_at?: number | null;
  self?: boolean;
  subscription_count?: number;
}

export type LiveSession = {
  ping: (t: number) => Promise<unknown>;
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
  revokeSelf: (deviceId: string) => Promise<unknown>;
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
  listWorktrees: (params: ListWorktreesInput) => Promise<unknown>;
  workspaceOpen: (paneId: string) => Promise<WorkspaceDescriptor>;
  workspaceList: (paneId: string, path?: string, cursor?: string, limit?: number) => Promise<WorkspaceDirectoryPage>;
  workspaceRead: (paneId: string, path: string) => Promise<WorkspaceFile>;
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
  switchTransport: (target: "auto" | "p2p" | "relay") => Promise<void>;
  /** `path` is a real network change; `probe` is foreground/visibility only. */
  reconnectNow: (reason?: ReconnectReason) => void;
  setNetworkAvailable: (available: boolean) => void;
  close: () => void;
};

export type ReconnectReason = "probe" | "path";
