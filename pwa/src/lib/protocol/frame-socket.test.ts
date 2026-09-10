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

test("WebSocket close retains code and cleanliness but excludes remote reason", async () => {
  const { FrameSocket } = await import("./frame-socket");
  const ws = new EventTarget();
  const link = new FrameSocket(ws as WebSocket);
  const failures: ProtocolError[] = [];
  link.onClose((error) => failures.push(error));
  const event = new Event("close");
  Object.assign(event, { code: 1006, wasClean: false, reason: "secret from remote" });
  ws.dispatchEvent(event);
  ws.dispatchEvent(event);
  expect(failures).toHaveLength(1);
  expect(failures[0]!.diagnostics).toEqual({ reason: "websocket_closed", ws_code: 1006, ws_clean: false });
  expect(JSON.stringify(failures)).not.toContain("secret");
});

test("error followed by close preserves terminal evidence without a second disconnect", async () => {
  const { FrameSocket } = await import("./frame-socket");
  const ws = new EventTarget();
  const link = new FrameSocket(ws as WebSocket);
  const failures: ProtocolError[] = [];
  const terminal: unknown[] = [];
  link.onClose((error) => failures.push(error));
  link.onDiagnostic((details) => terminal.push(details));
  ws.dispatchEvent(new Event("error"));
  const close = new Event("close");
  Object.assign(close, { code: 1006, wasClean: false, reason: "private remote text" });
  ws.dispatchEvent(close);
  expect(failures).toHaveLength(1);
  expect(failures[0]!.diagnostics?.reason).toBe("websocket_error");
  expect(terminal).toEqual([{ reason: "websocket_closed", ws_code: 1006, ws_clean: false }]);
});
