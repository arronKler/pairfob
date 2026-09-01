import { validDaemonId, validDeviceId } from "../identifiers.ts";
import { jsonFrame, Typ } from "./envelope.ts";
import { fingerprint16 } from "./hello.ts";
import { ProtocolError } from "./errors.ts";
import {
  parseCreateConversationResult,
  parseCreateTabResult,
  parseCreateWorktreeResult,
  parseOpenWorktreeResult,
  parseAgentTracePage,
  parsePromptAgentResult,
  parseResizePaneResult,
  parseSplitPaneResult,
  parseSwapPaneResult,
  parseZoomPaneResult,
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
  type PromptAgentInput,
  type OpenWorktreeInput,
  type ResizePaneInput,
  type SplitPaneInput,
  type SwapPaneInput,
  type ZoomPaneInput,
} from "../operations.ts";
import {
  envelopeError,
  openWS,
  relayOrigin,
  send,
  Z16,
} from "./frame-socket.ts";
import { helloClientBody, muxProtocolFromRelayURL, muxSubprotocol, sessionAttachBody, type MuxProtocol } from "./mux.ts";
import type { PairResult } from "./pair-ws.ts";
import { reconnectDelay } from "./reconnect-policy.ts";
import { parseNetworkMode, type NetworkMode } from "../network-mode.ts";
import { directRetryDelay } from "./direct-retry-policy.ts";
import { establishSessionEpoch } from "./session-handshake.ts";
import { isRecord } from "./session-message.ts";
import {
  MUTATION_RPC_TIMEOUT_MS,
  SessionTransport,
  TERMINAL_RPC_TIMEOUT_MS,
} from "./session-transport.ts";
import { commitDirectSession, prepareDirectSession } from "./session-upgrade.ts";
import type { DeviceSummary, LiveSession, SessionEvent } from "./session-types.ts";
import {
  encodeTerminalInput,
  parseTerminalCloseResult,
  parseTerminalCommandResult,
  parseTerminalOpenResult,
  type TerminalOpenResult,
} from "./terminal.ts";

export { validateSessionMessage } from "./session-message.ts";
export { validateSessionEstablished } from "./session-handshake.ts";
export {
  MUTATION_RPC_TIMEOUT_MS,
  READ_RPC_TIMEOUT_MS,
  TERMINAL_RPC_TIMEOUT_MS,
  validateEstablishedFWD,
} from "./session-transport.ts";

