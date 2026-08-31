import { x25519 } from "@noble/curves/ed25519.js";
import { validDaemonId, validDeviceId } from "../identifiers.ts";
import { Direction, DIR_C, DIR_S } from "./aead.ts";
import { b64url, base64Decode, bytesToHex } from "./bytes.ts";
import { decodeUTF8, jsonFrame, parseJSON, Typ, type Frame } from "./envelope.ts";
import { fingerprint16, proof, transcriptD, transcriptP, verifyEd25519 } from "./hello.ts";
import { sessionKeys } from "./kdf.ts";
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
  FrameSocket,
  HEARTBEAT_MS,
  heartbeatPayload,
  openWS,
  parseExactB64,
  relayOrigin,
  requireHeartbeatPayload,
  sameBytes,
  send,
  Z16,
} from "./frame-socket.ts";
import { helloClientBody, muxProtocolFromRelayURL, muxSubprotocol, sessionAttachBody, type MuxProtocol } from "./mux.ts";
import type { PairResult } from "./pair-ws.ts";
import { reconnectDelay } from "./reconnect-policy.ts";
import type { DeviceSummary, LiveSession, SessionEvent } from "./session-types.ts";
import {
  encodeTerminalInput,
  parseTerminalCloseResult,
  parseTerminalCommandResult,
  parseTerminalOpenResult,
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_ROWS,
  TERMINAL_MIN_COLS,
  TERMINAL_MIN_ROWS,
  type TerminalFramePart,
  type TerminalOpenResult,
} from "./terminal.ts";

const MAX_IN_FLIGHT = 32;
/** Snapshot/Ping/History and other reads. */
export const READ_RPC_TIMEOUT_MS = 8_000;
/**
 * Mutations share the daemon executeRPC deadline (45s). CreateConversation
 * waits on Herdr agent.start (up to 35s); an 8s client timer falsely times
 * out a request that is still running, then drops the later success.
 */
export const MUTATION_RPC_TIMEOUT_MS = 45_000;
/** Live terminal control fails visibly instead of stalling the input queue. */
export const TERMINAL_RPC_TIMEOUT_MS = 10_000;

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

const RPC_ERROR_CODES = new Set([
  "unpaired", "revoked", "pane_not_found", "tab_not_found", "workspace_not_found", "stale_prompt",
  "invalid_key", "herdr_offline", "too_large", "rate_limited", "unknown_op", "backpressure",
  "bad_token", "bad_frame", "internal", "pair_busy", "pair_timeout", "unbound", "wrong_ws", "too_many_devices",
  "kicked", "daemon_offline", "replay", "sas_required", "fp_mismatch", "forbidden",
  "invalid_argument", "unsupported", "conflict", "agent_not_found", "worktree_not_found",
  "transcript_unavailable", "unknown_outcome", "partial_failure",
]);
const POKE_REASONS = new Set(["agent_status", "herdr_offline", "herdr_online", "daemon_replaced"]);

type ValidSessionMessage =
  | { kind: "request"; id: string; tMs: number }
  | { kind: "response"; id: string; ok: true; result: unknown }
  | { kind: "response"; id: string; ok: false; error: { code: string; message: string } }
  | { kind: "poke"; reason: string; paneId?: string }
  | { kind: "terminal_frame"; frame: TerminalFramePart }
  | { kind: "terminal_closed"; terminalId: string; reason: string };

const TERMINAL_ID = /^term_[0-9a-f]{32}$/;
const TERMINAL_SEQUENCE = /^[1-9][0-9]{0,19}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

