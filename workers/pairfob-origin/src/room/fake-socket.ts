import type { Attachment } from "./attachment.ts";
import type { RoomSocket } from "./types.ts";

export class FakeSocket implements RoomSocket {
  sent: Uint8Array[] = [];
  lastSentInput: Uint8Array | null = null;
  closed = false;
  closeCode = 0;
  closeReason = "";
  attachmentReads = 0;
  private att: Attachment | null = null;
  readonly id: string;

  constructor(id = "s") {
    this.id = id;
  }

  send(data: Uint8Array): void {
    if (this.closed) return;
    this.lastSentInput = data;
    this.sent.push(data.slice());
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code ?? 1000;
    this.closeReason = reason ?? "";
  }

  serializeAttachment(att: Attachment): void {
    this.att = { ...att };
  }

  deserializeAttachment(): Attachment | null {
    this.attachmentReads++;
    return this.att ? { ...this.att } : null;
  }
}

/** Models a runtime-provided view of the same hibernated WebSocket. */
export class FakeSocketView implements RoomSocket {
  constructor(private readonly socket: FakeSocket) {}

  send(data: Uint8Array): void {
    this.socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  serializeAttachment(att: Attachment): void {
    this.socket.serializeAttachment(att);
  }

  deserializeAttachment(): Attachment | null {
    return this.socket.deserializeAttachment();
  }
}
