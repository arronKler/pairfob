import { describe, expect, test } from "bun:test";
import { CfSocket, type HibernatingSocket } from "./cf-socket.ts";
import { newAttachment } from "./attachment.ts";
import { watchUpgradeCancellation } from "./upgrade-cancellation.ts";

function endpoints(handedOff = false) {
  const calls: string[] = [];
  let attachment = newAttachment("phone", 1000);
  const raw: HibernatingSocket = {
    send() { throw new Error("cleanup must not send application data"); },
    close() { calls.push("server.close"); },
    serializeAttachment(value) { attachment = structuredClone(value); },
    deserializeAttachment() { return structuredClone(attachment); },
  };
  const client = {
    accept() {
      if (handedOff) throw new TypeError("Can't accept() WebSocket that was already used in a response.");
      calls.push("client.accept");
    },
    close() { calls.push("client.close"); },
  };
  return { client, raw, server: new CfSocket(raw), calls };
}

describe("upgrade response handoff cancellation", () => {
  for (const alreadyAborted of [false, true]) {
    test(`unclaimed pair is fully closed and stays retired across reconstruction (${alreadyAborted})`, () => {
      const controller = new AbortController();
      const pair = endpoints();
      if (alreadyAborted) controller.abort();
      let canceled = 0;
      watchUpgradeCancellation(controller.signal, pair.client, pair.server, () => canceled++);
      controller.abort();
      controller.abort();
      expect(pair.calls).toEqual(["client.accept", "client.close", "server.close"]);
      expect(new CfSocket(pair.raw).isRetired()).toBe(true);
      expect(canceled).toBe(1);
    });
  }

  test("a successful response handoff prevents cleanup from closing the established server", () => {
    const controller = new AbortController();
    const pair = endpoints(true);
    watchUpgradeCancellation(controller.signal, pair.client, pair.server, () => { throw new Error("unexpected cleanup"); });
    controller.abort();
    expect(pair.calls).toEqual([]);
    expect(pair.server.isRetired()).toBe(false);
  });

  test("an uncanceled connection is not accepted locally or retired", () => {
    const controller = new AbortController();
    const pair = endpoints();
    watchUpgradeCancellation(controller.signal, pair.client, pair.server, () => { throw new Error("unexpected cleanup"); });
    expect(pair.calls).toEqual([]);
    expect(pair.server.isRetired()).toBe(false);
  });

  test("failure to close the client still retires and closes the server", () => {
    const controller = new AbortController();
    controller.abort();
    const pair = endpoints();
    const failure = new Error("transport failed");
    pair.client.close = () => { throw failure; };
    expect(() => watchUpgradeCancellation(controller.signal, pair.client, pair.server, () => {})).toThrow(failure);
    expect(pair.server.isRetired()).toBe(true);
    expect(pair.calls).toEqual(["client.accept", "server.close"]);
  });
});
