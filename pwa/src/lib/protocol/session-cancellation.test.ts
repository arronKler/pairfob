import { expect, test } from "bun:test";
import { SessionSocket, socketPair, type HoldStage } from "../../../test-support/session-socket-fixture";
import { connectSession } from "./session-connect";
import { FrameSocket } from "./frame-socket";
import { jsonFrame, Typ } from "./envelope";

for (const scenario of ["bound", "hello", "established", "ping", "queued-ping"] as const) {
  const stage: HoldStage = scenario === "queued-ping" ? "ping" : scenario;
  test(`abort during ${scenario} immediately rejects without waiting for browser close`, async () => {
    const original = globalThis.WebSocket;
    SessionSocket.instances = []; SessionSocket.hold = stage;
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: SessionSocket });
    const controller = new AbortController();
    const pending = connectSession("wss://pairfob.test/v2/ws", socketPair, () => undefined, controller.signal).catch(e => e);
    try {
      const deadline = Date.now() + 1000;
      while (!SessionSocket.instances[0]?.blocked && Date.now() < deadline) await Bun.sleep(1);
      const ws = SessionSocket.instances[0]!;
      expect(ws.blocked).toBe(stage);
      const count = ws.frames.length;
      if (scenario === "queued-ping") ws.releaseLate();
      controller.abort();
      const error = await Promise.race([pending, Bun.sleep(50).then(() => ({ code: "still_waiting" }))]);
      expect(error.code).toBe("disconnected");
      expect(ws.readyState).toBe(2);
      ws.releaseLate(); await Bun.sleep(1);
      expect(ws.frames.length).toBe(count);
      expect(ws.operations.every(op => op === "Ping")).toBe(true);
    } finally {
      controller.abort();
      for (const ws of SessionSocket.instances) ws.finishClose();
      await pending;
      Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: original });
    }
  });
}

test("local close rejects all waiters once and makes late input unusable", async () => {
  const ws = new SessionSocket();
  const link = new FrameSocket(ws as unknown as WebSocket);
  const failures: unknown[] = [];
  link.onClose(error => failures.push(error));
  const one = link.next(8000).catch(e => e);
  const two = link.next(15000).catch(e => e);
  link.close();
  expect((await one).code).toBe("disconnected"); expect((await two).code).toBe("disconnected");
  link.close(); ws.finishClose();
  expect(failures).toHaveLength(1);
  expect(() => link.send(jsonFrame(Typ.HELLO_CLIENT, new Uint8Array(16), {}))).toThrow();
  expect(() => link.use(() => undefined)).toThrow();
  expect((await link.next(8000).catch(e => e)).code).toBe("disconnected");
});
