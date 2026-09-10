import type { ConnectionDetails } from "./connection-diagnostics.ts";
import type { Frame } from "./envelope.ts";
import type { ProtocolError } from "./errors.ts";

export type FrameChannelKind = "relay" | "p2p";

/** Ordered binary frame transport used by an established Pairfob session. */
export interface FrameChannel {
  readonly kind: FrameChannelKind;
  onDiagnostic?(handler: (details: ConnectionDetails) => void): void;
  diagnosticState?(): ConnectionDetails;
  send(frame: Frame): void;
  close(code?: number, reason?: string): void;
  next(timeoutMs: number): Promise<Frame>;
  use(handler: (frame: Frame) => void): void;
  onClose(handler: (error: ProtocolError) => void): () => void;
}
