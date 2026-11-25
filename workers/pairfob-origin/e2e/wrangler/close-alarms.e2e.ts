/// <reference types="@cloudflare/vitest-pool-workers" />
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { armHello } from "../../src/room/alarms.ts";
import { newAttachment } from "../../src/room/attachment.ts";
import { CfSocket } from "../../src/room/cf-socket.ts";
import type { DaemonRoom } from "../../src/room/room.ts";

it("native close cleanup retires the socket and cancels its otherwise billable hello alarm", async () => {
  const stub = env.DAEMON_ROOM.get(env.DAEMON_ROOM.idFromName(`close-cost-${crypto.randomUUID()}`));
  const result = await runInDurableObject(stub, async (instance, ctx) => {
    const room = instance as DaemonRoom;
    const pair = new WebSocketPair();
    ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment(newAttachment("phone", Date.now()));
    pair[0].accept();
    room.core.attachSocket(new CfSocket(pair[1]));
    await armHello(room.core, Date.now());
    const before = await ctx.storage.getAlarm();
    // Run the real close callback with native endpoints and SQLite. Unit
    // sockets cannot prove attachment writes and alarm cancellation work here.
    await room.webSocketClose(pair[1], 1000, "normal", true);
    const after = await ctx.storage.getAlarm();
    const retired = new CfSocket(pair[1]).isRetired();
    return { before, after, retired };
  });
  expect(result.before).not.toBeNull();
  expect(result.after).toBeNull();
  expect(result.retired).toBe(true);
});
