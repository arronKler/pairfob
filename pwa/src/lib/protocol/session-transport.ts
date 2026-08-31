import { Direction } from "./aead.ts";
import { b64url } from "./bytes.ts";
import { decodeUTF8, Typ, type Frame } from "./envelope.ts";
import { envelopeError, HEARTBEAT_MS, heartbeatPayload, requireHeartbeatPayload, sameBytes } from "./frame-socket.ts";
import type { FrameChannel, FrameChannelKind } from "./frame-channel.ts";
import { ProtocolError } from "./errors.ts";
import { validateSessionMessage } from "./session-message.ts";
import type { SessionEvent } from "./session-types.ts";

const MAX_IN_FLIGHT = 32;
/** Snapshot/Ping/History and other reads. */
export const READ_RPC_TIMEOUT_MS = 8_000;
/** Mutations share the daemon executeRPC deadline. */
export const MUTATION_RPC_TIMEOUT_MS = 45_000;
/** Live terminal control fails visibly instead of stalling the input queue. */
export const TERMINAL_RPC_TIMEOUT_MS = 10_000;

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export function validateEstablishedFWD(frame: Frame, routeId: Uint8Array): void {
  if (frame.typ !== Typ.FWD) throw new ProtocolError("bad_frame", `Established 会话收到非法控制帧 ${frame.typ}`);
  if (!sameBytes(frame.routeId, routeId)) throw new ProtocolError("bad_frame", "Established FWD route_id 不匹配");
}

/** RPC and push semantics shared by relay and P2P frame adapters. */
export class SessionTransport {
  private pending = new Map<string, Pending>();
  private heartbeat: ReturnType<typeof setInterval>;
  private heartbeatCounter = 0n;
  private expectedPong: Uint8Array | null = null;
  private expectedPongAt = 0;
  private stopped = false;
  private stopError: ProtocolError | null = null;
  private disconnectHandlers = new Set<(error: ProtocolError) => void>();

  constructor(
    private readonly channel: FrameChannel,
    private readonly routeId: Uint8Array,
    private readonly c2s: Direction,
    private readonly s2c: Direction,
    private readonly emit: (event: SessionEvent) => void,
  ) {
    channel.use((frame) => this.receive(frame));
    channel.onClose((error) => this.disconnect(error));
    const beat = () => {
      try {
        if (this.expectedPong) {
          this.disconnect(new ProtocolError("heartbeat_timeout", "连接未及时响应心跳"));
          this.channel.close(1011, "heartbeat timeout");
          return;
        }
        const payload = heartbeatPayload(++this.heartbeatCounter);
        this.expectedPong = payload;
        this.expectedPongAt = performance.now();
        this.channel.send({ version: 1, typ: Typ.PING, flags: 0, routeId: this.routeId, payload });
      } catch {
        this.disconnect(new ProtocolError("disconnected", "心跳发送失败"));
        this.channel.close(1011, "heartbeat send failed");
      }
    };
    this.heartbeat = globalThis.setInterval(beat, HEARTBEAT_MS);
    beat();
  }

  get kind(): FrameChannelKind { return this.channel.kind; }

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
        this.channel.send({ version: 1, typ: Typ.FWD, flags: 0, routeId: this.routeId, payload });
        onSent?.();
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async waitIdle(timeoutMs = 2_000): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (this.pending.size > 0) {
      if (this.stopped) throw this.stopError ?? new ProtocolError("disconnected", "连接已断开");
      if (performance.now() >= deadline) throw new ProtocolError("timeout", "等待在途请求完成超时");
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 5));
    }
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.heartbeat);
    this.rejectPending(new ProtocolError("closed", "会话已关闭"));
    this.channel.close(1000, "client close");
  }

  suspend(error: ProtocolError): void {
    this.disconnect(error);
    this.channel.close(1001, "network unavailable");
  }

  private receive(frame: Frame): void {
    if (this.stopped) return;
    try {
      if (frame.typ === Typ.PING) {
        requireHeartbeatPayload(frame.payload);
        this.channel.send({ ...frame, typ: Typ.PONG });
        return;
      }
      if (frame.typ === Typ.PONG) {
        requireHeartbeatPayload(frame.payload);
        if (!this.expectedPong || !sameBytes(frame.payload, this.expectedPong)) throw new ProtocolError("bad_frame", "PONG 未原样回显 PING");
        const rttMs = Math.max(0, performance.now() - this.expectedPongAt);
        this.expectedPong = null;
        this.expectedPongAt = 0;
        this.emit({ type: "latency", rttMs, transport: this.channel.kind });
        return;
      }
      if (frame.typ === Typ.DAEMON_REPLACED) {
        this.disconnect(new ProtocolError("daemon_replaced", "daemon 已重连，正在恢复手机会话"));
        this.channel.close(1012, "daemon replaced");
        return;
      }
      if (frame.typ === Typ.ERROR) {
        const error = envelopeError(frame);
        this.disconnect(error);
        this.channel.close(1008, error.code);
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
      this.channel.close(1002, "bad session frame");
    }
  }

  private sendResponse(id: string, ok: boolean, result?: unknown, error?: { code: string; message: string }): void {
    const plaintext = new TextEncoder().encode(JSON.stringify({ v: 1, id, ok, ...(ok ? { result } : { error }) }));
    const payload = this.c2s.seal(this.routeId, plaintext);
    this.channel.send({ version: 1, typ: Typ.FWD, flags: 0, routeId: this.routeId, payload });
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
