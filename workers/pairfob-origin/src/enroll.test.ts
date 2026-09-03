import { beforeEach, describe, expect, test } from "bun:test";
import { handleAdmin } from "./admin.ts";
import { handleEnroll } from "./enroll.ts";
import { resetLimits } from "./limits.ts";
import { FakeD1 } from "./testutil/fake-d1.ts";
import { FakeIndexNamespace, FakeRoomNamespace } from "./testutil/fake-ns.ts";
import { makeRoom, testEnv } from "./testutil/make-room.ts";
import { IndexCore } from "./index/pairing-index.ts";
import { SELF_GRANT_PER_IP, SELF_GRANT_WINDOW_MS } from "./constants.ts";
import { getDaemon, getGrantById } from "./d1.ts";

beforeEach(() => resetLimits());

function enrollReq(seed = "11", extra?: HeadersInit, extraBody?: Record<string, unknown>): Request {
  return new Request("https://pairfob.com/v2/enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9", ...extra },
    body: JSON.stringify({
      v: 2,
      daemon_id: "d_" + seed.repeat(10),
      reconnect_token: "rt_" + seed.repeat(16),
      ...extraBody,
    }),
  });
}

describe("enroll CAS", () => {
  test("open enroll mints an internal one-slot grant", async () => {
    const d1 = new FakeD1();
    const rooms = new FakeRoomNamespace((name) => makeRoom(name));
    const env = testEnv({ d1, rooms });
    const ok = await handleEnroll(enrollReq("41"), env, 3_000_000);
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

  test("a leftover join_grant field is ignored", async () => {
    const d1 = new FakeD1();
    const env = testEnv({ d1 });
    const ok = await handleEnroll(
      enrollReq("42", undefined, { join_grant: "jg_" + "ab".repeat(16) }),
      env,
      3_100_000,
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { grant_id: string; join_grant?: string };
    expect(body.join_grant).toBeUndefined();
    expect((await getGrantById(d1, body.grant_id))?.label).toBe("open-enroll");
  });

  test("browser Origin is rejected", async () => {
    const res = await handleEnroll(enrollReq("11", { Origin: "https://pairfob.com" }), testEnv());
    expect(res.status).toBe(403);
  });

  test("a committed enroll retries idempotently", async () => {
    const d1 = new FakeD1();
    const rooms = new FakeRoomNamespace((name) => makeRoom(name));
    const env = testEnv({ d1, rooms });
    const first = await handleEnroll(enrollReq("21"), env, 1_000_000);
    expect(first.status).toBe(200);
    const retry = await handleEnroll(enrollReq("21"), env, 1_000_001);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(await first.json());
    expect(d1.grants.size).toBe(1);
  });

  test("a D1-only enroll resumes instead of stranding the daemon id", async () => {
    const d1 = new FakeD1();
    const rooms = new FakeRoomNamespace((name) => makeRoom(name));
    const env = testEnv({ d1, rooms });
    const request = enrollReq("22");
    expect((await handleEnroll(request.clone(), env, 1_000_000)).status).toBe(200);
    const daemonId = "d_" + "22".repeat(10);
    rooms.harness(daemonId)?.store.deleteMeta();

    const resumed = await handleEnroll(request, env, 1_000_001);
    expect(resumed.status).toBe(200);
    expect(rooms.harness(daemonId)?.store.loadMeta()?.reconnect_hash).toBeTruthy();
    expect((await getDaemon(d1, daemonId))?.grant_id).toBe(
      ((await resumed.json()) as { grant_id: string }).grant_id,
    );
  });

  test("daemon insert failure rolls back the quota reservation", async () => {
    const d1 = new FakeD1();
    const env = testEnv({ d1 });
    d1.failNextInsert = true;

    const failed = await handleEnroll(enrollReq("11"), env);
    expect(failed.status).toBe(500);
    expect(d1.daemons.size).toBe(0);

    const retry = await handleEnroll(enrollReq("11"), env, Date.now() + 120_000);
    expect(retry.status).toBe(200);
    expect(d1.daemons.size).toBe(1);
  });

  test("room failure compensates used", async () => {
    const d1 = new FakeD1();
    const idx = new FakeIndexNamespace(new IndexCore(new Map(), () => Date.now()));
    const roomsFail = new FakeRoomNamespace((name) => makeRoom(name, idx.core));
    roomsFail.failEnroll = true;
    const envFail = testEnv({ d1, rooms: roomsFail, index: idx });
    const fail = await handleEnroll(enrollReq("11"), envFail);
    expect(fail.status).toBe(500);
    expect(await fail.json()).toEqual({ ok: false, error: { code: "internal" } });
    expect(d1.daemons.size).toBe(0);
    for (const grant of d1.grants.values()) {
      expect(grant.used).toBe(0);
    }
    for (const harness of roomsFail.harnesses.values()) {
      expect(harness.store.loadMeta()).toBeNull();
    }
  });

  test("kick decrements used", async () => {
    const d1 = new FakeD1();
    const idx = new FakeIndexNamespace(new IndexCore(new Map(), () => Date.now()));
    const rooms = new FakeRoomNamespace((name) => makeRoom(name, idx.core));
    const env = testEnv({ d1, rooms, index: idx });
    const ok = await handleEnroll(enrollReq("11"), env);
    const enrolled = (await ok.json()) as { daemon_id: string; grant_id: string };
    expect((await getGrantById(d1, enrolled.grant_id))?.used).toBe(1);

    const kick = await handleAdmin(
      new Request(`https://pairfob.com/v2/admin/daemons/${enrolled.daemon_id}/kick`, {
        method: "POST",
        headers: { Authorization: "Bearer dev-operator" },
      }),
      env,
    );
    expect(kick?.status).toBe(200);
    expect((await getGrantById(d1, enrolled.grant_id))?.used).toBe(0);
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
    expect((await getGrantById(d1, enrolled.grant_id))?.used).toBe(0);
  });

  test("retired admin grant mint is unbound", async () => {
    const env = testEnv();
    const mint = await handleAdmin(
      new Request("https://pairfob.com/v2/admin/grants", {
        method: "POST",
        headers: { Authorization: "Bearer dev-operator", "Content-Type": "application/json" },
        body: JSON.stringify({ label: "lab" }),
      }),
      env,
    );
    expect(mint?.status).toBe(404);
    expect(await mint?.json()).toEqual({ ok: false, error: { code: "unbound" } });
  });

  test("open enroll is capped per address", async () => {
    const d1 = new FakeD1();
    const env = testEnv({ d1 });
    const start = 4_000_000;
    for (let i = 0; i < SELF_GRANT_PER_IP; i++) {
      const seed = String(50 + i);
      const ok = await handleEnroll(enrollReq(seed), env, start + i);
      expect(ok.status).toBe(200);
    }
    const over = await handleEnroll(enrollReq("60"), env, start + 10);
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ ok: false, error: { code: "rate_limited" } });
    expect(d1.grants.size).toBe(SELF_GRANT_PER_IP);

    const other = await handleEnroll(
      enrollReq("70", { "CF-Connecting-IP": "198.51.100.4" }),
      env,
      start + 11,
    );
    expect(other.status).toBe(200);

    resetLimits();
    const later = await handleEnroll(enrollReq("80"), env, start + SELF_GRANT_WINDOW_MS + 1);
    expect(later.status).toBe(200);
  });

  test("kick keeps D1 live when the authoritative Room cannot be reached", async () => {
    const d1 = new FakeD1();
    const rooms = new FakeRoomNamespace((name) => makeRoom(name));
    const env = testEnv({ d1, rooms });
    const enrolled = (await (await handleEnroll(enrollReq("11"), env)).json()) as {
      daemon_id: string;
      grant_id: string;
    };
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
    expect((await getGrantById(d1, enrolled.grant_id))?.used).toBe(1);
  });
});