/** Validate decrypted server messages before they affect RPC state or UI. */
export function validateSessionMessage(value: unknown): ValidSessionMessage {
  if (!isRecord(value) || value.v !== 1) throw new ProtocolError("bad_message", "RPC 消息格式错误");
  if (value.op === "Poke") {
    if (!exactKeys(value, ["v", "op", "params"]) || !isRecord(value.params)
      || !exactKeys(value.params, ["reason"], ["pane_id"])
      || typeof value.params.reason !== "string" || !POKE_REASONS.has(value.params.reason)
      || (value.params.pane_id !== undefined && (typeof value.params.pane_id !== "string" || value.params.pane_id.length < 1 || value.params.pane_id.length > 256))) {
      throw new ProtocolError("bad_message", "Poke 格式错误");
    }
    return { kind: "poke", reason: value.params.reason, ...(value.params.pane_id === undefined ? {} : { paneId: value.params.pane_id }) };
  }
  if (value.op === "TerminalFrame") {
    if (!exactKeys(value, ["v", "op", "params"]) || !isRecord(value.params)
      || !exactKeys(value.params, ["terminal_id", "seq", "width", "height", "full", "index", "count", "data"])
      || typeof value.params.terminal_id !== "string" || !TERMINAL_ID.test(value.params.terminal_id)
      || typeof value.params.seq !== "string" || !TERMINAL_SEQUENCE.test(value.params.seq)
      || !Number.isSafeInteger(value.params.width) || (value.params.width as number) < TERMINAL_MIN_COLS || (value.params.width as number) > TERMINAL_MAX_COLS
      || !Number.isSafeInteger(value.params.height) || (value.params.height as number) < TERMINAL_MIN_ROWS || (value.params.height as number) > TERMINAL_MAX_ROWS
      || typeof value.params.full !== "boolean"
      || !Number.isSafeInteger(value.params.index) || (value.params.index as number) < 0
      || !Number.isSafeInteger(value.params.count) || (value.params.count as number) < 1 || (value.params.count as number) > 43
      || (value.params.index as number) >= (value.params.count as number)
      || typeof value.params.data !== "string" || value.params.data.length > 131_072) {
      throw new ProtocolError("bad_message", "TerminalFrame 格式错误");
    }
    let data: Uint8Array;
    try {
      data = base64Decode(value.params.data);
    } catch {
      throw new ProtocolError("bad_message", "TerminalFrame data 不是规范 Base64");
    }
    return {
      kind: "terminal_frame",
      frame: {
        terminalId: value.params.terminal_id,
        sequence: value.params.seq,
        width: value.params.width as number,
        height: value.params.height as number,
        full: value.params.full,
        index: value.params.index as number,
        count: value.params.count as number,
        data,
      },
    };
  }
  if (value.op === "TerminalClosed") {
    if (!exactKeys(value, ["v", "op", "params"]) || !isRecord(value.params)
      || !exactKeys(value.params, ["terminal_id", "reason"])
      || typeof value.params.terminal_id !== "string" || !TERMINAL_ID.test(value.params.terminal_id)
      || typeof value.params.reason !== "string" || value.params.reason.length > 512) {
      throw new ProtocolError("bad_message", "TerminalClosed 格式错误");
    }
    return { kind: "terminal_closed", terminalId: value.params.terminal_id, reason: value.params.reason };
  }
  if (typeof value.op === "string") {
    if (!exactKeys(value, ["v", "id", "op", "params"]) || value.op !== "Ping"
      || typeof value.id !== "string" || value.id.length < 1 || value.id.length > 128
      || !isRecord(value.params) || !exactKeys(value.params, ["t_ms"])
      || !Number.isSafeInteger(value.params.t_ms)) {
      throw new ProtocolError("bad_message", "daemon RPC 请求格式错误");
    }
    return { kind: "request", id: value.id, tMs: value.params.t_ms as number };
  }
  if (typeof value.id !== "string" || value.id.length < 1 || value.id.length > 128 || typeof value.ok !== "boolean") {
    throw new ProtocolError("bad_message", "RPC 响应格式错误");
  }
  if (value.ok) {
    if (!exactKeys(value, ["v", "id", "ok", "result"])) throw new ProtocolError("bad_message", "RPC 成功响应格式错误");
    return { kind: "response", id: value.id, ok: true, result: value.result };
  }
  if (!exactKeys(value, ["v", "id", "ok", "error"]) || !isRecord(value.error)
    || !exactKeys(value.error, ["code", "message"])
    || typeof value.error.code !== "string" || !RPC_ERROR_CODES.has(value.error.code)
    || typeof value.error.message !== "string" || value.error.message.length > 4096) {
    throw new ProtocolError("bad_message", "RPC 错误响应格式错误");
  }
  return { kind: "response", id: value.id, ok: false, error: { code: value.error.code, message: value.error.message } };
}

class SessionTransport {
  private pending = new Map<string, Pending>();
  private heartbeat: ReturnType<typeof setInterval>;
  private heartbeatCounter = 0n;
  private expectedPong: Uint8Array | null = null;
  private expectedPongAt = 0;
  private stopped = false;
  private stopError: ProtocolError | null = null;
  private disconnectHandlers = new Set<(error: ProtocolError) => void>();

