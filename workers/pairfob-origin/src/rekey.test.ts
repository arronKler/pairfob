import { describe, expect, test } from "bun:test";
import { sha256Hex } from "./crypto.ts";
import { handleRekey } from "./rekey.ts";
import { FakeD1 } from "./testutil/fake-d1.ts";
import { FakeRoomNamespace } from "./testutil/fake-ns.ts";
import { makeRoom, testEnv } from "./testutil/make-room.ts";

describe("rekey", () => {
  test("Room is authoritative and D1 stores no reconnect hash", async () => {
    const daemonId = "d_" + "56".repeat(10);
    const grantId = "g_" + "56".repeat(8);
    const oldToken = "rt_" + "56".repeat(16);
    const newToken = "rt_" + "57".repeat(16);
    const oldHash = await sha256Hex(oldToken);
    const d1 = new FakeD1();
    d1.daemons.set(daemonId, {
      daemon_id: daemonId,
      grant_id: grantId,
      created_at: 1,
      kicked_at: null,
      enroll_ip_hash: null,
      quota_released_at: null,
    });
    const room = makeRoom(daemonId);
    room.core.enroll({ reconnect_hash: oldHash, grant_id: grantId });
    const rooms = new FakeRoomNamespace(() => room);
    const env = testEnv({ d1, rooms });
    const request = new Request("https://pairfob.com/v2/rekey", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        v: 2,
        daemon_id: daemonId,
        reconnect_token: oldToken,
        new_reconnect_token: newToken,
      }),
    });
    const retryRequest = request.clone();

    const first = await handleRekey(request, env);
    expect(first.status).toBe(200);
    const body = await first.json() as { reconnect_token: string };
    expect(body.reconnect_token).toBe(newToken);
    expect(room.store.loadMeta()?.reconnect_hash).toBe(await sha256Hex(body.reconnect_token));
    expect("reconnect_hash" in (d1.daemons.get(daemonId) as unknown as Record<string, unknown>)).toBe(false);

    const retry = await handleRekey(retryRequest, env);
    expect(retry.status).toBe(200);
    expect((await retry.json() as { reconnect_token: string }).reconnect_token).toBe(newToken);
  });

  test("wrong active token is rejected by the Room", async () => {
    const daemonId = "d_" + "90".repeat(10);
    const grantId = "g_" + "90".repeat(8);
    const active = "rt_" + "90".repeat(16);
    const d1 = new FakeD1();
    d1.daemons.set(daemonId, {
      daemon_id: daemonId,
      grant_id: grantId,
      created_at: 1,
      kicked_at: null,
      enroll_ip_hash: null,
      quota_released_at: null,
    });
    const room = makeRoom(daemonId);
    room.core.enroll({ reconnect_hash: await sha256Hex(active), grant_id: grantId });
    const env = testEnv({ d1, rooms: new FakeRoomNamespace(() => room) });

    const res = await handleRekey(new Request("https://pairfob.com/v2/rekey", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        v: 2,
        daemon_id: daemonId,
        reconnect_token: "rt_" + "aa".repeat(16),
        new_reconnect_token: "rt_" + "bb".repeat(16),
      }),
    }), env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: { code: "bad_token" } });
  });
});
