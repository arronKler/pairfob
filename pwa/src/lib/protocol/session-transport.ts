import type { RecoveryClock } from "./recovery-diagnostics";
import { recordConnectionDiagnostic, type ConnectionDetails } from "./connection-diagnostics.ts";
import { Direction, AEAD_SEAL_OVERHEAD } from "./aead.ts";
import { b64url } from "./bytes.ts";
import { DataFrameChannel } from "./data-channel.ts";
import { decodeUTF8, HEADER_SIZE, Typ, type Frame } from "./envelope.ts";
import { envelopeError, HEARTBEAT_MS, heartbeatPayload, requireHeartbeatPayload, sameBytes } from "./frame-socket.ts";
import type { FrameChannel, FrameChannelKind } from "./frame-channel.ts";
import { ProtocolError } from "./errors.ts";
import { validateSessionMessage } from "./session-message.ts";
import type { SessionEvent } from "./session-types.ts";

import { pageHidden, watchPageVisibility } from "./page-activity.ts";
import { DIRECT_RESUME_GRACE_MS } from "./direct-retry-policy.ts";

const MAX_IN_FLIGHT = 32;
/**
 * Bulk upload writes admitted at once, counting requests waiting for buffer
 * budget AND requests already sent. Well below MAX_IN_FLIGHT so interactive
 * RPCs always keep free slots even with a full bulk pipeline.
 */
export const MAX_BULK_IN_FLIGHT = 4;
/** Only the two chunk-write RPCs are bulk; every other RPC seals immediately. */
const BULK_RPC_OPS = new Set(["WorkspaceUploadWrite", "WorkspaceUploadWriteV2"]);
/** Snapshot/Ping/History and other reads. */
export const READ_RPC_TIMEOUT_MS = 8_000;
/**
 * GetConfig describes the runtime and the daemon allows that work up to 12 s.
 * The client deadline sits above the daemon's own budget, so a slow but healthy
 * answer is never mistaken for a Herdr that cannot be confirmed.
 */
export const CONFIG_RPC_TIMEOUT_MS = 15_000;
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

type Pending = {
  op: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** `performance.now()` at which the caller stops waiting. */
  deadline: number;
  /** `performance.now()` when the caller first waited; carried requests keep mine. */
  startedAt: number;
  onLate?: (result: unknown) => void;
  /** Opt-in streamed read: true consumes a delta without extending its deadline. */
  onProgress?: (result: unknown) => boolean;
  /** Sealed and sent; a bulk job may still be waiting for send budget. */
  sent: boolean;
  /** Bulk upload write: admitted through the hard 4-job cap. */
  bulk: boolean;
  /** Counts toward bulkActive from admission until settled; released once. */
  counted: boolean;
  /** Aborts the pre-seal readiness wait on timeout/response/close. */
  abort: AbortController;
};
type Late = { fn: (result: unknown) => void; expires: ReturnType<typeof setTimeout>; until: number };
/**
 * Requests already sent when the computer moved the session to another route.
 * It answers them on the route it moved to, so they leave unsettled.
 */
export type CarriedRequests = { readonly pending: ReadonlyMap<string, Pending>; readonly late: ReadonlyMap<string, Late> };
/**
 * WorkspaceMediaOpen hashes up to 32 MiB at 8 MiB/s session disk quota
 * (~4 s) plus sniff/JPEG scan. 20 s matches the daemon Open deadline and
 * leaves READ_RPC_TIMEOUT_MS / TERMINAL_RPC_TIMEOUT_MS unchanged.
 */
export const MEDIA_OPEN_RPC_TIMEOUT_MS = 20_000;

