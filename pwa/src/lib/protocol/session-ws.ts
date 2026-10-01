import { RecoveryDiagnostics } from "./recovery-diagnostics";
import { parseAgentInspection } from "../agent-inspect";
import { pageHidden, watchPageVisibility } from "./page-activity.ts";
import { parseAgentQuota } from "../agent-quota";
import { validDaemonId, validDeviceId } from "../identifiers.ts";
import { fingerprint16 } from "./hello.ts";
import { parseMachineLink, parseMachineList } from "./machine-link.ts";
import { ProtocolError } from "./errors.ts";
import {
  parseCreateConversationResult,
  parseCreateTabResult,
  parseCreateWorktreeResult,
  parseOpenWorktreeResult,
  parsePromptAgentResult,
  parseResizePaneResult,
  parseSplitPaneResult,
  parseSwapPaneResult,
  parseZoomPaneResult,
  advertisesUploadV2,
  fitOperationPrompt,
  withOperationID,
  type CreateConversationInput,
  type CreateConversationResult,
  type CreateWorktreeResult,
  type CreateWorktreeInput,
  type CreatedPaneResult,
  type CreateTabInput,
  type ListWorktreesInput,
  type LayoutMutationResult,
  type OpenWorktreeResult,
  type PromptAgentResult,
  type AgentTracePage,
  type AgentTraceDetail,
  type PromptAgentInput,
  type OpenWorktreeInput,
  type ResizePaneInput,
  type SplitPaneInput,
  type SwapPaneInput,
  type ZoomPaneInput,
} from "../operations.ts";
import {
  parseUploadState,
  parseUploadStateV2,
  type UploadBeginInput,
  type UploadState,
  type UploadWriteInput,
} from "./attachments.ts";
import { relayOrigin } from "./frame-socket.ts";
import type { PairResult } from "./pair-ws.ts";
import { reconnectDelay } from "./reconnect-policy.ts";
import { parseNetworkMode, type NetworkMode } from "../network-mode.ts";
import { DirectSessionDriver, type P2PAttemptObservation } from "./session-direct.ts";
import { connectSession } from "./session-connect.ts";
import { RelayWarmup } from "./relay-warmup.ts";
import { isRecord } from "./session-message.ts";
import {
  MEDIA_OPEN_RPC_TIMEOUT_MS,
  MUTATION_RPC_TIMEOUT_MS,
  SessionTransport,
  TERMINAL_RPC_TIMEOUT_MS,
} from "./session-transport.ts";
import type { DeviceSummary, LiveSession, ReconnectReason, SessionEvent } from "./session-types.ts";
import {
  parseGitBranches,
  parseGitDiff,
  parseGitStatus,
  parseWorkspaceDescriptor,
  parseWorkspaceDirectory,
  parseWorkspaceFile,
  parseWorkspaceMutation,
  type GitLayer,
} from "../workspace.ts";
import {
  parseWorkspaceMediaChunk,
  parseWorkspaceMediaClose,
  parseWorkspaceMediaOpen,
} from "./workspace-media.ts";
import { TransportSwitchBarrier, type TransportSwitchLease } from "./transport-switch.ts";
import {
  isUploadMutation,
  UploadReadinessGate,
  UPLOAD_READINESS_MAX_CONCURRENT_WAITS,
  UPLOAD_READINESS_WAIT_MS,
} from "./session-upload-readiness.ts";
import {
  encodeTerminalInput,
  parseTerminalCloseResult,
  parseTerminalCommandResult,
  parseTerminalOpenResult,
  type TerminalOpenResult,
} from "./terminal.ts";
import { AgentTraceRPC } from "./agent-trace.ts";

export { validateSessionMessage } from "./session-message.ts";
export { validateSessionEstablished } from "./session-handshake.ts";
export {
  MEDIA_OPEN_RPC_TIMEOUT_MS,
  MUTATION_RPC_TIMEOUT_MS,
  READ_RPC_TIMEOUT_MS,
  TERMINAL_RPC_TIMEOUT_MS,
  validateEstablishedFWD,
} from "./session-transport.ts";

const TERMINAL_CODES = new Set(["revoked", "unpaired", "too_many_devices", "bad_proof", "bad_signature"]);
const UNCERTAIN_MUTATION_TRANSPORT_CODES = new Set(["timeout", "disconnected", "heartbeat_timeout", "daemon_replaced"]);

export type { FinishedP2PAttemptObservation, P2PAttemptObservation } from "./session-direct.ts";

export type SessionOptions = {
  p2p?: boolean;
  networkMode?: NetworkMode;
  onP2PAttempt?: (observation: P2PAttemptObservation) => void;
};

