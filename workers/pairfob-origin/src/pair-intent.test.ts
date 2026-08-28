import { beforeEach, describe, expect, test } from "bun:test";
import { UNPAIRED_BODY, handlePairIntent } from "./pair-intent.ts";
import { resetLimits } from "./limits.ts";
import { IndexCore } from "./index/pairing-index.ts";
import { FakeIndexNamespace, FakeRoomNamespace } from "./testutil/fake-ns.ts";
import { PAIR_REF, makeRoom, testEnv } from "./testutil/make-room.ts";
import { onMessage } from "./room/ws.ts";
import { encodeJSON } from "./frames.ts";
import { Typ } from "./envelope.ts";
import { ZERO_ROUTE } from "./crypto.ts";
import { sha256Hex } from "./crypto.ts";

beforeEach(() => resetLimits());

function intentReq(loc: string): Request {
  return new Request("https://pairfob.com/v2/pair-intent", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://pairfob.com",
      "CF-Connecting-IP": "198.51.100.4",
    },
    body: JSON.stringify({ v: 2, pair_loc: loc }),
  });
}

describe("pair-intent unpaired shape", () => {
  test("miss, expired, and issueTicket slot mismatch share the same 404 body", async () => {
    const index = new IndexCore(new Map(), () => Date.now());
    const idxNs = new FakeIndexNamespace(index);
    const rooms = new FakeRoomNamespace((name) => makeRoom(name, index));
    const env = testEnv({ rooms, index: idxNs });

    const miss = await handlePairIntent(intentReq("WJ3K9M"), env);
    expect(miss.status).toBe(404);
    expect(await miss.json()).toEqual(UNPAIRED_BODY);

    index.insert({
      pair_loc: "AA11BB",
      daemon_id: "d_" + "aa".repeat(10),
      pair_ref: "11".repeat(16),
      exp: Date.now() - 1,
    });
    const expired = await handlePairIntent(intentReq("AA11BB"), env);
    expect(expired.status).toBe(404);
    expect(await expired.json()).toEqual(UNPAIRED_BODY);

    const daemonId = "d_" + "cd".repeat(10);
    const h = makeRoom(daemonId, index);
    rooms.harnesses.set(daemonId, h);
    const token = "rt_" + "cd".repeat(16);
    h.core.enroll({ reconnect_hash: await sha256Hex(token), grant_id: "g_" + "bb".repeat(8) });
    const d = h.accept("daemon");
    expect(d.ok).toBe(true);
    await onMessage(
      h.core,
      d.ws!,
      encodeJSON(Typ.HELLO_DAEMON, ZERO_ROUTE, {
        v: 2,
        op: "RegisterDaemon",
        daemon_id: daemonId,
        reconnect_token: token,
      }),
    );
    await onMessage(
      h.core,
      d.ws!,
      encodeJSON(Typ.PAIR_OPEN, ZERO_ROUTE, {
        v: 2,
        op: "CreatePairing",
        daemon_id: daemonId,
        pair_ref: PAIR_REF,
        ttl_s: 180,
      }),
    );
    const slot = h.store.loadSlot();
    expect(slot).toBeTruthy();
    const loc = slot!.pair_loc;

    h.store.putSlot({ pair_ref: "aa".repeat(16), pair_loc: "ZZZZZZ", deadline: h.clock.t + 180_000 });

    const mismatch = await handlePairIntent(intentReq(loc), env);
    expect(mismatch.status).toBe(404);
    expect(await mismatch.json()).toEqual(UNPAIRED_BODY);
  });

  test("miss and slot mismatch share a timing pad", async () => {
    const index = new IndexCore(new Map(), () => Date.now());
    const idxNs = new FakeIndexNamespace(index);
    const rooms = new FakeRoomNamespace((name) => makeRoom(name, index));
    const env = testEnv({ rooms, index: idxNs });
    env.INTENT_PAD_MS = "40";

    const missStart = Date.now();
    const miss = await handlePairIntent(intentReq("WJ3K9M"), env);
    const missMs = Date.now() - missStart;
    expect(miss.status).toBe(404);

    const daemonId = "d_" + "ee".repeat(10);
    const h = makeRoom(daemonId, index);
    rooms.harnesses.set(daemonId, h);
    const token = "rt_" + "ee".repeat(16);
    h.core.enroll({ reconnect_hash: await sha256Hex(token), grant_id: "g_" + "ee".repeat(8) });
    const d = h.accept("daemon");
    await onMessage(
      h.core,
      d.ws!,
      encodeJSON(Typ.HELLO_DAEMON, ZERO_ROUTE, {
        v: 2,
        op: "RegisterDaemon",
        daemon_id: daemonId,
        reconnect_token: token,
      }),
    );
    await onMessage(
      h.core,
      d.ws!,
      encodeJSON(Typ.PAIR_OPEN, ZERO_ROUTE, {
        v: 2,
        op: "CreatePairing",
        daemon_id: daemonId,
        pair_ref: PAIR_REF,
        ttl_s: 180,
      }),
    );
    const loc = h.store.loadSlot()!.pair_loc;
    h.store.putSlot({ pair_ref: "aa".repeat(16), pair_loc: "ZZZZZZ", deadline: h.clock.t + 180_000 });

    const mismatchStart = Date.now();
    const mismatch = await handlePairIntent(intentReq(loc), env);
    const mismatchMs = Date.now() - mismatchStart;
    expect(mismatch.status).toBe(404);
    expect(missMs).toBeGreaterThanOrEqual(35);
    expect(mismatchMs).toBeGreaterThanOrEqual(35);
  });
});
