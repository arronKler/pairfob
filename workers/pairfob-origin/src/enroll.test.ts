import { beforeEach, describe, expect, test } from "bun:test";
import { handleAdmin } from "./admin.ts";
import { mintGrantRecord } from "./admin.ts";
import { handleEnroll } from "./enroll.ts";
import { resetLimits } from "./limits.ts";
import { FakeD1 } from "./testutil/fake-d1.ts";
import { FakeIndexNamespace, FakeRoomNamespace } from "./testutil/fake-ns.ts";
import { makeRoom, testEnv } from "./testutil/make-room.ts";
import { IndexCore } from "./index/pairing-index.ts";
import { SELF_GRANT_PER_IP } from "./constants.ts";
import { getDaemon, getGrantById } from "./d1.ts";

beforeEach(() => resetLimits());

function enrollReq(join: string, extra?: HeadersInit, seed = "11"): Request {
  return new Request("https://pairfob.com/v2/enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9", ...extra },
    body: JSON.stringify({
      v: 2,
      join_grant: join,
      daemon_id: "d_" + seed.repeat(10),
      reconnect_token: "rt_" + seed.repeat(16),
    }),
  });
}

describe("enroll CAS", () => {
  test("CAS increments used; exhausted and bad_grant; compensate on room fail", async () => {
    const d1 = new FakeD1();
    const idx = new FakeIndexNamespace(new IndexCore(new Map(), () => Date.now()));
    const rooms = new FakeRoomNamespace((name) => makeRoom(name, idx.core));
    const env = testEnv({ d1, rooms, index: idx });
    const minted = await mintGrantRecord(d1, { label: "t", max_daemons: 1, now: 1 });

    const ok = await handleEnroll(enrollReq(minted.join_grant), env);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { daemon_id: string; reconnect_token: string };
    expect(body.daemon_id).toMatch(/^d_[0-9a-f]{20}$/);
    expect(body.reconnect_token).toMatch(/^rt_[0-9a-f]{32}$/);
    const grant = await getGrantById(d1, minted.grant_id);
    expect(grant?.used).toBe(1);

    const exhausted = await handleEnroll(enrollReq(minted.join_grant, undefined, "12"), env, Date.now() + 120_000);
    expect(exhausted.status).toBe(409);
    expect(await exhausted.json()).toEqual({ ok: false, error: { code: "grant_exhausted" } });
    expect((await getGrantById(d1, minted.grant_id))?.used).toBe(1);

    const bad = await handleEnroll(enrollReq("jg_" + "00".repeat(16), undefined, "13"), env);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ ok: false, error: { code: "bad_grant" } });

    const d1b = new FakeD1();
    const roomsFail = new FakeRoomNamespace((name) => makeRoom(name, idx.core));
    roomsFail.failEnroll = true;
    const envFail = testEnv({ d1: d1b, rooms: roomsFail, index: idx });
    const minted2 = await mintGrantRecord(d1b, { label: "t2", max_daemons: 2, now: 1 });
    const fail = await handleEnroll(enrollReq(minted2.join_grant), envFail);
    expect(fail.status).toBe(500);
    expect(await fail.json()).toEqual({ ok: false, error: { code: "internal" } });
    expect((await getGrantById(d1b, minted2.grant_id))?.used).toBe(0);
    expect(d1b.daemons.size).toBe(0);
    for (const harness of roomsFail.harnesses.values()) {
      expect(harness.store.loadMeta()).toBeNull();
    }
  });

  test("browser Origin is rejected", async () => {
    const d1 = new FakeD1();
    const env = testEnv({ d1 });
    const minted = await mintGrantRecord(d1, { label: null, max_daemons: 2, now: 1 });
    const res = await handleEnroll(
      enrollReq(minted.join_grant, { Origin: "https://pairfob.com" }),
      env,
    );
    expect(res.status).toBe(403);
  });

  test("a committed enroll retries idempotently without the join grant", async () => {
    const d1 = new FakeD1();
    const rooms = new FakeRoomNamespace((name) => makeRoom(name));
    const env = testEnv({ d1, rooms });
    const minted = await mintGrantRecord(d1, { label: "retry", max_daemons: 2, now: 1 });
    const first = await handleEnroll(enrollReq(minted.join_grant, undefined, "21"), env, 1_000_000);
    expect(first.status).toBe(200);

    const retry = await handleEnroll(enrollReq("", undefined, "21"), env, 1_000_001);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(await first.json());
    expect((await getGrantById(d1, minted.grant_id))?.used).toBe(1);
  });

  test("a D1-only enroll resumes with the same grant instead of stranding the daemon id", async () => {
    const d1 = new FakeD1();
    const rooms = new FakeRoomNamespace((name) => makeRoom(name));
    const env = testEnv({ d1, rooms });
    const minted = await mintGrantRecord(d1, { label: "partial", max_daemons: 2, now: 1 });
    const request = enrollReq(minted.join_grant, undefined, "22");
    expect((await handleEnroll(request.clone(), env, 1_000_000)).status).toBe(200);
    const daemonId = "d_" + "22".repeat(10);
    rooms.harness(daemonId)?.store.deleteMeta();

    const resumed = await handleEnroll(request, env, 1_000_001);
    expect(resumed.status).toBe(200);
    expect(rooms.harness(daemonId)?.store.loadMeta()?.grant_id).toBe(minted.grant_id);
    expect((await getGrantById(d1, minted.grant_id))?.used).toBe(1);
  });

  test("grant enrollment rate limit is authoritative in D1", async () => {
    const d1 = new FakeD1();
    const env = testEnv({ d1 });
    const minted = await mintGrantRecord(d1, { label: "rate", max_daemons: 3, now: 1 });
    const start = 2_000_000;
    expect((await handleEnroll(enrollReq(minted.join_grant, undefined, "31"), env, start)).status).toBe(200);

    const limited = await handleEnroll(enrollReq(minted.join_grant, undefined, "32"), env, start + 1_000);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ ok: false, error: { code: "rate_limited" } });
    expect((await getGrantById(d1, minted.grant_id))?.used).toBe(1);

    const later = await handleEnroll(enrollReq(minted.join_grant, undefined, "32"), env, start + 60_001);
    expect(later.status).toBe(200);
    expect((await getGrantById(d1, minted.grant_id))?.used).toBe(2);
  });

  test("daemon insert failure rolls back the quota reservation", async () => {
    const d1 = new FakeD1();
    const env = testEnv({ d1 });
    const minted = await mintGrantRecord(d1, { label: "rollback", max_daemons: 1, now: 1 });
    d1.failNextInsert = true;

    const failed = await handleEnroll(enrollReq(minted.join_grant), env);
    expect(failed.status).toBe(500);
    expect((await getGrantById(d1, minted.grant_id))?.used).toBe(0);
    expect(d1.daemons.size).toBe(0);

    const retry = await handleEnroll(enrollReq(minted.join_grant), env, Date.now() + 120_000);
    expect(retry.status).toBe(200);
    expect((await getGrantById(d1, minted.grant_id))?.used).toBe(1);
  });

  test("kick decrements used; revoke does not", async () => {
    const d1 = new FakeD1();
    const idx = new FakeIndexNamespace(new IndexCore(new Map(), () => Date.now()));
    const rooms = new FakeRoomNamespace((name) => makeRoom(name, idx.core));
    const env = testEnv({ d1, rooms, index: idx });
    const minted = await mintGrantRecord(d1, { label: "k", max_daemons: 2, now: 1 });
    const ok = await handleEnroll(enrollReq(minted.join_grant), env);
    const enrolled = (await ok.json()) as { daemon_id: string };
    expect((await getGrantById(d1, minted.grant_id))?.used).toBe(1);

    const kick = await handleAdmin(
      new Request(`https://pairfob.com/v2/admin/daemons/${enrolled.daemon_id}/kick`, {
        method: "POST",
        headers: { Authorization: "Bearer dev-operator" },
      }),
      env,
    );
    expect(kick?.status).toBe(200);
    expect((await getGrantById(d1, minted.grant_id))?.used).toBe(0);
    const daemon = await getDaemon(d1, enrolled.daemon_id);
    expect(daemon?.kicked_at).not.toBeNull();

    const kick2 = await handleAdmin(
      new Request(`https://pairfob.com/v2/admin/daemons/${enrolled.daemon_id}/kick`, {
        method: "POST",
        headers: { Authorization: "Bearer dev-operator" },
      }),
      env,
    );
    expect(kick2?.status).toBe(200);
    expect((await getGrantById(d1, minted.grant_id))?.used).toBe(0);

    const usedBefore = (await getGrantById(d1, minted.grant_id))?.used;
    const revoke = await handleAdmin(
      new Request(`https://pairfob.com/v2/admin/grants/${minted.grant_id}/revoke`, {
        method: "POST",
        headers: { Authorization: "Bearer dev-operator" },
      }),
      env,
    );
    expect(revoke?.status).toBe(200);
    const g = await getGrantById(d1, minted.grant_id);
    expect(g?.revoked_at).not.toBeNull();
    expect(g?.used).toBe(usedBefore);
  });

  test("open enroll mints an internal one-slot grant", async () => {
    const d1 = new FakeD1();
    const rooms = new FakeRoomNamespace((name) => makeRoom(name));
    const env = testEnv({ d1, rooms });
    const ok = await handleEnroll(enrollReq("", undefined, "41"), env, 3_000_000);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { daemon_id: string; grant_id: string; join_grant?: string };
    expect(body.daemon_id).toBe("d_" + "41".repeat(10));
    expect(body.join_grant).toBeUndefined();
    const grant = await getGrantById(d1, body.grant_id);
    expect(grant?.label).toBe("open-enroll");
    expect(grant?.max_daemons).toBe(1);
    expect(grant?.used).toBe(1);
    expect(rooms.harness(body.daemon_id)?.store.loadMeta()?.grant_id).toBe(body.grant_id);
  });

  test("open enroll is capped per address", async () => {
    const d1 = new FakeD1();
    const env = testEnv({ d1 });
    const start = 4_000_000;
    for (let i = 0; i < SELF_GRANT_PER_IP; i++) {
      const seed = String(50 + i);
      const ok = await handleEnroll(enrollReq("", undefined, seed), env, start + i);
      expect(ok.status).toBe(200);
    }
    const over = await handleEnroll(enrollReq("", undefined, "60"), env, start + 10);
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ ok: false, error: { code: "rate_limited" } });
    expect(d1.grants.size).toBe(SELF_GRANT_PER_IP);
  });

  test("a D1-only open enroll resumes without a join grant", async () => {
    const d1 = new FakeD1();
    const rooms = new FakeRoomNamespace((name) => makeRoom(name));
    const env = testEnv({ d1, rooms });
    const request = enrollReq("", undefined, "61");
    const first = await handleEnroll(request.clone(), env, 5_000_000);
    expect(first.status).toBe(200);
    const daemonId = "d_" + "61".repeat(10);
    rooms.harness(daemonId)?.store.deleteMeta();
    const resumed = await handleEnroll(request, env, 5_000_001);
    expect(resumed.status).toBe(200);
    expect(rooms.harness(daemonId)?.store.loadMeta()?.reconnect_hash).toBeTruthy();
    expect((await getDaemon(d1, daemonId))?.grant_id).toBe(
      ((await first.json()) as { grant_id: string }).grant_id,
    );
  });

  test("kick keeps D1 live when the authoritative Room cannot be reached", async () => {
    const d1 = new FakeD1();
    const rooms = new FakeRoomNamespace((name) => makeRoom(name));
    const env = testEnv({ d1, rooms });
    const minted = await mintGrantRecord(d1, { label: "kick-fail", max_daemons: 1, now: 1 });
    const enrolled = (await (await handleEnroll(enrollReq(minted.join_grant), env)).json()) as { daemon_id: string };
    rooms.failKick = true;

    const failed = await handleAdmin(
      new Request(`https://pairfob.com/v2/admin/daemons/${enrolled.daemon_id}/kick`, {
        method: "POST",
        headers: { Authorization: "Bearer dev-operator" },
      }),
      env,
    );
    expect(failed?.status).toBe(503);
    expect((await getDaemon(d1, enrolled.daemon_id))?.kicked_at).toBeNull();
    expect((await getGrantById(d1, minted.grant_id))?.used).toBe(1);
  });
});