/** Run one mutation transport attempt and preserve whether its encrypted frame was sent. */
export async function trackMutationDelivery<T>(runOnce: (markSent: () => void) => Promise<T>): Promise<T> {
  let sent = false;
  try {
    return await runOnce(() => { sent = true; });
  } catch (error) {
    if (sent && error instanceof ProtocolError && UNCERTAIN_MUTATION_TRANSPORT_CODES.has(error.code)) {
      throw new ProtocolError("unknown_outcome", "连接在确认结果前中断；操作可能已经执行。请先刷新确认，不要立即重试。");
    }
    throw error;
  }
}

class ReconnectingSession implements LiveSession {
  private readonly recovery = new RecoveryDiagnostics();
  connectionRecovery = this.recovery.context;
  private transport: SessionTransport | null = null;
  private listeners = new Set<(event: SessionEvent) => void>();
  private stopped = false;
  private checking = false;
  private reconnecting = false;
  private reconnectRequested = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectAbort: AbortController | null = null;
  private networkMode: NetworkMode = "auto";
  private networkAvailable = true;
  private attempt = 0;
  private lastRttMs: number | null = null;
  private lastTransport: "relay" | "p2p" = "relay";
  private readonly transportSwitch = new TransportSwitchBarrier();
  private deferredDisconnect: ProtocolError | null = null;
  private readonly direct: DirectSessionDriver;
  private readonly relayWarmup: RelayWarmup;
  private unwatchVisibility: () => void = () => undefined;
  private readonly agentTraceRPC = new AgentTraceRPC((op, params) => this.readRPC(op, params));
  // upload_file_v2 is learned ONLY from a successful GetConfig and cleared on
  // every transport-epoch loss (disconnect, transport switch, close). Method
  // presence never implies the capability. configRequest is a monotonic token,
  // bumped at every GetConfig start and every epoch loss, so a stale reply can
  // never install a capability over a newer request or newer transport epoch.
  private uploadV2 = false;
  private configRequest = 0;
  // Bumped synchronously at every switch begin, so an upload paused in a probe
  // wait is invalidated even by a switch that fails and returns the same
  // transport object (it is never sent on a switch in progress).
  private switchGeneration = 0;
  private readonly uploadReadiness = new UploadReadinessGate(
    UPLOAD_READINESS_MAX_CONCURRENT_WAITS,
    UPLOAD_READINESS_WAIT_MS,
  );

  private constructor(
    private readonly relayWS: string,
    private readonly pair: PairResult,
    private readonly options: SessionOptions,
  ) {
    this.networkMode = parseNetworkMode(options.networkMode);
    this.relayWarmup = new RelayWarmup(relayWS, () => this.recovery.current);
    const session = this;
    this.direct = new DirectSessionDriver({
      pair: this.pair,
      prepareRelay: () => this.relayWarmup.start(),
      cancelPreparedRelay: () => this.relayWarmup.cancel(),
      relayWS: this.relayWS,
      options: this.options,
      get stopped() { return session.stopped; },
      get networkAvailable() { return session.networkAvailable; },
      get networkMode() { return session.networkMode; },
      getTransport: () => session.transport,
      setTransport: (transport) => {
        transport.recoveryDiagnostic = session.recovery.context();
        session.transport = transport;
        session.uploadV2 = false;
        session.configRequest++;
      },
      beginSwitch: () => session.beginSwitch(),
      ownsSwitch: (lease) => session.transportSwitch.owns(lease),
      endSwitch: (lease) => session.endSwitch(lease),
      emit: (event) => session.emit(event),
      observe: (observation) => session.observeDirectAttempt(observation),
      onDisconnect: (source, error) => session.onDisconnect(source, error),
      finishDisconnect: (error) => session.finishDisconnect(error),
      takeDeferredDisconnect: () => {
        const deferred = session.deferredDisconnect;
        session.deferredDisconnect = null;
        return deferred;
      },
      peekDeferredDisconnect: () => session.deferredDisconnect,
    });
    this.unwatchVisibility = watchPageVisibility((hidden) => {
      this.direct.setPageHidden(hidden);
      if (hidden) { this.relayWarmup.cancel(); this.recovery.cancel(); }
      if (hidden && this.transport) {
        // Hidden pages never run the probe: reject paused uploads visibly
        // instead of holding them until the deadline.
        this.uploadReadiness.failAll(new ProtocolError("disconnected", "页面已隐藏，连接暂停，本次上传操作未发送；返回页面后可继续"));
        this.emit({ type: "checking" });
      }
      if (hidden && this.reconnectTimer !== null) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      if (!hidden) this.reconnectNow("probe");
    });
  }