export type FlightRead = { op: string; params: unknown };
/** A read already on the wire; the transport built on its epoch adopts it. */
export type SentRead = FlightRead & {
  id: string;
  answer: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

/** A read sent ahead keeps the deadline its op gets when the screen asks. */
function readTimeoutMs(op: string): number {
  return op === "GetConfig" ? CONFIG_RPC_TIMEOUT_MS : READ_RPC_TIMEOUT_MS;
}

function encodeRequest(op: string, params: unknown): { id: string; plaintext: Uint8Array } {
  const id = `req_${b64url(crypto.getRandomValues(new Uint8Array(12)))}`;
  return { id, plaintext: new TextEncoder().encode(JSON.stringify({ v: 1, id, op, params })) };
}

/**
 * Seal reads on a fresh epoch and send them behind DeviceHello3, before
 * SESSION_ESTABLISHED has come back. Reads only: a mutation never rides here.
 */
export function sendFlightReads(
  channel: FrameChannel,
  epoch: { routeId: Uint8Array; c2s: Direction },
  reads: readonly FlightRead[],
): SentRead[] {
  return reads.map((read) => {
    const { id, plaintext } = encodeRequest(read.op, read.params);
    channel.send({ version: 1, typ: Typ.FWD, flags: 0, routeId: epoch.routeId, payload: epoch.c2s.seal(epoch.routeId, plaintext) });
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const answer = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
    // Nobody may be waiting for a read that was sent ahead.
    answer.catch(() => undefined);
    return { ...read, id, answer, resolve, reject };
  });
}

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
  recoveryDiagnostic: RecoveryClock | undefined;
  private stopped = false;
  private hidden = pageHidden();
  private resumeUntil = 0;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private unwatchVisibility: () => void = () => undefined;
  private stopError: ProtocolError | null = null;
  private disconnectHandlers = new Set<(error: ProtocolError) => void>();
  private bulkActive = 0;
  /**
   * Serializes ONLY the bulk pre-seal critical section (wait budget -> seal ->
   * send). At most MAX_BULK_IN_FLIGHT admitted jobs exist; the tail makes their
   * readiness checks sequential so several resolved waiters can never burst
   * past the 1 MiB budget. It never waits for an RPC response.
   */
  private bulkTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly channel: FrameChannel,
    private readonly routeId: Uint8Array,
    private readonly c2s: Direction,
    private readonly s2c: Direction,
    private readonly emit: (event: SessionEvent) => void,
    sent: readonly SentRead[] = [],
    carried?: CarriedRequests,
  ) {
    channel.onDiagnostic?.((details) => this.diagnose("transport_closed", details));
    // Before taking the channel, which may already hold their answers; and
    // before the record, whose pending count then says how many were carried.
    if (carried) this.carryIn(carried);
    this.diagnose("session_open");
    for (const read of sent) this.adopt(read);
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

  private adopt(read: SentRead): void {
    const timeout = readTimeoutMs(read.op);
    const entry: Pending = {
      op: read.op, resolve: read.resolve, reject: read.reject, bulk: false, counted: false, abort: new AbortController(),
      deadline: performance.now() + timeout, sent: true, startedAt: performance.now(),
      timer: globalThis.setTimeout(() => this.expireRPC(read.id, entry, read.op), timeout),
    };
    this.pending.set(read.id, entry);
  }

  /**
   * Give up the requests already sent, unsettled, once the computer has moved
   * the session to another route: it answers them there. Bulk jobs still waiting
   * for send budget were never sent and stay to fail with this transport.
   */
  carryOut(): CarriedRequests {
    const pending = new Map<string, Pending>();
    for (const [id, entry] of this.pending) {
      if (!entry.sent) continue;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      if (entry.counted) this.bulkActive--;
      pending.set(id, entry);
    }
    const late = new Map(this.late);
    for (const entry of late.values()) clearTimeout(entry.expires);
    this.late.clear();
    return { pending, late };
  }

  /** Take over carried requests, keeping each caller's deadline. */
  private carryIn(carried: CarriedRequests): void {
    const now = performance.now();
    for (const [id, entry] of carried.pending) {
      if (entry.counted) this.bulkActive++;
      entry.timer = globalThis.setTimeout(() => this.expireRPC(id, entry, entry.op, entry.onLate), Math.max(0, entry.deadline - now));
      this.pending.set(id, entry);
    }
    for (const [id, entry] of carried.late) {
      entry.expires = globalThis.setTimeout(() => this.dropLate(id), Math.max(0, entry.until - now));
      this.late.set(id, entry);
    }
  }

  async rpc(op: string, params: unknown, timeoutMs = READ_RPC_TIMEOUT_MS, onSent?: () => void, onLate?: (result: unknown) => void, onProgress?: (result: unknown) => boolean): Promise<unknown> {
    if (this.stopped) throw new ProtocolError("disconnected", "连接正在恢复");
    if (this.pending.size >= MAX_IN_FLIGHT) throw new ProtocolError("backpressure", "请求过多，请稍后再试");
    const bulk = BULK_RPC_OPS.has(op);
    // Hard bulk cap over EVERY admitted bulk job: queued on the send tail,
    // waiting for buffer budget, or already sent. The 5th is rejected before
    // any request id / plaintext / pending entry / timer allocation, so the
    // rejected call can never grow an admission queue. Interactive RPCs keep
    // the remaining capacity (MAX_IN_FLIGHT - MAX_BULK_IN_FLIGHT = 28).
    if (bulk && this.bulkActive >= MAX_BULK_IN_FLIGHT) {
      throw new ProtocolError("backpressure", "批量上传在途请求已达上限，请等待确认后再发");
    }
    const { id, plaintext } = encodeRequest(op, params);
    // Exact whole-frame cost used for pre-seal admission: 24 B envelope header
    // plus the AEAD nonce/tag expansion; P2P fragment headers are added by the
    // DataChannel adapter.
    const frameBytes = HEADER_SIZE + plaintext.length + AEAD_SEAL_OVERHEAD;
    return new Promise<unknown>((resolve, reject) => {
      const abort = new AbortController();
      const entry: Pending = {
        op, resolve, reject, bulk, counted: bulk, abort, deadline: performance.now() + timeoutMs, onLate, sent: false,
        startedAt: performance.now(), onProgress,
        timer: globalThis.setTimeout(() => this.expireRPC(id, entry, op, onLate), timeoutMs),
      };
      this.bulkActive += bulk ? 1 : 0;
      this.pending.set(id, entry);
      // Interactive RPCs bypass the bulk tail and seal in THIS tick, so they
      // preempt bulk jobs that are still waiting for send budget. Bulk jobs
      // run their wait->seal->send critical section one at a time on the tail.
      if (bulk) this.enqueueBulk(id, entry, plaintext, frameBytes, onSent);
      else this.sealAndSend(id, entry, plaintext, onSent);
    });
  }

  /** Client-side deadline: settle exactly once and release the bulk count. */
  private expireRPC(id: string, entry: Pending, op: string, onLate?: (result: unknown) => void): void {
    if (!this.pending.has(id)) return;
    this.pending.delete(id);
    entry.abort.abort();
    this.releaseBulk(entry);
    this.rememberLate(id, onLate);
    // The only local record of a path stall: the computer may still answer PING
    // while this read went unanswered, which is exactly the case the heartbeat
    // cannot see. `pending_rpcs` is what remained stuck beside it.
    this.diagnose("rpc_timeout", { code: "timeout", reason: op, elapsed_ms: performance.now() - entry.startedAt });
    entry.reject(new ProtocolError("timeout", `${op} 响应超时；写操作不会自动重试`));
  }

  /**
   * Append one admitted bulk job to the serialization tail. The tail advances
   * as soon as the frame was seal-sent (NOT when the RPC responds), and every
   * rejection is observed so the chain can never stall or surface unhandled.
   */
  private enqueueBulk(
    id: string,
    entry: Pending,
    plaintext: Uint8Array,
    frameBytes: number,
    onSent?: () => void,
  ): void {
    const run = this.bulkTail.then(() => this.dispatchBulk(id, entry, plaintext, frameBytes, onSent));
    this.bulkTail = run.then(() => undefined, () => undefined);
  }

  /**
   * One bulk pre-seal critical section on the tail: alive -> wait for one
   * whole frame of channel budget -> alive -> seal/send synchronously. No await
   * sits between seal and send; no ciphertext is ever queued. Readiness
   * failure settles the RPC itself (never retiring a healthy epoch); a closed
   * epoch has already rejected the pending entry.
   */
  private async dispatchBulk(
    id: string,
    entry: Pending,
    plaintext: Uint8Array,
    frameBytes: number,
    onSent?: () => void,
  ): Promise<void> {
    if (!this.isLive(id)) return;
    try {
      await this.channel.waitWritable?.(frameBytes, entry.abort.signal);
    } catch (error) {
      if (this.pending.has(id)) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.abort.abort();
        this.releaseBulk(entry);
        entry.reject(error instanceof ProtocolError ? error : new ProtocolError("disconnected", String(error)));
      }
      return;
    }
    if (!this.isLive(id)) return;
    this.sealAndSend(id, entry, plaintext, onSent);
  }

  /** True while the epoch is open and this RPC has not settled. */
  private isLive(id: string): boolean {
    return !this.stopped && this.pending.has(id);
  }

  /**
   * Seal and send one frame as a single synchronous block: the AEAD nonce is
   * allocated only at actual send time, and onSent fires only after the WHOLE
   * frame (all P2P fragments) came back from send — never at enqueue. A
   * post-seal send failure is wire uncertainty and keeps the existing
   * failEpoch behavior (the gapped epoch must not continue).
   */
  private sealAndSend(id: string, entry: Pending, plaintext: Uint8Array, onSent?: () => void): void {
    try {
      this.sendSealed(plaintext);
      entry.sent = true;
      onSent?.();
    } catch (error) {
      if (this.pending.has(id)) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.abort.abort();
        this.releaseBulk(entry);
        entry.reject(error instanceof ProtocolError ? error : new ProtocolError("disconnected", String(error)));
      }
      this.failEpoch(new ProtocolError("disconnected", "加密帧发送失败，正在恢复连接", { reason: "encrypted_send_failed" }));
    }
  }

  private releaseBulk(entry: Pending): void {
    if (!entry.counted) return;
    entry.counted = false;
    this.bulkActive--;
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
      until: performance.now() + LATE_CALLBACK_TTL_MS,
    };
    this.late.set(id, entry);
  }

  private dropLate(id: string): void {
    const entry = this.late.get(id);
    if (!entry) return;
    clearTimeout(entry.expires);
    this.late.delete(id);
  }

  /** `pending` is what requests still out learn; a carried mutation may need to hear its outcome is unknown. */
  close(reason = "local_close", pending = new ProtocolError("closed", "会话已关闭")): void {
    if (this.stopped) return;
    this.diagnose("session_close", { reason });
    this.stopped = true;
    this.stopLifecycle();
    this.rejectPending(pending);
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
      if (message.ok && pending.onProgress?.(message.result)) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      pending.abort.abort();
      this.releaseBulk(pending);
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
      pending.abort.abort();
      this.releaseBulk(pending);
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

  diagnose(event: string, details: ConnectionDetails & { code?: string; elapsed_ms?: number } = {}): void {
    recordConnectionDiagnostic({
      ...this.recoveryDiagnostic?.(), event, route_id: Array.from(this.routeId, (byte) => byte.toString(16).padStart(2, "0")).join(""),
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
