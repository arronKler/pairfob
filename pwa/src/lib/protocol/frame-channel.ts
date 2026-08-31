import type { Frame } from "./envelope.ts";
import type { ProtocolError } from "./errors.ts";

export type FrameChannelKind = "relay" | "p2p";

/** Ordered binary frame transport used by an established Pairfob session. */
export interface FrameChannel {
  readonly kind: FrameChannelKind;
  send(frame: Frame): void;
  close(code?: number, reason?: string): void;
  next(timeoutMs: number): Promise<Frame>;
  use(handler: (frame: Frame) => void): void;
  onClose(handler: (error: ProtocolError) => void): () => void;
}