  static async create(relayWS: string, pair: PairResult, options: SessionOptions): Promise<ReconnectingSession> {
    const session = new ReconnectingSession(relayWS, pair, options);
    try {
      await session.connect();
      return session;
    } catch (error) {
      session.close();
      throw error;
    }
  }

  isConnected = (): boolean => this.transport !== null && !this.checking;
  isChecking = (): boolean => this.checking && !this.stopped;
  switchTransport = async (target: NetworkMode): Promise<void> => {
    this.networkMode = target;
    await this.direct.switchTransport(target);
  };
  reconnectNow = (reason: ReconnectReason = "probe"): void => {
    if (this.stopped || !this.networkAvailable) return;
    if (!pageHidden()) this.recovery.start();
    if (this.transport) this.transport.recoveryDiagnostic = this.recovery.context();
    this.direct.resetBackoff();
    if (this.transport) {
      this.direct.probe(this.transport, reason);
      return;
    }
    if (this.reconnecting || this.connectAbort) {
      this.reconnectRequested = true;
      return;
    }
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.scheduleReconnect(true);
  };
  setNetworkAvailable = (available: boolean): void => {
    if (this.stopped || this.networkAvailable === available) return;
    this.networkAvailable = available;
    if (available) {
      this.reconnectNow("path");
      return;
    }
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.uploadReadiness.failAll(new ProtocolError("disconnected", "手机网络已断开，本次上传操作未发送；网络恢复后可继续"));
    this.direct.dispose();
    this.relayWarmup.cancel();
    this.connectAbort?.abort();
    const transport = this.transport;
    if (transport) transport.suspend(new ProtocolError("disconnected", "手机网络已断开"));
    else if (!this.reconnecting) this.emit({ type: "disconnected", code: "disconnected", message: "手机网络已断开" });
  };
  onEvent = (listener: (event: SessionEvent) => void): (() => void) => {
    this.listeners.add(listener);
    if (this.lastRttMs !== null) listener({ type: "latency", rttMs: this.lastRttMs, transport: this.lastTransport });
    return () => this.listeners.delete(listener);
  };
  ping = (t: number) => this.readRPC("Ping", { t_ms: t });
  agentInspect = async (paneId: string) => parseAgentInspection(await this.readRPC("AgentInspect", { pane_id: paneId }));
  agentQuota = async () => parseAgentQuota(await this.readRPC("AgentQuota", {}, 12_000));
  daemonUpdateStatus = () => this.readRPC("DaemonUpdateStatus", {});
  daemonUpdate = (target: string) => this.trackedMutation("DaemonUpdate", { target });
  listMachines = async () => parseMachineList(await this.readRPC("ListMachines", {}, 12_000));
  linkMachineStatus = async () => parseMachineLink(await this.readRPC("LinkMachineStatus", {}));
  linkMachine = async (machineId: string, install: boolean) =>
    parseMachineLink(await this.trackedMutation("LinkMachine", { machine_id: machineId, install }));
  linkMachineCancel = async (operationId: string) =>
    parseMachineLink(await this.readRPC("LinkMachineCancel", { operation_id: operationId }));
  getConfig = async (): Promise<Record<string, unknown>> => {
    const requestToken = ++this.configRequest;
    // Fail closed from the instant a refresh starts: the capability is only
    // restored by a valid reply that is still the latest request on the same
    // transport epoch.
    this.uploadV2 = false;
    const transport = await this.captureTransport();
    if (!transport) throw new ProtocolError("reconnecting", "连接正在恢复");
    try {
      const result = await transport.rpc("GetConfig", {}) as Record<string, unknown>;
      if (
        requestToken === this.configRequest &&
        transport === this.transport &&
        !this.stopped &&
        !this.checking
      ) {
        this.uploadV2 = advertisesUploadV2(result);
      }
      // Guard failure assigns nothing: a newer result/epoch must survive.
      return result;
    } catch (error) {
      // A rejected LATEST request fails closed; a stale request's failure does
      // nothing so it can never clobber a newer request's installed result.
      if (requestToken === this.configRequest) this.uploadV2 = false;
      throw error;
    }
  };
  snapshot = () => this.readRPC("Snapshot", { session: null }) as Promise<Record<string, unknown>>;
  paneRead = (paneId: string, lines = 80, format: "ansi" | "text" = "ansi") =>
    this.readRPC("PaneRead", { pane_id: paneId, source: "visible", format, lines }) as Promise<{ text: string; truncated?: boolean; hash?: string }>;
  sendText = (paneId: string, text: string) => {
    if (fitOperationPrompt(text).truncated) return Promise.reject(new ProtocolError("too_large", "text exceeds 32 KiB"));
    return this.trackedMutation("SendText", { pane_id: paneId, text, submit: false });
  };
  sendKeys = (paneId: string, keys: string[], extra?: { intent?: "pad" | "dialog" | "submit"; expected_prompt?: string; expected_signature?: string }) =>
    this.trackedMutation("SendKeys", {
      pane_id: paneId,
      keys,
      intent: extra?.intent ?? "pad",
      ...(extra?.expected_prompt ? { expected_prompt: extra.expected_prompt } : {}),
      ...(extra?.expected_signature ? { expected_signature: extra.expected_signature } : {}),
    });
  listDevices = () => this.readRPC("ListDevices", {}) as Promise<{ devices?: DeviceSummary[] }>;
  revokeDevice = (deviceId: string) => this.trackedMutation("RevokeDevice", { device_id: deviceId });
  pushSubscribe = (subscription: PushSubscriptionJSON) => {
    const keys = subscription.keys || {};
    return this.trackedMutation("PushSubscribe", {
      endpoint: subscription.endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      expirationTime: subscription.expirationTime ?? null,
    });
  };
  renamePane = (paneId: string, label: string | null) => this.trackedMutation("RenamePane", { pane_id: paneId, label });
  renameTab = (tabId: string, label: string) => this.trackedMutation("RenameTab", { tab_id: tabId, label });
  renameWorkspace = (workspaceId: string, label: string) => this.trackedMutation("RenameWorkspace", { workspace_id: workspaceId, label });
  closePane = (paneId: string) => this.trackedMutation("ClosePane", { pane_id: paneId });
  closeTab = (tabId: string) => this.trackedMutation("CloseTab", { tab_id: tabId });
  closeWorkspace = (workspaceId: string) => this.trackedMutation("CloseWorkspace", { workspace_id: workspaceId });
  createConversation = (params: CreateConversationInput): Promise<CreateConversationResult> =>
    this.parsedMutation("CreateConversation", params, parseCreateConversationResult);
  createTab = (params: CreateTabInput): Promise<CreatedPaneResult> =>
    this.parsedMutation("CreateTab", params, parseCreateTabResult);
  splitPane = (params: SplitPaneInput): Promise<CreatedPaneResult> =>
    this.parsedMutation("SplitPane", params, parseSplitPaneResult);
  promptAgent = (params: PromptAgentInput): Promise<PromptAgentResult> => {
    if (fitOperationPrompt(params.text).truncated) return Promise.reject(new ProtocolError("too_large", "agent prompt exceeds 32 KiB"));
    return this.parsedMutation("PromptAgent", params, parsePromptAgentResult);
  };
  history = (paneId: string, cursor: string | null = null, limit = 50) =>
    this.readRPC("History", { pane_id: paneId, cursor, limit });
  agentTrace = async (paneId: string, cursor: string | null = null, limit = 50): Promise<AgentTracePage> =>
    this.agentTraceRPC.read(paneId, cursor, limit);
  agentTraceDetail = async (paneId: string, detailRef: string): Promise<AgentTraceDetail> =>
    this.agentTraceRPC.detail(paneId, detailRef);
  listWorktrees = (params: ListWorktreesInput) => this.readRPC("ListWorktrees", params);
  workspaceRename = (paneId: string, root: string, path: string, newName: string, size: number, modifiedMS: number, revision: string) =>
    this.parsedMutation("WorkspaceRename", { pane_id: paneId, root, path, new_name: newName, size, modified_ms: modifiedMS, revision }, parseWorkspaceMutation);
  workspaceDelete = (paneId: string, root: string, path: string, size: number, modifiedMS: number, revision: string) =>
    this.parsedMutation("WorkspaceDelete", { pane_id: paneId, root, path, size, modified_ms: modifiedMS, revision }, parseWorkspaceMutation);
  workspaceOpen = async (paneId: string) => parseWorkspaceDescriptor(await this.readRPC("WorkspaceOpen", { pane_id: paneId }));
  workspaceList = async (paneId: string, path = "", cursor = "", limit = 120) =>
    parseWorkspaceDirectory(await this.readRPC("WorkspaceList", { pane_id: paneId, path, cursor, limit }));
  workspaceRead = async (paneId: string, path: string) =>
    parseWorkspaceFile(await this.readRPC("WorkspaceRead", { pane_id: paneId, path }));
  workspaceMediaOpen = async (paneId: string, path: string) => {
    const transport = await this.captureTransport();
    if (!transport) return Promise.reject(new ProtocolError("reconnecting", "连接正在恢复"));
    return parseWorkspaceMediaOpen(await transport.rpc(
      "WorkspaceMediaOpen",
      { pane_id: paneId, path },
      MEDIA_OPEN_RPC_TIMEOUT_MS,
      undefined,
      (result) => {
        // Close on the SAME epoch that performed the Open — never re-capture the
        // current transport (a P2P commit may have moved this session to a new
        // direct transport; closing on it would send WorkspaceMediaClose to the
        // wrong epoch). If the Open epoch is already retired this Close fails on
        // send; the orphaned remote handle is then reclaimed authoritatively by
        // the daemon's own media handle lease (idle/absolute timer) or that
        // session's teardown — never by any client assumption. A session can
        // survive a P2P switch, so this does not rely on the old epoch being torn
        // down on send.
        if (!isRecord(result) || typeof result.handle !== "string") return;
        if (!/^media_[0-9a-f]{32}$/u.test(result.handle)) return;
        const handle = result.handle;
        void transport.rpc("WorkspaceMediaClose", { handle }).catch(() => undefined);
      },
    ));
  };
  workspaceMediaRead = async (handle: string, offset: number, length: number) =>
    parseWorkspaceMediaChunk(await this.readRPC("WorkspaceMediaRead", { handle, offset, length }));
  workspaceMediaClose = async (handle: string) =>
    parseWorkspaceMediaClose(await this.readRPC("WorkspaceMediaClose", { handle }));
  workspaceUploadBegin = async (input: UploadBeginInput): Promise<UploadState> =>
    parseUploadState(await this.mutationRPC("WorkspaceUploadBegin", withOperationID(input)), input.upload_id);
  workspaceUploadWrite = async (input: UploadWriteInput): Promise<UploadState> =>
    parseUploadState(await this.mutationRPC("WorkspaceUploadWrite", withOperationID(input)), input.upload_id);
  workspaceUploadStatus = async (paneId: string, uploadId: string): Promise<UploadState> =>
    parseUploadState(await this.readRPC("WorkspaceUploadStatus", { pane_id: paneId, upload_id: uploadId }), uploadId);
  workspaceUploadCommit = async (paneId: string, uploadId: string): Promise<UploadState> =>
    parseUploadState(await this.mutationRPC("WorkspaceUploadCommit", withOperationID({ pane_id: paneId, upload_id: uploadId })), uploadId);
  workspaceUploadCancel = async (paneId: string, uploadId: string): Promise<UploadState> =>
    parseUploadState(await this.mutationRPC("WorkspaceUploadCancel", withOperationID({ pane_id: paneId, upload_id: uploadId })), uploadId);
  supportsUploadV2 = (): boolean => !this.stopped && !this.checking && this.uploadV2;
  workspaceUploadBeginV2 = async (input: UploadBeginInput): Promise<UploadState> =>
    parseUploadStateV2(await this.mutationRPC("WorkspaceUploadBeginV2", withOperationID(input)), input.upload_id);
  workspaceUploadWriteV2 = async (input: UploadWriteInput): Promise<UploadState> =>
    parseUploadStateV2(await this.mutationRPC("WorkspaceUploadWriteV2", withOperationID(input)), input.upload_id);
  workspaceUploadStatusV2 = async (paneId: string, uploadId: string): Promise<UploadState> =>
    parseUploadStateV2(await this.readRPC("WorkspaceUploadStatusV2", { pane_id: paneId, upload_id: uploadId }), uploadId);
  workspaceUploadCommitV2 = async (paneId: string, uploadId: string): Promise<UploadState> =>
    parseUploadStateV2(await this.mutationRPC("WorkspaceUploadCommitV2", withOperationID({ pane_id: paneId, upload_id: uploadId })), uploadId);
  workspaceUploadCancelV2 = async (paneId: string, uploadId: string): Promise<UploadState> =>
    parseUploadStateV2(await this.mutationRPC("WorkspaceUploadCancelV2", withOperationID({ pane_id: paneId, upload_id: uploadId })), uploadId);
  gitStatus = async (paneId: string) => parseGitStatus(await this.readRPC("GitStatus", { pane_id: paneId }));
  gitDiff = async (paneId: string, path: string, layer: GitLayer) =>
    parseGitDiff(await this.readRPC("GitDiff", { pane_id: paneId, path, layer }));
  gitBranches = async (paneId: string) => parseGitBranches(await this.readRPC("GitBranches", { pane_id: paneId }));
  createWorktree = (params: CreateWorktreeInput): Promise<CreateWorktreeResult> =>
    this.parsedMutation("CreateWorktree", params, parseCreateWorktreeResult);
  openWorktree = (params: OpenWorktreeInput): Promise<OpenWorktreeResult> =>
    this.parsedMutation("OpenWorktree", params, parseOpenWorktreeResult);
  resizePane = (params: ResizePaneInput): Promise<LayoutMutationResult> =>
    this.parsedMutation("ResizePane", params, parseResizePaneResult);
  swapPane = (params: SwapPaneInput): Promise<LayoutMutationResult> =>
    this.parsedMutation("SwapPane", params, parseSwapPaneResult);
  zoomPane = (params: ZoomPaneInput): Promise<LayoutMutationResult> =>
    this.parsedMutation("ZoomPane", params, parseZoomPaneResult);
  terminalOpen = async (paneId: string, cols: number, rows: number, takeover = false): Promise<TerminalOpenResult> => {
    const wire = withOperationID({ pane_id: paneId, cols, rows, takeover });
    return parseTerminalOpenResult(await this.terminalRPC("TerminalOpen", wire), paneId, wire.operation_id);
  };
  terminalInput = (terminalId: string, sequence: number, data: Uint8Array) =>
    this.terminalCommand("TerminalInput", terminalId, sequence, { data: encodeTerminalInput(data) });
  terminalResize = (terminalId: string, sequence: number, cols: number, rows: number, cellWidthPX = 0, cellHeightPX = 0) =>
    this.terminalCommand("TerminalResize", terminalId, sequence, {
      cols, rows, cell_width_px: cellWidthPX, cell_height_px: cellHeightPX,
    });
  terminalScroll = (
    terminalId: string,
    sequence: number,
    direction: "up" | "down",
    lines: number,
    source: "wheel" | "page_key" = "wheel",
    at?: { column: number; row: number },
  ) =>
    this.terminalCommand("TerminalScroll", terminalId, sequence, {
      direction,
      lines,
      source,
      modifiers: 0,
      ...(at ? { column: at.column, row: at.row } : {}),
    });
  terminalClose = async (terminalId: string): Promise<void> => {
    const wire = withOperationID({ terminal_id: terminalId });
    parseTerminalCloseResult(await this.terminalRPC("TerminalClose", wire), wire.operation_id, terminalId);
  };

