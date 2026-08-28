import { beforeEach, describe, expect, test } from "bun:test";
import { ZERO_ROUTE, routeHex, sha256Hex } from "../src/crypto.ts";
import { Typ } from "../src/envelope.ts";
import { encodeJSON } from "../src/frames.ts";
import { IndexCore } from "../src/index/pairing-index.ts";
import { resetLimits } from "../src/limits.ts";
import { UNPAIRED_BODY, handlePairIntent } from "../src/pair-intent.ts";
import { handleRoomFetch } from "../src/room/http.ts";
import { onMessage } from "../src/room/ws.ts";
import { FakeIndexNamespace, FakeRoomNamespace } from "../src/testutil/fake-ns.ts";
import { PAIR_REF, lastJSON, makeRoom, testEnv } from "../src/testutil/make-room.ts";
import { handleFetch } from "../src/worker.ts";

beforeEach(() => resetLimits());

function intentReq(loc: string): Request {
  return new Request("https://pairfob.com/v2/pair-intent", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://pairfob.com",
      "CF-Connecting-IP": "198.51.100.8",
    },
    body: JSON.stringify({ v: 2, pair_loc: loc }),
  });
}

async function daemonWithSlot() {
  const index = new IndexCore(new Map(), () => Date.now());
  const idxNs = new FakeIndexNamespace(index);
  const rooms = new FakeRoomNamespace((name) => makeRoom(name, index));
  const env = testEnv({ rooms, index: idxNs });
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
  return { env, h, daemonId, loc: h.store.loadSlot()!.pair_loc };
}

describe("S8.5 room harness", () => {
  test("intent hit/miss/issueTicket mismatch share 404 unpaired", async () => {
    const { env, h, loc } = await daemonWithSlot();
    const miss = await handlePairIntent(intentReq("000000"), env);
    expect(miss.status).toBe(404);
    expect(await miss.json()).toEqual(UNPAIRED_BODY);

    const hit = await handlePairIntent(intentReq(loc), env);
    expect(hit.status).toBe(200);
    const hitBody = (await hit.json()) as { ok: boolean; pair_ticket: string; pair_ref: string };
    expect(hitBody.ok).toBe(true);
    expect(hitBody.pair_ref).toBe(PAIR_REF);
    expect(hitBody.pair_ticket).toMatch(/^[0-9a-f]{32}$/);

    h.store.putSlot({ pair_ref: "ff".repeat(16), pair_loc: "YYYYYY", deadline: h.clock.t + 180000 });
    const mismatch = await handlePairIntent(intentReq(loc), env);
    expect(mismatch.status).toBe(404);
    expect(await mismatch.json()).toEqual(UNPAIRED_BODY);
  });

  test("dual Upgrade same ticket: second is unpaired", async () => {
    const { env, h, loc, daemonId } = await daemonWithSlot();
    const hit = await handlePairIntent(intentReq(loc), env);
    const { pair_ticket } = (await hit.json()) as { pair_ticket: string };
    const first = await handleRoomFetch(
      h.core,
      new Request(`https://pairfob.com/v2/ws?role=client&daemon_id=${daemonId}&pair_ticket=${pair_ticket}`, {
        headers: { Upgrade: "websocket" },
      }),
      { upgrade: (_att, _tags, headers) => new Response(null, { status: 101, headers }) },
    );
    expect(first.status).toBe(101);
    const second = await handleRoomFetch(
      h.core,
      new Request(`https://pairfob.com/v2/ws?role=client&daemon_id=${daemonId}&pair_ticket=${pair_ticket}`, {
        headers: { Upgrade: "websocket" },
      }),
      { upgrade: (_att, _tags, headers) => new Response(null, { status: 101, headers }) },
    );
    expect(second.status).toBe(404);
    expect(await second.json()).toEqual(UNPAIRED_BODY);
  });

  test("QR path attaches without a ticket", async () => {
    const { h, daemonId } = await daemonWithSlot();
    const p = h.accept("phone");
    await onMessage(h.core, p.ws!, encodeJSON(Typ.HELLO_CLIENT, ZERO_ROUTE, { v: 2, protocol: 2 }));
    await onMessage(h.core, p.ws!, encodeJSON(Typ.PAIR_ATTACH, ZERO_ROUTE, { v: 2, pair_ref: PAIR_REF }));
    const attached = lastJSON(p.ws!);
    expect(attached.typ).toBe(Typ.PAIR_ATTACHED);
    expect(attached.body.daemon_id).toBe(daemonId);
    expect(attached.body.pair_ref).toBe(PAIR_REF);
  });

  test("ResumeHello LRU and 11th established", async () => {
    const { h } = await daemonWithSlot();
    const daemon = h.sockets.find((s) => s.deserializeAttachment()?.role === "daemon")!;
    const phones = [];
    for (let i = 0; i < 3; i++) {
      const p = h.accept("phone");
      await onMessage(h.core, p.ws!, encodeJSON(Typ.HELLO_CLIENT, ZERO_ROUTE, { v: 2, protocol: 2 }));
      await onMessage(h.core, p.ws!, encodeJSON(Typ.SESSION_ATTACH, ZERO_ROUTE, { v: 2, daemon_id: h.core.daemonId }));
      phones.push(p.ws!);
      h.tick(10);
    }
    expect(phones[0].closed).toBe(true);
    expect(lastJSON(phones[0]).body.code).toBe("kicked");
    expect(h.core.countKinds().resume).toBe(2);

    for (let i = 0; i < 10; i++) {
      const p = h.accept("phone");
      await onMessage(h.core, p.ws!, encodeJSON(Typ.HELLO_CLIENT, ZERO_ROUTE, { v: 2, protocol: 2 }));
      await onMessage(h.core, p.ws!, encodeJSON(Typ.SESSION_ATTACH, ZERO_ROUTE, { v: 2, daemon_id: h.core.daemonId }));
      const bound = lastJSON(p.ws!);
      await onMessage(
        h.core,
        daemon,
        encodeJSON(Typ.SESSION_ESTABLISHED, bound.routeId, { v: 2, route_id: routeHex(bound.routeId) }),
      );
    }
    expect(h.core.countKinds().est).toBe(10);
    const p11 = h.accept("phone");
    await onMessage(h.core, p11.ws!, encodeJSON(Typ.HELLO_CLIENT, ZERO_ROUTE, { v: 2, protocol: 2 }));
    await onMessage(h.core, p11.ws!, encodeJSON(Typ.SESSION_ATTACH, ZERO_ROUTE, { v: 2, daemon_id: h.core.daemonId }));
    const b11 = lastJSON(p11.ws!);
    await onMessage(
      h.core,
      daemon,
      encodeJSON(Typ.SESSION_ESTABLISHED, b11.routeId, { v: 2, route_id: routeHex(b11.routeId) }),
    );
    expect(lastJSON(p11.ws!).body.code).toBe("too_many_devices");
  });

  test("pair_loc Upgrade is HTTP 404 at the worker", async () => {
    const env = testEnv();
    const res = await handleFetch(
      new Request("https://pairfob.com/v2/ws?role=client&pair_loc=WJ3K9M&daemon_id=d_" + "ab".repeat(10), {
        headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "pairfob.v2", Origin: "https://pairfob.com" },
      }),
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(UNPAIRED_BODY);
  });
});
