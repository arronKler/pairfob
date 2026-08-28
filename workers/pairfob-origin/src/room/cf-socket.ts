import { readAttachment, type Attachment } from "./attachment.ts";
import type { RoomSocket } from "./types.ts";

export interface HibernatingSocket {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(att: Attachment): void;
  deserializeAttachment(): unknown;
}

export class CfSocket implements RoomSocket {
  private attachment: Attachment | null | undefined;

  constructor(private readonly ws: HibernatingSocket) {}

  send(data: Uint8Array): void {
    this.ws.send(data);
  }

  close(code?: number, reason?: string): void {
    try {
      this.ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }

  serializeAttachment(att: Attachment): void {
    this.ws.serializeAttachment(att);
    this.attachment = { ...att };
  }

  deserializeAttachment(): Attachment | null {
    if (this.attachment === undefined) {
      this.attachment = readAttachment(this.ws.deserializeAttachment());
    }
    // Callers mutate attachments before writeAtt(); keep the cached authority isolated.
    return this.attachment ? { ...this.attachment } : null;
  }
}

export function wrapSockets(raw: WebSocket[], cache: WeakMap<WebSocket, CfSocket>): CfSocket[] {
  const out: CfSocket[] = [];
  for (const ws of raw) {
    let w = cache.get(ws);
    if (!w) {
      w = new CfSocket(ws);
      cache.set(ws, w);
    }
    out.push(w);
  }
  return out;
}