  close = (): void => {
    this.recovery.cancel();
    this.unwatchVisibility();
    this.stopped = true;
    // close() publishes no public event: settle paused uploads promptly here
    // so their callers never wait for the 8 s deadline after close.
    this.uploadReadiness.failAll(new ProtocolError("disconnected", "会话已关闭，本次上传操作未发送"));
    this.uploadV2 = false;
    this.configRequest++;
    this.reconnectRequested = false;
    this.relayWarmup.cancel();
    this.connectAbort?.abort();
    this.connectAbort = null;
    this.direct.dispose();
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.transport?.close();
    this.transport = null;
  };

  private async readRPC(op: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const transport = await this.captureTransport();
    if (!transport) return Promise.reject(new ProtocolError("reconnecting", "连接正在恢复"));
    return transport.rpc(op, params, timeoutMs);
  }

  /** Capture one transport; mutation RPCs are never replayed on another socket. */
  private async mutationRPC(op: string, params: unknown): Promise<unknown> {
    if (!isUploadMutation(op)) {
      const transport = this.checking ? null : await this.captureTransport();
      if (!transport || this.checking) return Promise.reject(new ProtocolError("disconnected", "连接已断开；为避免重复输入，本次操作未发送"));
      return trackMutationDelivery((markSent) => transport.rpc(op, params, MUTATION_RPC_TIMEOUT_MS, markSent));
    }
    // Upload mutation: pause UNSENT work while a probe verifies the captured
    // live epoch. The transport and switch generation are snapshotted BEFORE
    // any wait; the call rides this one epoch or is rejected visibly — never
    // migrated, never replayed, and no new upload is started automatically.
    const captured = { transport: this.transport, generation: this.switchGeneration };
    const check = (): boolean | Error => {
      const verdict = this.uploadReadinessVerdict(captured, !op.startsWith("WorkspaceUploadCancel"));
      if (verdict === null) return false;
      return verdict.ok ? true : verdict.error;
    };
    await this.uploadReadiness.wait(check);
    // Final synchronous identity/readiness gate on the original epoch.
    const verdict = this.uploadReadinessVerdict(captured, !op.startsWith("WorkspaceUploadCancel"));
    if (verdict === null || !verdict.ok) {
      throw verdict?.error ?? new ProtocolError("reconnecting", "连接正在恢复，本次上传操作未发送");
    }
    // The original operation_id in params is retained; delivery tracking wraps
    // exactly this single dispatch (wait-before-first-send is not a retry).
    const transport = verdict.transport;
    return trackMutationDelivery((markSent) => transport.rpc(op, params, MUTATION_RPC_TIMEOUT_MS, markSent));
  }

