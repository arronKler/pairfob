import { b64url, b64urlDecode } from "./bytes.ts";
import { decode, encode, parseJSON, type Frame } from "./envelope.ts";
import { ProtocolError } from "./errors.ts";
import type { FrameChannel } from "./frame-channel.ts";

/** Zero route_id for HELLO/ATTACH control frames. Pair and session share send, heartbeat, and envelope checks. */
export const Z16 = new Uint8Array(16);
export const HEARTBEAT_MS = 25_000;
export const MAX_HANDSHAKE_QUEUE = 64;

export function enqueueHandshakeFrame(queue: Frame[], frame: Frame): void {
  if (queue.length >= MAX_HANDSHAKE_QUEUE) throw new ProtocolError("backpressure", "握手帧队列溢出");
  queue.push(frame);
}

export function heartbeatPayload(counter: bigint): Uint8Array {
  if (counter < 0n || counter > 0xffff_ffff_ffff_ffffn) throw new RangeError("heartbeat counter");
  const payload = new Uint8Array(8);
  new DataView(payload.buffer).setBigUint64(0, counter, false);
  return payload;
}

export function requireHeartbeatPayload(payload: Uint8Array): void {
  if (payload.length !== 8) throw new ProtocolError("bad_frame", "PING/PONG payload 必须是 8 字节");
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function parseExactB64(value: unknown, bytes: number, field: string): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ProtocolError("bad_message", `${field} 格式错误`);
  }
  const decoded = b64urlDecode(value);
  if (decoded.length !== bytes || b64url(decoded) !== value) {
    throw new ProtocolError("bad_message", `${field} 长度或编码错误`);
  }
  return decoded;
}

export function relayOrigin(relayWS: string): string {
  const url = new URL(relayWS);
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  else throw new ProtocolError("bad_relay", "relay 必须使用 ws/wss");
  return url.origin;
}

export function send(ws: WebSocket, frame: Frame): void {
  if (ws.readyState !== WebSocket.OPEN) throw new ProtocolError("disconnected", "连接已断开");
  ws.send(encode(frame));
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new ProtocolError("bad_frame", "WebSocket 收到非二进制帧");
}

/** Exactly one message listener owns every frame for a socket. */
export class FrameSocket implements FrameChannel {
  readonly kind = "relay" as const;
  private queue: Frame[] = [];
  private waiters: Array<{ resolve: (frame: Frame) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  private handler: ((frame: Frame) => void) | null = null;
  private closeHandlers = new Set<(error: ProtocolError) => void>();
  private ended = false;

  constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (event: MessageEvent) => {
      try {
        const frame = decode(toBytes(event.data));
        if (frame.version !== 1) throw new ProtocolError("bad_frame", "协议版本错误");
        if (this.handler) this.handler(frame);
        else if (this.waiters.length) {
          const waiter = this.waiters.shift()!;
          clearTimeout(waiter.timer);
          waiter.resolve(frame);
        } else {
          enqueueHandshakeFrame(this.queue, frame);
        }
      } catch (error) {
        this.fail(error instanceof ProtocolError ? error : new ProtocolError("bad_frame", String(error)));
        ws.close(1002, "bad frame");
      }
    });
    ws.addEventListener("close", () => this.fail(new ProtocolError("disconnected", "连接已断开")));
    ws.addEventListener("error", () => this.fail(new ProtocolError("disconnected", "WebSocket 错误")));
  }

  send(frame: Frame): void {
    send(this.ws, frame);
  }

  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }

  next(timeoutMs: number): Promise<Frame> {
    if (this.ended) return Promise.reject(new ProtocolError("disconnected", "连接已断开"));
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    return new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new ProtocolError("timeout", "等待协议响应超时"));
      }, timeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  use(handler: (frame: Frame) => void): void {
    if (this.waiters.length) throw new Error("pending frame waiter");
    this.handler = handler;
    const queued = this.queue;
    this.queue = [];
    for (const frame of queued) handler(frame);
  }

  onClose(handler: (error: ProtocolError) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  private fail(error: ProtocolError): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    for (const handler of this.closeHandlers) handler(error);
  }
}

/** Open one mux socket. Do not retry a different subprotocol after 426 / mismatch. */
export function openWS(url: string, subprotocol = "pairfob.v1", signal?: AbortSignal): Promise<FrameSocket> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProtocolError("disconnected", "连接已取消"));
      return;
    }
    const ws = new WebSocket(url, [subprotocol]);
    ws.binaryType = "arraybuffer";
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      ws.close(1000, "connection cancelled");
      reject(new ProtocolError("disconnected", "连接已取消"));
    };
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      ws.close();
      reject(new ProtocolError("ws_open_failed", "连接 relay 超时"));
    }, 10_000);
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new ProtocolError("ws_open_failed", "无法连接 relay"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    ws.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      cleanup();
      ws.removeEventListener("error", fail);
      ws.removeEventListener("close", fail);
      if (ws.protocol !== subprotocol) {
        ws.close(1002, "subprotocol required");
        reject(new ProtocolError("wrong_protocol", `relay 未协商 ${subprotocol}`));
        return;
      }
      resolve(new FrameSocket(ws));
    }, { once: true });
    ws.addEventListener("error", fail, { once: true });
    ws.addEventListener("close", fail, { once: true });
  });
}

export function envelopeError(frame: Frame): ProtocolError {
  try {
    const body = parseJSON(frame);
    return new ProtocolError(String(body.code || "error"), String(body.message || body.code || "协议错误"));
  } catch {
    return new ProtocolError("error", "relay 返回无法解析的错误");
  }
}
