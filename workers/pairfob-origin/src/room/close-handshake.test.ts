import { describe, expect, test } from "bun:test";
import { newAttachment } from "./attachment.ts";
import { CfSocket } from "./cf-socket.ts";
import { DaemonRoom } from "./room.ts";

function setup(options: { metadataError?: unknown; cleanupError?: unknown; closeError?: unknown; retired?: boolean } = {}) {
  const calls: string[] = [];
  const replies: (number | undefined)[] = [];
  const reasons: string[] = [];
  const attachment = newAttachment("daemon", 1, { hello_at_ms: 1, retired: options.retired });
  const ws = {
    readyState: 2,
    deserializeAttachment: () => {
      if ("metadataError" in options) throw options.metadataError;
      return attachment;
    },
    close(code?: number) {
      calls.push("reply");
      replies.push(code);
      if ("closeError" in options) throw options.closeError;
    },
  } as unknown as WebSocket;
  const wrapped = new CfSocket(ws);
  const room = {
    env: { BUILD: "test" }, ctx: { id: { toString: () => "11".repeat(32) } },
    wraps: new WeakMap([[ws, wrapped]]),
    core: {
      settleClosedSocket: () => Promise.resolve(),
      onClose(socket: CfSocket, reason: string) {
        expect(socket).toBe(wrapped);
        calls.push("cleanup");
        reasons.push(reason);
        socket.deserializeAttachment();
        if ("cleanupError" in options) throw options.cleanupError;
      },
    },
  } as unknown as DaemonRoom;
  return {
    calls, replies, reasons,
    close: (code = 1000, reason = "") => DaemonRoom.prototype.webSocketClose.call(room, ws, code, reason, code !== 1006),
    error: () => DaemonRoom.prototype.webSocketError.call(room, ws, new Error("transport error")),
  };
}

describe("hibernating WebSocket close handshake", () => {
  test("peer close text stays bounded and an error callback does not tear down peers", () => {
    for (const [input, expected] of [["replaced", "replaced"], ["", "empty"], ["reconnect_token=rt_secret", "other"]]) {
      const h = setup();
      h.error();
      expect(h.calls).toEqual([]);
      h.close(1000, input);
      expect(h.reasons).toEqual([expected]);
    }
  });

  test("replies after local cleanup, including a retired socket", () => {
    for (const retired of [false, true]) {
      const h = setup({ retired });
      h.close(1000);
      expect(h.calls).toEqual(["cleanup", "reply"]);
      expect(h.replies).toEqual([1000]);
    }
  });

  test("does not put synthetic close statuses on the wire", () => {
    for (const code of [1005, 1006]) {
      const h = setup();
      h.close(code);
      expect(h.replies).toEqual([undefined]);
    }
  });

  test("replies even when attachment metadata or cleanup fails", () => {
    const error = new Error("storage reset");
    for (const options of [{ metadataError: error }, { cleanupError: error }]) {
      const h = setup(options);
      expect(h.close).toThrow(error);
      expect(h.replies).toEqual([1000]);
    }
  });

  test("preserves the first error when both cleanup and reply fail", () => {
    const error = new Error("storage reset");
    const h = setup({ cleanupError: error, closeError: new Error("transport gone") });
    try { h.close(); throw new Error("expected cleanup failure"); }
    catch (caught) { expect(caught).toBe(error); }
    expect(h.replies).toEqual([1000]);
  });

  test("does not hide an isolated native close failure", () => {
    const error = new Error("transport gone");
    const h = setup({ closeError: error });
    expect(h.close).toThrow(error);
    expect(h.calls).toEqual(["cleanup", "reply"]);
  });
});