  /**
   * Whether a paused upload mutation may dispatch on its captured epoch.
   * null: still checking the same epoch (keep waiting); Error: the unsent
   * mutation must be rejected; ok: the exact same transport is live again.
   */
  private uploadReadinessVerdict(captured: { transport: SessionTransport | null; generation: number }, requireDirect: boolean):
    { ok: true; transport: SessionTransport } | { ok: false; error: ProtocolError } | null {
    if (this.stopped) {
      return { ok: false, error: new ProtocolError("disconnected", "会话已关闭，本次上传操作未发送") };
    }
    if (!this.networkAvailable) {
      return { ok: false, error: new ProtocolError("disconnected", "手机网络已断开，本次上传操作未发送；网络恢复后可继续") };
    }
    if (pageHidden()) {
      return { ok: false, error: new ProtocolError("disconnected", "页面已隐藏，连接暂停，本次上传操作未发送；返回页面后可继续") };
    }
    // Any begin of a switch invalidates the wait, including a failed switch
    // that ends with the identical transport object; an active barrier is the
    // same case one tick earlier.
    if (this.switchGeneration !== captured.generation || this.transportSwitch.wait()) {
      return { ok: false, error: new ProtocolError("disconnected", "连接正在切换，本次上传操作未发送；请刷新确认后继续") };
    }
    if (captured.transport === null || this.transport !== captured.transport) {
      return { ok: false, error: new ProtocolError("disconnected", "连接已恢复到新的会话，本次上传操作未发送；请刷新确认后继续") };
    }
    // Status and cancellation remain available for reconciliation/cleanup.
    // Begin, file bytes and commit must never use the relay.
    if (requireDirect && captured.transport.kind !== "p2p") {
      return { ok: false, error: new ProtocolError("disconnected", "文件上传仅支持 P2P 直连；请在设置中切换到 P2P，连接成功后手动重试或续传") };
    }
    if (this.checking) return null;
    return { ok: true, transport: captured.transport };
  }

