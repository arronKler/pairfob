import { recordConnectionDiagnostic, type ConnectionDetails } from "./connection-diagnostics.ts";
import { Direction } from "./aead.ts";
import { b64url } from "./bytes.ts";
import { DataFrameChannel } from "./data-channel.ts";
import { decodeUTF8, Typ, type Frame } from "./envelope.ts";
import { envelopeError, HEARTBEAT_MS, heartbeatPayload, requireHeartbeatPayload, sameBytes } from "./frame-socket.ts";
import type { FrameChannel, FrameChannelKind } from "./frame-channel.ts";
import { ProtocolError } from "./errors.ts";
import { validateSessionMessage } from "./session-message.ts";
import type { SessionEvent } from "./session-types.ts";

import { pageHidden, watchPageVisibility } from "./page-activity.ts";
import { DIRECT_RESUME_GRACE_MS } from "./direct-retry-policy.ts";

const MAX_IN_FLIGHT = 32;
/** Snapshot/Ping/History and other reads. */
export const READ_RPC_TIMEOUT_MS = 8_000;
/** Mutations share the daemon executeRPC deadline. */
export const MUTATION_RPC_TIMEOUT_MS = 45_000;
/** Live terminal control fails visibly instead of stalling the input queue. */
export const TERMINAL_RPC_TIMEOUT_MS = 10_000;
/**
 * Late-success callbacks (a media Open whose response arrives after the caller
 * timed out) only close an orphaned handle; they are not request memory. They
 * get a finite grace period and a hard cap so a timeout storm cannot grow the
 * map without bound. An abandoned Open handle past this window is authoritatively
 * reclaimed by the daemon's own handle-idle/teardown, never by client liveness.
 */
const MAX_LATE_CALLBACKS = MAX_IN_FLIGHT;
export { MAX_LATE_CALLBACKS as MEDIA_LATE_CALLBACK_CAP };
const LATE_CALLBACK_TTL_MS = 60_000;

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type Late = { fn: (result: unknown) => void; expires: ReturnType<typeof setTimeout> };
/**
 * WorkspaceMediaOpen hashes up to 32 MiB at 8 MiB/s session disk quota
 * (~4 s) plus sniff/JPEG scan. 20 s matches the daemon Open deadline and
 * leaves READ_RPC_TIMEOUT_MS / TERMINAL_RPC_TIMEOUT_MS unchanged.
 */
export const MEDIA_OPEN_RPC_TIMEOUT_MS = 20_000;

export function validateEstablishedFWD(frame: Frame, routeId: Uint8Array): void {
  if (frame.typ !== Typ.FWD) throw new ProtocolError("bad_frame", `Established 会话收到非法控制帧 ${frame.typ}`);
  if (!sameBytes(frame.routeId, routeId)) throw new ProtocolError("bad_frame", "Established FWD route_id 不匹配");
}

/** RPC and push semantics shared by relay and P2P frame adapters. */
export class SessionTransport {
  private pending = new Map<string, Pending>();
  // Requests that already timed out client-side but whose successful response
  // must still be observed: a late WorkspaceMediaOpen needs its remote handle
  // closed so the daemon does not leak the open media handle after our deadline.
  // Bounded: a finite per-entry TTL plus MAX_LATE_CALLBACKS cap (the evicted
  // entry's orphan is reclaimed daemon-side). Cleared on every retirement.
  private late = new Map<string, Late>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private heartbeatCounter = 0n;
  private expectedPong: Uint8Array | null = null;
  private expectedPongAt = 0;
  private stopped = false;
  private hidden = pageHidden();
  private resumeUntil = 0;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private unwatchVisibility: () => void = () => undefined;
  private stopError: ProtocolError | null = null;
  private disconnectHandlers = new Set<(error: ProtocolError) => void>();

