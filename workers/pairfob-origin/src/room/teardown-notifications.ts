import { sendErr } from "../frames.ts";
import type { RoomSocket } from "./types.ts";

/** Only notification transport failures are deferred; storage and attachment errors escape. */
export class TeardownNotifications {
  private failure: { error: unknown } | undefined;

  send(ws: RoomSocket, data: Uint8Array): void {
    try {
      ws.send(data);
    } catch (error) {
      // workerd rejects sending after a local close. Do not classify arbitrary
      // TypeErrors or instance/storage failures as harmless disconnects.
      if (error instanceof TypeError && error.message === "Can't call WebSocket send() after close().") return;
      this.failure ??= { error };
    }
  }

  error(ws: RoomSocket, code: string, message: string, extra?: Parameters<typeof sendErr>[3]): void {
    sendErr({ send: (data) => this.send(ws, data), close: () => {} }, code, message, extra);
  }

  close(ws: RoomSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch (error) {
      // Runtime close() already ignores repeated closes. Other failures are
      // unexpected, but must not prevent local cleanup or closing other peers.
      this.failure ??= { error };
    }
  }

  finish(): void {
    if (this.failure) throw this.failure.error;
  }
}