  constructor(
    private readonly socket: FrameSocket,
    private readonly routeId: Uint8Array,
    private readonly c2s: Direction,
    private readonly s2c: Direction,
    private readonly emit: (event: SessionEvent) => void,
  ) {
    socket.use((frame) => this.receive(frame));
    socket.onClose((error) => this.disconnect(error));
    const beat = () => {
      try {
        if (this.expectedPong) {
          this.disconnect(new ProtocolError("heartbeat_timeout", "relay 未及时响应心跳"));
          this.socket.ws.close(1011, "heartbeat timeout");
          return;
        }
        const payload = heartbeatPayload(++this.heartbeatCounter);
        this.expectedPong = payload;
        this.expectedPongAt = performance.now();
        send(this.socket.ws, { version: 1, typ: Typ.PING, flags: 0, routeId: this.routeId, payload });
      } catch {
        this.disconnect(new ProtocolError("disconnected", "心跳发送失败"));
      }
    };
    this.heartbeat = globalThis.setInterval(beat, HEARTBEAT_MS);
    beat();
  }

  onDisconnect(handler: (error: ProtocolError) => void): void {
    this.disconnectHandlers.add(handler);
    if (this.stopError) handler(this.stopError);
  }

  async rpc(op: string, params: unknown, timeoutMs = READ_RPC_TIMEOUT_MS, onSent?: () => void): Promise<unknown> {
    if (this.stopped) throw new ProtocolError("disconnected", "连接正在恢复");
    if (this.pending.size >= MAX_IN_FLIGHT) throw new ProtocolError("backpressure", "请求过多，请稍后再试");
    const id = `req_${b64url(crypto.getRandomValues(new Uint8Array(12)))}`;
    const plaintext = new TextEncoder().encode(JSON.stringify({ v: 1, id, op, params }));
    return new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.pending.delete(id);
        reject(new ProtocolError("timeout", `${op} 响应超时；写操作不会自动重试`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        const payload = this.c2s.seal(this.routeId, plaintext);
        send(this.socket.ws, { version: 1, typ: Typ.FWD, flags: 0, routeId: this.routeId, payload });
        onSent?.();
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    this.stopped = true;
    clearInterval(this.heartbeat);
    this.rejectPending(new ProtocolError("closed", "会话已关闭"));
    this.socket.ws.close(1000, "client close");
  }

  suspend(error: ProtocolError): void {
    this.disconnect(error);
    this.socket.ws.close(1001, "network unavailable");
  }

  private receive(frame: Frame): void {
    if (this.stopped) return;
    try {
      if (frame.typ === Typ.PING) {
        requireHeartbeatPayload(frame.payload);
        send(this.socket.ws, { ...frame, typ: Typ.PONG });
        return;
      }
      if (frame.typ === Typ.PONG) {
        requireHeartbeatPayload(frame.payload);
        if (!this.expectedPong || !sameBytes(frame.payload, this.expectedPong)) throw new ProtocolError("bad_frame", "PONG 未原样回显 PING");
        const rttMs = Math.max(0, performance.now() - this.expectedPongAt);
        this.expectedPong = null;
        this.expectedPongAt = 0;
        this.emit({ type: "latency", rttMs });
        return;
      }
      if (frame.typ === Typ.DAEMON_REPLACED) {
        this.disconnect(new ProtocolError("daemon_replaced", "daemon 已重连，正在恢复手机会话"));
        this.socket.ws.close(1012, "daemon replaced");
        return;
      }
      if (frame.typ === Typ.ERROR) {
        const error = envelopeError(frame);
        this.disconnect(error);
        this.socket.ws.close(1008, error.code);
        return;
      }
      validateEstablishedFWD(frame, this.routeId);
      const message = validateSessionMessage(JSON.parse(decodeUTF8(this.s2c.open(this.routeId, frame.payload))));
      if (message.kind === "request") {
        this.sendResponse(message.id, true, { t_echo_ms: message.tMs });
        return;
      }
      if (message.kind === "poke") {
        this.emit({ type: "poke", reason: message.reason, paneId: message.paneId });
        return;
      }
      if (message.kind === "terminal_frame") {
        this.emit({ type: "terminal_frame", terminalId: message.frame.terminalId, terminalFrame: message.frame });
        return;
      }
      if (message.kind === "terminal_closed") {
        this.emit({ type: "terminal_closed", terminalId: message.terminalId, reason: message.reason });
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new ProtocolError(message.error.code, message.error.message));
    } catch (error) {
      this.disconnect(error instanceof ProtocolError ? error : new ProtocolError("bad_message", String(error)));
      this.socket.ws.close(1002, "bad session frame");
    }
  }

  private sendResponse(id: string, ok: boolean, result?: unknown, error?: { code: string; message: string }): void {
    const plaintext = new TextEncoder().encode(JSON.stringify({ v: 1, id, ok, ...(ok ? { result } : { error }) }));
    const payload = this.c2s.seal(this.routeId, plaintext);
    send(this.socket.ws, { version: 1, typ: Typ.FWD, flags: 0, routeId: this.routeId, payload });
  }

  private rejectPending(error: ProtocolError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private disconnect(error: ProtocolError): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopError = error;
    clearInterval(this.heartbeat);
    this.rejectPending(error);
    for (const handler of this.disconnectHandlers) handler(error);
  }
}

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
    const routeId = bound.routeId;
    const ephemeralSecret = x25519.utils.randomPrivateKey();
    const ephemeralPublic = x25519.getPublicKey(ephemeralSecret);
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    send(socket.ws, jsonFrame(Typ.FWD, routeId, {
      v: 1,
      op: "DeviceHello1",
      device_id: pair.deviceId,
      daemon_id: pair.daemonId,
      eph_x25519: b64url(ephemeralPublic),
      nonce: b64url(nonce),
    }));

    const helloFrame = await socket.next(8_000);
    if (helloFrame.typ === Typ.ERROR) throw envelopeError(helloFrame);
    if (helloFrame.typ !== Typ.FWD || !sameBytes(helloFrame.routeId, routeId)) throw new ProtocolError("bad_message", "DeviceHello2 信封错误");
    const hello2 = parseJSON(helloFrame);
    if (hello2.op !== "DeviceHello2" || !hello2.ok) throw new ProtocolError(String(hello2.error?.code || "unpaired"), "DeviceHello2 拒绝凭证");
    const ephemeralDaemon = parseExactB64(hello2.eph_x25519, 32, "eph_x25519");
    const proofDaemon = parseExactB64(hello2.proof_d, 32, "proof_d");
    const signatureDaemon = parseExactB64(hello2.sig_d, 64, "sig_d");
    if (!Number.isSafeInteger(hello2.ts)) throw new ProtocolError("bad_message", "DeviceHello2 ts 错误");
    const transcript = transcriptD(pair.daemonId, pair.deviceId, ephemeralPublic, ephemeralDaemon, nonce, BigInt(hello2.ts), routeId);
    if (!sameBytes(proof(pair.psk, transcript), proofDaemon)) throw new ProtocolError("bad_proof", "daemon PSK 证明失败");
    if (!verifyEd25519(pair.daemonPk, transcript, signatureDaemon)) throw new ProtocolError("bad_signature", "daemon 签名失败");
    send(socket.ws, jsonFrame(Typ.FWD, routeId, { v: 1, op: "DeviceHello3", proof_p: b64url(proof(pair.psk, transcriptP(transcript))) }));
    const dh = x25519.getSharedSecret(ephemeralSecret, ephemeralDaemon);
    const keys = sessionKeys(dh, pair.psk);
    // Relay must first observe the daemon's non-FWD establishment signal,
    // upgrade the bind, and forward that exact frame to this phone.
    await waitSessionEstablished(socket, routeId, protocol);
    const transport = new SessionTransport(socket, routeId, new Direction(keys.c2s, DIR_C), new Direction(keys.s2c, DIR_S), emit);
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

async function waitSessionEstablished(socket: FrameSocket, routeId: Uint8Array, protocol: MuxProtocol): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const frame = await socket.next(Math.max(1, deadline - Date.now()));
    if (frame.typ === Typ.PING) {
      requireHeartbeatPayload(frame.payload);
      send(socket.ws, { ...frame, typ: Typ.PONG });
      continue;
    }
    if (frame.typ === Typ.PONG) {
      requireHeartbeatPayload(frame.payload);
      continue;
    }
    if (frame.typ === Typ.ERROR) throw envelopeError(frame);
    if (frame.typ === Typ.DAEMON_REPLACED) throw new ProtocolError("daemon_replaced", "daemon 在握手期间重连");
    if (frame.typ === Typ.FWD && sameBytes(frame.routeId, routeId)) {
      try {
        const hello = parseJSON(frame);
        if (hello.op === "DeviceHello2" && !hello.ok) {
          throw new ProtocolError(String(hello.error?.code || "unpaired"), "DeviceHello3 被拒绝");
        }
      } catch (error) {
        if (error instanceof ProtocolError) throw error;
      }
      throw new ProtocolError("bad_message", "建立会话前收到意外 FWD");
    }
    if (frame.typ !== Typ.SESSION_ESTABLISHED) {
      throw new ProtocolError("bad_message", `建立会话前收到意外控制帧 ${frame.typ}`);
    }
    validateSessionEstablished(frame, routeId, protocol);
    return;
  }
  throw new ProtocolError("timeout", "等待 SESSION_ESTABLISHED 超时");
}