  constructor(
    private readonly channel: FrameChannel,
    private readonly routeId: Uint8Array,
    private readonly c2s: Direction,
    private readonly s2c: Direction,
    private readonly emit: (event: SessionEvent) => void,
  ) {
    channel.onDiagnostic?.((details) => this.diagnose("transport_closed", details));
    this.diagnose("session_open");
    channel.use((frame) => this.receive(frame));
    channel.onClose((error) => this.disconnect(error));
    if (this.stopped) return;
    const beat = () => {
      if (this.stopped || pageHidden() || this.hidden || performance.now() < this.resumeUntil) return;
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
        this.disconnect(new ProtocolError("disconnected", "心跳发送失败", { reason: "heartbeat_send_failed" }));
        this.channel.close(1011, "heartbeat send failed");
      }
    };
    this.unwatchVisibility = watchPageVisibility((hidden) => this.setPageHidden(hidden));
    this.setPageHidden(this.hidden);
    this.heartbeat = globalThis.setInterval(beat, HEARTBEAT_MS);
    beat();
  }

  private setPageHidden(hidden: boolean): void {
    if (this.stopped) return;
    const wasHidden = this.hidden;
    if (!hidden && !wasHidden) return;
    this.hidden = hidden;
    this.diagnose(hidden ? "page_hidden" : "page_visible");
    if (this.resumeTimer !== null) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    if (hidden) {
      this.directChannel()?.pauseIceWatch("page");
    } else if (wasHidden) {
      // Preserve the outstanding PING so a queued PONG is still validated.
      // Background time must not spend the foreground recovery budget.
      this.resumeUntil = performance.now() + DIRECT_RESUME_GRACE_MS;
      this.resumeTimer = globalThis.setTimeout(() => {
        this.resumeTimer = null;
        if (!this.stopped && !pageHidden()) this.directChannel()?.resumeIceWatch("page");
      }, DIRECT_RESUME_GRACE_MS);
    }
  }

  private stopLifecycle(): void {
    clearInterval(this.heartbeat);
    this.unwatchVisibility();
    if (this.resumeTimer !== null) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
  }

  get kind(): FrameChannelKind { return this.channel.kind; }

  directChannel(): DataFrameChannel | null {
    return this.channel instanceof DataFrameChannel ? this.channel : null;
  }

  onDisconnect(handler: (error: ProtocolError) => void): void {
    this.disconnectHandlers.add(handler);
    if (this.stopError) handler(this.stopError);
  }

  async rpc(op: string, params: unknown, timeoutMs = READ_RPC_TIMEOUT_MS, onSent?: () => void, onLate?: (result: unknown) => void): Promise<unknown> {
    if (this.stopped) throw new ProtocolError("disconnected", "连接正在恢复");
    if (this.pending.size >= MAX_IN_FLIGHT) throw new ProtocolError("backpressure", "请求过多，请稍后再试");
    const id = `req_${b64url(crypto.getRandomValues(new Uint8Array(12)))}`;
    const plaintext = new TextEncoder().encode(JSON.stringify({ v: 1, id, op, params }));
    return new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.pending.delete(id);
        this.rememberLate(id, onLate);
        reject(new ProtocolError("timeout", `${op} 响应超时；写操作不会自动重试`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.sendSealed(plaintext);
        onSent?.();
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.dropLate(id);
        reject(error instanceof ProtocolError ? error : new ProtocolError("disconnected", String(error)));
        this.failEpoch(new ProtocolError("disconnected", "加密帧发送失败，正在恢复连接", { reason: "encrypted_send_failed" }));
      }
    });
  }

  /** Remember a best-effort late-success callback with a finite TTL and hard cap. */
  private rememberLate(id: string, fn?: (result: unknown) => void): void {
    if (!fn) return;
    if (this.late.size >= MAX_LATE_CALLBACKS) {
      // Evict the oldest abandoned entry: its orphaned remote handle is reclaimed
      // by the daemon idle/teardown, so this epoch keeps accepting new requests.
      const oldest = this.late.keys().next().value;
      if (oldest !== undefined) this.dropLate(oldest);
    }
    const entry: Late = {
      fn,
      expires: globalThis.setTimeout(() => this.dropLate(id), LATE_CALLBACK_TTL_MS),
    };
    this.late.set(id, entry);
  }

  private dropLate(id: string): void {
    const entry = this.late.get(id);
    if (!entry) return;
    clearTimeout(entry.expires);
    this.late.delete(id);
  }

  async waitIdle(timeoutMs = 2_000): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (this.pending.size > 0) {
      if (this.stopped) throw this.stopError ?? new ProtocolError("disconnected", "连接已断开");
      if (performance.now() >= deadline) throw new ProtocolError("timeout", "等待在途请求完成超时");
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 5));
    }
  }

  close(reason = "local_close"): void {
    if (this.stopped) return;
    this.diagnose("session_close", { reason });
    this.stopped = true;
    this.stopLifecycle();
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
        try {
          this.channel.send({ ...frame, typ: Typ.PONG });
        } catch {
          this.failEpoch(new ProtocolError("disconnected", "心跳发送失败", { reason: "heartbeat_send_failed" }));
        }
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
      if (!pending) {
        // A request that timed out client-side still observes a late response:
        // a SUCCESS result closes the now-orphaned remote handle; an ERROR has
        // no handle to close. Either way the bounded late entry (map + TTL timer)
        // is consumed immediately, not held until its TTL. Drop before the
        // callback so a reentrant/duplicate response cannot replay it.
        const late = this.late.get(message.id);
        if (late) {
          this.dropLate(message.id);
          if (message.kind === "response" && message.ok) late.fn(message.result);
        }
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      this.dropLate(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new ProtocolError(message.error.code, message.error.message));
    } catch (error) {
      this.disconnect(error instanceof ProtocolError ? error : new ProtocolError("bad_message", String(error)));
      this.channel.close(1002, "bad session frame");
    }
  }

  private sendSealed(plaintext: Uint8Array): void {
    const payload = this.c2s.seal(this.routeId, plaintext);
    this.channel.send({ version: 1, typ: Typ.FWD, flags: 0, routeId: this.routeId, payload });
  }

  private sendResponse(id: string, ok: boolean, result?: unknown, error?: { code: string; message: string }): void {
    const plaintext = new TextEncoder().encode(JSON.stringify({ v: 1, id, ok, ...(ok ? { result } : { error }) }));
    try {
      this.sendSealed(plaintext);
    } catch {
      this.failEpoch(new ProtocolError("disconnected", "加密帧发送失败，正在恢复连接", { reason: "encrypted_send_failed" }));
    }
  }

  private rejectPending(error: ProtocolError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const id of [...this.late.keys()]) this.dropLate(id);
    this.late.clear();
  }

  private failEpoch(error: ProtocolError): void {
    this.disconnect(error);
    try {
      this.channel.close(1011, "send failed");
    } catch {
      /* already closed */
    }
  }

  diagnose(event: string, details: ConnectionDetails & { code?: string } = {}): void {
    recordConnectionDiagnostic({
      event, route_id: Array.from(this.routeId, (byte) => byte.toString(16).padStart(2, "0")).join(""),
      transport: this.kind, hidden: this.hidden, pending_rpcs: this.pending.size,
      pong_wait_ms: this.expectedPong ? Math.max(0, performance.now() - this.expectedPongAt) : 0,
      ...this.channel.diagnosticState?.(), ...details,
    });
  }

  private disconnect(error: ProtocolError): void {
    if (this.stopped) return;
    this.diagnose("disconnect", { code: error.code, reason: error.code, ...error.diagnostics });
    this.stopped = true;
    this.stopError = error;
    this.stopLifecycle();
    this.rejectPending(error);
    for (const handler of this.disconnectHandlers) handler(error);
  }
}