async function connectSession(
  relayWS: string,
  pair: PairResult,
  emit: (event: SessionEvent) => void,
  signal?: AbortSignal,
): Promise<SessionTransport> {
  const protocol = muxProtocolFromRelayURL(relayWS);
  const socket = await openWS(relayWS, muxSubprotocol(protocol), signal);
  const abort = () => socket.ws.close(1000, "connection cancelled");
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) throw new ProtocolError("disconnected", "连接已取消");
    send(socket.ws, jsonFrame(Typ.HELLO_CLIENT, Z16, helloClientBody(protocol)));
    send(socket.ws, jsonFrame(Typ.SESSION_ATTACH, Z16, sessionAttachBody(protocol, pair.daemonId)));
    const bound = await socket.next(8_000);
    if (bound.typ === Typ.ERROR) throw envelopeError(bound);
    if (bound.typ !== Typ.SESSION_BOUND) throw new ProtocolError("bad_message", `预期 SESSION_BOUND，实际 ${bound.typ}`);
    const epoch = await establishSessionEpoch(socket, bound.routeId, pair, protocol);
    const transport = new SessionTransport(socket, epoch.routeId, epoch.c2s, epoch.s2c, emit);
    // The first AEAD RPC is sent only after the explicit control frame. Its
    // response is still matched by id through the normal demultiplexer.
    await transport.rpc("Ping", { t_ms: Date.now() }, 8_000);
    return transport;
  } catch (error) {
    socket.ws.close(1000, "session handshake failed");
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

const TERMINAL_CODES = new Set(["revoked", "unpaired", "too_many_devices", "bad_proof", "bad_signature"]);
const UNCERTAIN_MUTATION_TRANSPORT_CODES = new Set(["timeout", "disconnected", "heartbeat_timeout", "daemon_replaced"]);

export type SessionOptions = { p2p?: boolean; networkMode?: NetworkMode };

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
  private transport: SessionTransport | null = null;
  private listeners = new Set<(event: SessionEvent) => void>();
  private stopped = false;
  private reconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectAbort: AbortController | null = null;
  private directAbort: AbortController | null = null;
  private directAttempt: Promise<void> | null = null;
  private directRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private directRetryAttempt = 0;
  private networkMode: NetworkMode = "auto";
  private networkAvailable = true;
  private attempt = 0;
  private lastRttMs: number | null = null;
  private lastTransport: "relay" | "p2p" = "relay";
  private switchWait: Promise<void> | null = null;
  private finishSwitch: (() => void) | null = null;
  private deferredDisconnect: ProtocolError | null = null;

  private constructor(
    private readonly relayWS: string,
    private readonly pair: PairResult,
    private readonly options: SessionOptions,
  ) {
    this.networkMode = parseNetworkMode(options.networkMode);
  }

  static async create(relayWS: string, pair: PairResult, options: SessionOptions): Promise<ReconnectingSession> {
    const session = new ReconnectingSession(relayWS, pair, options);
    await session.connect();
    return session;
  }

  isConnected = (): boolean => this.transport !== null;
  switchTransport = async (target: NetworkMode): Promise<void> => {
    if (this.stopped) throw new ProtocolError("disconnected", "连接已断开");
    this.networkMode = target;
    const transport = this.transport;
    if (target === "relay") {
      this.clearDirectRetry();
      this.directAbort?.abort();
      if (transport?.kind === "p2p") {
        transport.suspend(new ProtocolError("disconnected", "正在切换到 Relay"));
      }
      return;
    }
    if (!this.options.p2p || typeof RTCPeerConnection === "undefined") {
      if (target === "p2p") throw new ProtocolError("p2p_unavailable", "当前环境不支持 P2P 直连");
      return;
    }
    if (!this.networkAvailable || !transport || transport.kind === "p2p") return;
    if (target === "auto") {
      this.startAutomaticDirectUpgrade(transport);
      return;
    }
    this.clearDirectRetry();
    try {
      await this.startDirectUpgrade(transport);
    } catch (error) {
      this.scheduleDirectRetry(transport);
      throw error;
    }
  };
  reconnectNow = (): void => {
    if (this.stopped || !this.networkAvailable) return;
    if (this.transport) {
      const transport = this.transport;
      void transport.rpc("Ping", { t_ms: Date.now() }, 8_000).then(
        () => {
          if (this.transport === transport && transport.kind === "relay") this.startAutomaticDirectUpgrade(transport);
        },
        (error) => {
          if (this.transport === transport && error instanceof ProtocolError && error.code === "timeout") {
            transport.suspend(new ProtocolError("disconnected", "前台探测失败"));
          }
        },
      );
      return;
    }
    if (this.reconnecting) return;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.scheduleReconnect(true);
  };
  setNetworkAvailable = (available: boolean): void => {
    if (this.stopped || this.networkAvailable === available) return;
    this.networkAvailable = available;
    if (available) {
      this.reconnectNow();
      return;
    }
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearDirectRetry();
    this.connectAbort?.abort();
    this.directAbort?.abort();
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
  getConfig = () => this.readRPC("GetConfig", {}) as Promise<Record<string, unknown>>;
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
  revokeSelf = (deviceId: string) => this.trackedMutation("RevokeDevice", { device_id: deviceId });
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
    parseAgentTracePage(await this.readRPC("AgentTrace", { pane_id: paneId, cursor, limit }));
  listWorktrees = (params: ListWorktreesInput) => this.readRPC("ListWorktrees", params);
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
    this.stopped = true;
    this.connectAbort?.abort();
    this.connectAbort = null;
    this.directAbort?.abort();
    this.directAbort = null;
    this.directAttempt = null;
    this.clearDirectRetry();
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.transport?.close();
    this.transport = null;
  };

  private async readRPC(op: string, params: unknown): Promise<unknown> {
    const transport = await this.captureTransport();
    if (!transport) return Promise.reject(new ProtocolError("reconnecting", "连接正在恢复"));
    return transport.rpc(op, params);
  }

  /** Capture one transport; mutation RPCs are never replayed on another socket. */
  private async mutationRPC(op: string, params: unknown): Promise<unknown> {
    const transport = await this.captureTransport();
    if (!transport) return Promise.reject(new ProtocolError("disconnected", "连接已断开；为避免重复输入，本次操作未发送"));
    return trackMutationDelivery((markSent) => transport.rpc(op, params, MUTATION_RPC_TIMEOUT_MS, markSent));
  }

  private async terminalRPC(op: string, params: unknown): Promise<unknown> {
    const transport = await this.captureTransport();
    if (!transport) return Promise.reject(new ProtocolError("disconnected", "连接已断开；本次终端操作未发送"));
    return trackMutationDelivery((markSent) => transport.rpc(op, params, TERMINAL_RPC_TIMEOUT_MS, markSent));
  }

  private async captureTransport(): Promise<SessionTransport | null> {
    while (this.switchWait) await this.switchWait;
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
    if (event.type === "latency" && typeof event.rttMs === "number") {
      this.lastRttMs = event.rttMs;
      this.lastTransport = event.transport ?? this.lastTransport;
    }
    for (const listener of this.listeners) listener(event);
  }

  private async connect(): Promise<void> {
    const controller = new AbortController();
    this.connectAbort = controller;
    let transport: SessionTransport;
    try {
      transport = await connectSession(this.relayWS, this.pair, (event) => this.emit(event), controller.signal);
    } finally {
      if (this.connectAbort === controller) this.connectAbort = null;
    }
    if (this.stopped || !this.networkAvailable) {
      transport.close();
      return;
    }
    this.transport = transport;
    this.attempt = 0;
    transport.onDisconnect((error) => this.onDisconnect(transport, error));
    if (this.transport !== transport) return;
    this.emit({ type: "connected" });
    this.directRetryAttempt = 0;
    this.startAutomaticDirectUpgrade(transport);
  }

  private onDisconnect(source: SessionTransport, error: ProtocolError): void {
    if (this.stopped || this.transport !== source) return;
    if (this.switchWait) {
      this.deferredDisconnect = error;
      return;
    }
    if (source.kind === "relay") this.directAbort?.abort();
    this.finishDisconnect(error);
  }

  private finishDisconnect(error: ProtocolError): void {
    this.transport = null;
    this.clearDirectRetry();
    if (TERMINAL_CODES.has(error.code) || error.code === "kicked") {
      this.stopped = true;
      this.emit({ type: "terminal", code: error.code, message: error.message });
      return;
    }
    this.emit({ type: "disconnected", code: error.code, message: error.message });
    // A healthy session gets one immediate recovery attempt. Only failed
    // reconnects enter the jittered exponential backoff below.
    this.scheduleReconnect(true);
  }

  private beginSwitch(): void {
    if (this.switchWait) throw new ProtocolError("conflict", "transport switch already active");
    this.switchWait = new Promise<void>((resolve) => { this.finishSwitch = resolve; });
    this.deferredDisconnect = null;
  }

  private endSwitch(): void {
    const finish = this.finishSwitch;
    this.finishSwitch = null;
    this.switchWait = null;
    finish?.();
  }

  private startAutomaticDirectUpgrade(relay: SessionTransport): void {
    if (!this.canAutoUpgrade(relay) || this.directAttempt) return;
    this.clearDirectRetry();
    void this.startDirectUpgrade(relay).then(
      () => { this.directRetryAttempt = 0; },
      () => this.scheduleDirectRetry(relay),
    );
  }

  private canAutoUpgrade(relay: SessionTransport): boolean {
    return this.options.p2p === true && this.networkMode !== "relay" && typeof RTCPeerConnection !== "undefined" &&
      !this.stopped && this.networkAvailable && this.transport === relay && relay.kind === "relay";
  }

  private startDirectUpgrade(relay: SessionTransport): Promise<void> {
    if (this.directAttempt) return this.directAttempt;
    if (!this.canAutoUpgrade(relay)) return Promise.reject(new ProtocolError("p2p_unavailable", "P2P 直连当前不可用"));
    const controller = new AbortController();
    this.directAbort = controller;
    const attempt = this.runDirectUpgrade(relay, controller);
    this.directAttempt = attempt;
    void attempt.then(
      () => this.finishDirectAttempt(attempt, controller, relay),
      () => this.finishDirectAttempt(attempt, controller, relay),
    );
    return attempt;
  }

  private finishDirectAttempt(attempt: Promise<void>, controller: AbortController, relay: SessionTransport): void {
    if (this.directAttempt === attempt) this.directAttempt = null;
    if (this.directAbort === controller) this.directAbort = null;
    const active = this.transport;
    if (active && active !== relay && active.kind === "relay") this.startAutomaticDirectUpgrade(active);
  }

  private async runDirectUpgrade(relay: SessionTransport, controller: AbortController): Promise<void> {
    let candidate: Awaited<ReturnType<typeof prepareDirectSession>> | null = null;
    try {
      candidate = await prepareDirectSession(relay, this.pair, muxProtocolFromRelayURL(this.relayWS), controller.signal);
      if (this.stopped || this.transport !== relay || !this.networkAvailable) {
        throw new ProtocolError("p2p_unavailable", "P2P 直连尝试已取消");
      }
      this.beginSwitch();
      await relay.waitIdle();
      const direct = await commitDirectSession(relay, candidate, (event) => this.emit(event));
      candidate = null;
      if (this.stopped || this.transport !== relay || !this.networkAvailable) {
        direct.transport.close();
        throw new ProtocolError("p2p_unavailable", "P2P 直连切换已取消");
      }
      this.deferredDisconnect = null;
      this.transport = direct.transport;
      direct.transport.onDisconnect((error) => this.onDisconnect(direct.transport, error));
      this.emit({ type: "latency", rttMs: direct.rttMs, transport: "p2p" });
      this.clearDirectRetry();
      relay.close();
    } catch (error) {
      const deferred = this.deferredDisconnect;
      if (deferred && this.transport === relay) {
        this.deferredDisconnect = null;
        this.finishDisconnect(deferred);
      }
      throw error;
    } finally {
      candidate?.close();
      if (this.switchWait) this.endSwitch();
      const deferred = this.deferredDisconnect;
      if (deferred && this.transport) {
        this.deferredDisconnect = null;
        this.finishDisconnect(deferred);
      }
    }
  }

  private scheduleDirectRetry(relay: SessionTransport): void {
    if (!this.canAutoUpgrade(relay) || this.directRetryTimer !== null) return;
    const delay = directRetryDelay(this.directRetryAttempt++);
    this.directRetryTimer = globalThis.setTimeout(() => {
      this.directRetryTimer = null;
      this.startAutomaticDirectUpgrade(relay);
    }, delay);
  }

  private clearDirectRetry(): void {
    if (this.directRetryTimer !== null) clearTimeout(this.directRetryTimer);
    this.directRetryTimer = null;
  }

  private scheduleReconnect(immediate = false): void {
    if (this.stopped || !this.networkAvailable || this.reconnecting || this.reconnectTimer !== null) return;
    const delay = immediate ? 0 : reconnectDelay(this.attempt++);
    this.emit({ type: "reconnecting", message: immediate ? "正在重新连接" : `${Math.ceil(delay / 1000)} 秒后重连` });
    this.reconnectTimer = globalThis.setTimeout(async () => {
      this.reconnectTimer = null;
      this.reconnecting = true;
      try {
        await this.connect();
      } catch (error) {
        if (!this.networkAvailable) return;
        const protocolError = error instanceof ProtocolError ? error : new ProtocolError("disconnected", String(error));
        if (TERMINAL_CODES.has(protocolError.code)) {
          this.stopped = true;
          this.emit({ type: "terminal", code: protocolError.code, message: protocolError.message });
        } else this.emit({ type: "disconnected", code: protocolError.code, message: protocolError.message });
      } finally {
        this.reconnecting = false;
        if (!this.stopped && !this.transport) this.scheduleReconnect();
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