  private async terminalRPC(op: string, params: unknown): Promise<unknown> {
    // Background cleanup releases a controller on the existing epoch once.
    // Input/open/resize remain blocked until the connection is confirmed.
    const cleanup = op === "TerminalClose";
    const transport = this.checking && !cleanup ? null : await this.captureTransport();
    if (!transport || (this.checking && !cleanup)) return Promise.reject(new ProtocolError("disconnected", "连接已断开；本次终端操作未发送"));
    return trackMutationDelivery((markSent) => transport.rpc(op, params, TERMINAL_RPC_TIMEOUT_MS, markSent));
  }

  private async captureTransport(): Promise<SessionTransport | null> {
    while (this.transportSwitch.wait()) await this.transportSwitch.wait();
    return this.transport;
  }

  private async trackedMutation(op: string, params: object): Promise<unknown> {
    const wire = withOperationID(params);
    const result = await this.mutationRPC(op, wire);
    if (!isRecord(result) || result.operation_id !== wire.operation_id) {
      throw new ProtocolError("bad_message", `${op} 响应 operation_id 不匹配`);
    }
    return result;
  }

  private async terminalCommand(op: string, terminalId: string, sequence: number, params: object): Promise<unknown> {
    const wire = withOperationID({ terminal_id: terminalId, seq: sequence, ...params });
    return parseTerminalCommandResult(await this.terminalRPC(op, wire), wire.operation_id, terminalId, sequence);
  }