export function validateSessionEstablished(frame: Frame, routeId: Uint8Array, protocol: MuxProtocol = 1): void {
  if (frame.typ !== Typ.SESSION_ESTABLISHED || !sameBytes(frame.routeId, routeId)) {
    throw new ProtocolError("bad_message", "SESSION_ESTABLISHED 信封不匹配");
  }
  const body = parseJSON(frame);
  if (body.v !== protocol || body.route_id !== bytesToHex(routeId)) {
    throw new ProtocolError("bad_message", "SESSION_ESTABLISHED route_id 不匹配");
  }
}

export function validateEstablishedFWD(frame: Frame, routeId: Uint8Array): void {
  if (frame.typ !== Typ.FWD) throw new ProtocolError("bad_frame", `Established 会话收到非法控制帧 ${frame.typ}`);
  if (!sameBytes(frame.routeId, routeId)) throw new ProtocolError("bad_frame", "Established FWD route_id 不匹配");
}

const TERMINAL_CODES = new Set(["revoked", "unpaired", "too_many_devices", "bad_proof", "bad_signature"]);
const UNCERTAIN_MUTATION_TRANSPORT_CODES = new Set(["timeout", "disconnected", "heartbeat_timeout", "daemon_replaced"]);

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
  private networkAvailable = true;
  private attempt = 0;
  private relayRttMs: number | null = null;

  private constructor(private readonly relayWS: string, private readonly pair: PairResult) {}

  static async create(relayWS: string, pair: PairResult): Promise<ReconnectingSession> {
    const session = new ReconnectingSession(relayWS, pair);
    await session.connect();
    return session;
  }

  isConnected = (): boolean => this.transport !== null;
  reconnectNow = (): void => {
    if (this.stopped || !this.networkAvailable) return;
    if (this.transport) {
      const transport = this.transport;
      void transport.rpc("Ping", { t_ms: Date.now() }, 8_000).catch((error) => {
        if (this.transport === transport && error instanceof ProtocolError && error.code === "timeout") {
          transport.suspend(new ProtocolError("disconnected", "前台探测失败"));
        }
      });
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
    this.connectAbort?.abort();
    const transport = this.transport;
    if (transport) transport.suspend(new ProtocolError("disconnected", "手机网络已断开"));
    else if (!this.reconnecting) this.emit({ type: "disconnected", code: "disconnected", message: "手机网络已断开" });
  };
  onEvent = (listener: (event: SessionEvent) => void): (() => void) => {
    this.listeners.add(listener);
    if (this.relayRttMs !== null) listener({ type: "latency", rttMs: this.relayRttMs });
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
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.transport?.close();
    this.transport = null;
  };

  private readRPC(op: string, params: unknown): Promise<unknown> {
    const transport = this.transport;
    if (!transport) return Promise.reject(new ProtocolError("reconnecting", "连接正在恢复"));
    return transport.rpc(op, params);
  }

  /** Capture one transport; mutation RPCs are never replayed on another socket. */
  private mutationRPC(op: string, params: unknown): Promise<unknown> {
    const transport = this.transport;
    if (!transport) return Promise.reject(new ProtocolError("disconnected", "连接已断开；为避免重复输入，本次操作未发送"));
    return trackMutationDelivery((markSent) => transport.rpc(op, params, MUTATION_RPC_TIMEOUT_MS, markSent));
  }

  private terminalRPC(op: string, params: unknown): Promise<unknown> {
    const transport = this.transport;
    if (!transport) return Promise.reject(new ProtocolError("disconnected", "连接已断开；本次终端操作未发送"));
    return trackMutationDelivery((markSent) => transport.rpc(op, params, TERMINAL_RPC_TIMEOUT_MS, markSent));
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
    if (event.type === "latency" && typeof event.rttMs === "number") this.relayRttMs = event.rttMs;
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
    transport.onDisconnect((error) => this.onDisconnect(error));
    if (this.transport !== transport) return;
    this.emit({ type: "connected" });
  }

  private onDisconnect(error: ProtocolError): void {
    if (this.stopped) return;
    this.transport = null;
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

export async function sessionOverWS(relayWS: string, pair: PairResult): Promise<LiveSession> {
  if (pair.psk.length !== 32 || pair.daemonPk.length !== 32 || !validDaemonId(pair.daemonId) || !validDeviceId(pair.deviceId)) throw new ProtocolError("invalid_credential", "本机凭证不完整或标识非法");
  if (pair.relayOrigin !== relayOrigin(relayWS)) throw new ProtocolError("bad_relay", "凭证不属于当前 relay");
  if (pair.fp !== fingerprint16(pair.daemonPk)) throw new ProtocolError("fp_mismatch", "已存 daemon 指纹不匹配");
  return ReconnectingSession.create(relayWS, pair);
}

export type { DeviceSummary, LiveSession, SessionEvent } from "./session-types.ts";
