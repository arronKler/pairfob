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

  isRetired(): boolean {
    return this.deserializeAttachment()?.retired === true;
  }

  send(data: Uint8Array): void {
    if (this.isRetired()) throw new TypeError("Can't call WebSocket send() after close().");
    this.ws.send(data);
  }

  close(code?: number, reason?: string): void {
    const att = this.deserializeAttachment();
    if (att?.retired) return;
    // A half-closed runtime socket can report OPEN after repeated hibernation.
    // Persist retirement before closing so reconstruction cannot revive it.
    if (att) this.serializeAttachment({ ...att, retired: true });
    this.ws.close(code, reason);
  }

  serializeAttachment(att: Attachment): void {
    // Cleanup may write an attachment captured before close(). Retirement is final.
    const next = this.isRetired() ? { ...att, retired: true } : att;
    this.ws.serializeAttachment(next);
    this.attachment = { ...next };
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
    if (!w.isRetired()) out.push(w);
  }
  return out;
}