  private async parsedMutation<T>(
    op: string,
    params: object,
    parse: (value: unknown, expectedOperationID: string) => T,
  ): Promise<T> {
    const wire = withOperationID(params);
    return parse(await this.mutationRPC(op, wire), wire.operation_id);
  }

  private emit(event: SessionEvent): void {
    if (event.type === "checking") {
      if (this.checking) return;
      this.checking = true;
    } else if (event.type === "connected") {
      this.checking = pageHidden();
      if (!this.checking) this.recovery.ready();
    }
    if (event.type === "latency" && typeof event.rttMs === "number") {
      this.lastRttMs = event.rttMs;
      this.lastTransport = event.transport ?? this.lastTransport;
    }
    for (const listener of this.listeners) listener(event);
    // Paused uploads re-evaluate on connection-state events. Data events
    // (poke/terminal frames/latency) never change the verdict.
    if (
      event.type === "checking"
      || event.type === "connected"
      || event.type === "disconnected"
      || event.type === "reconnecting"
      || event.type === "terminal"
    ) {
      this.uploadReadiness.pulse();
    }
  }

  private observeDirectAttempt(observation: P2PAttemptObservation): void {
    try {
      this.options.onP2PAttempt?.(observation);
    } catch {
      // Diagnostics must never affect the transport state machine.
    }
  }

