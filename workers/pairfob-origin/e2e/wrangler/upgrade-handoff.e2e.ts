/// <reference types="@cloudflare/vitest-pool-workers" />
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { newAttachment } from "../../src/room/attachment.ts";
import { CfSocket } from "../../src/room/cf-socket.ts";
import { watchUpgradeCancellation } from "../../src/room/upgrade-cancellation.ts";

it("canceling an unclaimed hibernatable upgrade completes both native close directions", async () => {
  const stub = env.DAEMON_ROOM.get(env.DAEMON_ROOM.idFromName(`handoff-${crypto.randomUUID()}`));
  const result = await runInDurableObject(stub, async (_instance, ctx) => {
    const pair = new WebSocketPair();
    ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment(newAttachment("phone", Date.now()));
    const closed = new Promise<number>((resolve) => pair[0].addEventListener("close", (event) => resolve(event.code), { once: true }));
    const controller = new AbortController();
    const wrapped = new CfSocket(pair[1]);
    watchUpgradeCancellation(controller.signal, pair[0], wrapped, () => {});
    controller.abort();
    const code = await closed;
    return { code, retired: wrapped.isRetired(), clientState: pair[0].readyState };
  });
  expect(result).toEqual({ code: 1000, retired: true, clientState: WebSocket.CLOSED });
});
