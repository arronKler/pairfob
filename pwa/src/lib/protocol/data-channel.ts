import { enqueueHandshakeFrame } from "./frame-socket.ts";
import { DirectFrameAssembler, splitDirectFrame } from "./direct-frame.ts";
import { decode, encode, type Frame } from "./envelope.ts";
import { ProtocolError } from "./errors.ts";
import type { FrameChannel } from "./frame-channel.ts";

const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

function toBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new ProtocolError("bad_frame", "DataChannel 收到非二进制帧");
}

/** RTCDataChannel adapter at the same frame seam as FrameSocket. */
export class DataFrameChannel implements FrameChannel {
  readonly kind = "p2p" as const;
  private queue: Frame[] = [];
  private waiters: Array<{ resolve: (frame: Frame) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  private handler: ((frame: Frame) => void) | null = null;
  private closeHandlers = new Set<(error: ProtocolError) => void>();
  private ended = false;
  private assembler = new DirectFrameAssembler();

  constructor(private readonly channel: RTCDataChannel, private readonly peer: RTCPeerConnection) {
    channel.binaryType = "arraybuffer";
    channel.addEventListener("message", (event) => {
      try {
        const complete = this.assembler.push(toBytes(event.data));
        if (!complete) return;
        const frame = decode(complete);
        if (frame.version !== 1) throw new ProtocolError("bad_frame", "协议版本错误");
        if (this.handler) this.handler(frame);
        else if (this.waiters.length) {
          const waiter = this.waiters.shift()!;
          clearTimeout(waiter.timer);
          waiter.resolve(frame);
        } else enqueueHandshakeFrame(this.queue, frame);
      } catch (error) {
        this.fail(error instanceof ProtocolError ? error : new ProtocolError("bad_frame", String(error)));
        this.close();
      }
    });
    channel.addEventListener("close", () => {
      this.fail(new ProtocolError("disconnected", "P2P 连接已断开"));
      try { this.peer.close(); } catch { /* already closed */ }
    });
    channel.addEventListener("error", () => {
      this.fail(new ProtocolError("disconnected", "P2P DataChannel 错误"));
      this.close();
    });
  }

  send(frame: Frame): void {
    if (this.channel.readyState !== "open") throw new ProtocolError("disconnected", "P2P 连接已断开");
    const chunks = splitDirectFrame(encode(frame));
    const bytes = chunks.reduce((total, chunk) => total + chunk.length, 0);
    if (this.channel.bufferedAmount + bytes > MAX_BUFFERED_BYTES) throw new ProtocolError("backpressure", "P2P 发送队列已满");
    try {
      for (const chunk of chunks) this.channel.send(chunk.buffer as ArrayBuffer);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close(): void {
    try { this.channel.close(); } catch { /* already closed */ }
    try { this.peer.close(); } catch { /* already closed */ }
    this.fail(new ProtocolError("closed", "P2P 连接已关闭"));
  }

  next(timeoutMs: number): Promise<Frame> {
    if (this.ended) return Promise.reject(new ProtocolError("disconnected", "P2P 连接已断开"));
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    return new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new ProtocolError("timeout", "等待 P2P 协议响应超时"));
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