  private async connect(): Promise<void> {
    if (!pageHidden()) this.recovery.start();
    const controller = new AbortController();
    this.connectAbort = controller;
    let transport: SessionTransport;
    try {
      transport = await connectSession(this.relayWS, this.pair, (event) => this.emit(event), controller.signal, this.relayWarmup, this.recovery.current);
    } finally {
      if (this.connectAbort === controller) this.connectAbort = null;
    }
    if (this.stopped || !this.networkAvailable) {
      transport.close();
      return;
    }
    transport.recoveryDiagnostic = this.recovery.context();
    this.transport = transport;
    this.attempt = 0;
    transport.onDisconnect((error) => this.onDisconnect(transport, error));
    if (this.transport !== transport) return;
    this.emit({ type: "connected" });
    this.direct.onRelayReady(transport);
  }

  private onDisconnect(source: SessionTransport, error: ProtocolError): void {
    if (this.stopped || this.transport !== source) return;
    if (this.transportSwitch.wait()) {
      this.deferredDisconnect = error;
      return;
    }
    if (source.kind === "relay") this.direct.dispose();
    this.finishDisconnect(error);
  }

  private finishDisconnect(error: ProtocolError): void {
    this.transport = null;
    this.uploadV2 = false;
    this.configRequest++;
    this.direct.dispose();
    if (TERMINAL_CODES.has(error.code) || error.code === "kicked") {
      this.stopped = true;
      this.relayWarmup.cancel();
      this.unwatchVisibility();
      this.emit({ type: "terminal", code: error.code, message: error.message });
      return;
    }
    this.checking = true;
    this.emit({ type: "disconnected", code: error.code, message: error.message });
    // A healthy session gets one immediate recovery attempt. Only failed
    // reconnects enter the jittered exponential backoff below.
    this.scheduleReconnect(true);
  }

  private beginSwitch(): TransportSwitchLease {
    const lease = this.transportSwitch.begin();
    this.switchGeneration += 1;
    // A switch can replace or (on failure) keep the transport; either way an
    // unsent upload must not ride it. The checkpoint stays with the caller for
    // an explicit resume; nothing is auto-restarted.
    this.uploadReadiness.failAll(new ProtocolError("disconnected", "连接正在切换，本次上传操作未发送；请刷新确认后继续"));
    this.deferredDisconnect = null;
    this.uploadV2 = false;
    this.configRequest++;
    return lease;
  }

  private endSwitch(lease: TransportSwitchLease): boolean {
    return this.transportSwitch.end(lease);
  }

  private scheduleReconnect(immediate = false): void {
    if (this.stopped || !this.networkAvailable || pageHidden() || this.reconnecting || this.reconnectTimer !== null) return;
    const delay = immediate ? 0 : reconnectDelay(this.attempt++);
    this.emit({ type: "reconnecting", message: immediate ? "正在重新连接" : `${Math.ceil(delay / 1000)} 秒后重连` });
    this.reconnectTimer = globalThis.setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.stopped || !this.networkAvailable || pageHidden()) return;
      this.reconnecting = true;
      this.reconnectRequested = false;
      try {
        await this.connect();
      } catch (error) {
        if (this.stopped || !this.networkAvailable) return;
        const protocolError = error instanceof ProtocolError ? error : new ProtocolError("disconnected", String(error));
        if (TERMINAL_CODES.has(protocolError.code)) {
          this.stopped = true;
          this.unwatchVisibility();
          this.emit({ type: "terminal", code: protocolError.code, message: protocolError.message });
        } else if (!this.reconnectRequested) {
          this.checking = false;
          this.emit({ type: "disconnected", code: protocolError.code, message: protocolError.message });
        }
      } finally {
        this.reconnecting = false;
        const immediate = this.reconnectRequested;
        this.reconnectRequested = false;
        if (!this.stopped && !this.transport) this.scheduleReconnect(immediate);
      }
    }, delay);
  }
}

export async function sessionOverWS(relayWS: string, pair: PairResult, options: SessionOptions = {}): Promise<LiveSession> {
  if (pair.psk.length !== 32 || pair.daemonPk.length !== 32 || !validDaemonId(pair.daemonId) || !validDeviceId(pair.deviceId)) throw new ProtocolError("invalid_credential", "本机凭证不完整或标识非法");
  if (pair.relayOrigin !== relayOrigin(relayWS)) throw new ProtocolError("bad_relay", "凭证不属于当前 relay");
  if (pair.fp !== fingerprint16(pair.daemonPk)) throw new ProtocolError("fp_mismatch", "已存 daemon 指纹不匹配");
  return ReconnectingSession.create(relayWS, pair, options);
}

export type { DeviceSummary, LiveSession, SessionEvent } from "./session-types.ts";
