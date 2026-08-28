import { describe, expect, test } from "bun:test";
import { ProtocolError } from "./errors.ts";
import { openWS } from "./frame-socket.ts";

describe("WebSocket connection cancellation", () => {
  test("closes an in-flight dial as soon as its signal aborts", async () => {
    const original = globalThis.WebSocket;
    let closed = 0;
    class PendingWebSocket extends EventTarget {
      binaryType: BinaryType = "blob";
      protocol = "";
      close(): void {
        closed++;
        this.dispatchEvent(new Event("close"));
      }
    }
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: PendingWebSocket });
    try {
      const controller = new AbortController();
      const pending = openWS("wss://pairfob.test/v2/ws", "pairfob.v2", controller.signal);
      controller.abort();
      const error = await pending.catch((caught) => caught);
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe("disconnected");
      expect(closed).toBe(1);
    } finally {
      Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: original });
    }
  });
});
