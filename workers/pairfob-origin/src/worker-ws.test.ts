import { beforeEach, describe, expect, test } from "bun:test";
import { HELLO_GRACE_MS, MAX_PENDING_HELLO } from "./constants.ts";
import { LIMITS, resetLimits } from "./limits.ts";
import { handleFetch } from "./worker.ts";
import { IndexCore } from "./index/pairing-index.ts";
import { FakeIndexNamespace, FakeRoomNamespace } from "./testutil/fake-ns.ts";
import { makeRoom, testEnv } from "./testutil/make-room.ts";
import { UNPAIRED_BODY } from "./pair-intent.ts";
import { FakeD1 } from "./testutil/fake-d1.ts";

beforeEach(() => resetLimits());

const DAEMON_ID = "d_" + "ab".repeat(10);
const IP_A = "198.51.100.40";
const IP_B = "203.0.113.50";

/** A live daemon row plus the fake Room namespace every upgrade passes through. */
function seededEnv() {
  const d1 = new FakeD1();
  d1.daemons.set(DAEMON_ID, {
    daemon_id: DAEMON_ID,
    grant_id: "g_" + "ab".repeat(8),
    created_at: 1,
    kicked_at: null,
    enroll_ip_hash: null,
    quota_released_at: null,
  });
  const rooms = new FakeRoomNamespace((name) => makeRoom(name));
  return { env: testEnv({ d1, rooms }), rooms };
}

function upgradeReq(role: "client" | "daemon", ip: string, extraQuery = ""): Request {
  const headers: Record<string, string> = {
    Upgrade: "websocket",
    "Sec-WebSocket-Protocol": "pairfob.v2",
    "CF-Connecting-IP": ip,
  };
  // Daemons send no browser Origin; ticketless clients must send an allowed one.
  if (role === "client") headers.Origin = "https://pairfob.com";
  return new Request(`https://pairfob.com/v2/ws?role=${role}&daemon_id=${DAEMON_ID}${extraQuery}`, { headers });
}

async function expirePendingHellos(rooms: FakeRoomNamespace): Promise<void> {
  const h = rooms.harness(DAEMON_ID)!;
  h.tick(HELLO_GRACE_MS + 1);
  await h.core.alarm();
  expect(h.core.countPendingHellos()).toBe(0);
}

describe("worker /v2/ws", () => {
  test("pair_loc query never upgrades and does not touch Index or Room", async () => {
    const index = new IndexCore(new Map(), () => Date.now());
    const idxNs = new FakeIndexNamespace(index);
    const rooms = new FakeRoomNamespace((name) => makeRoom(name, index));
    const env = testEnv({ rooms, index: idxNs });
    const res = await handleFetch(
      new Request("https://pairfob.com/v2/ws?role=client&daemon_id=d_" + "ab".repeat(10) + "&pair_loc=WJ3K9M", {
        headers: {
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": "pairfob.v2",
          Origin: "https://pairfob.com",
        },
      }),
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(UNPAIRED_BODY);
    expect(rooms.fetchLog).toEqual([]);
    expect(idxNs.fetchLog).toEqual([]);
  });

  test("/v1/ws is 426", async () => {
    const env = testEnv();
    const res = await handleFetch(new Request("https://pairfob.com/v1/ws?role=client"), env);
    expect(res.status).toBe(426);
  });

  test("unknown daemon ids are rejected before a Room is activated", async () => {
    const d1 = new FakeD1();
    const rooms = new FakeRoomNamespace((name) => makeRoom(name));
    const env = testEnv({ d1, rooms });
    const daemonId = "d_" + "cd".repeat(10);
    const req = new Request(`https://pairfob.com/v2/ws?role=client&daemon_id=${daemonId}`, {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": "pairfob.v2",
        Origin: "https://pairfob.com",
      },
    });

    const res = await handleFetch(req, env);
    expect(res.status).toBe(400);
    expect(rooms.fetchLog).toEqual([]);
  });
});

describe("worker /v2/ws session budget", () => {
  test("caps daemon upgrades per IP before the Room and leaves another IP a slot", async () => {
    const { env, rooms } = seededEnv();
    const n = LIMITS.sessionIP.n;

    for (let i = 0; i < n; i++) await handleFetch(upgradeReq("daemon", IP_A), env);
    expect(rooms.fetchLog.length).toBe(n);
    // The Room's own pending cap still bounds accepted sockets, but every
    // allowed upgrade was counted before it.
    expect(rooms.harness(DAEMON_ID)!.sockets.length).toBe(MAX_PENDING_HELLO);

    const over = await handleFetch(upgradeReq("daemon", IP_A), env);
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ ok: false, error: { code: "rate_limited" } });
    expect(rooms.fetchLog.length).toBe(n);
    expect(rooms.harness(DAEMON_ID)!.sockets.length).toBe(MAX_PENDING_HELLO);

    await expirePendingHellos(rooms);
    const other = await handleFetch(upgradeReq("daemon", IP_B), env);
    expect(other.status).toBe(101);
    expect(rooms.fetchLog.length).toBe(n + 1);
  });

  test("ticketless client upgrades keep their per-IP cap", async () => {
    const { env, rooms } = seededEnv();
    const n = LIMITS.sessionIP.n;

    for (let i = 0; i < n; i++) await handleFetch(upgradeReq("client", IP_A), env);
    expect(rooms.fetchLog.length).toBe(n);

    const over = await handleFetch(upgradeReq("client", IP_A), env);
    expect(over.status).toBe(429);
    expect(rooms.fetchLog.length).toBe(n);
  });

  test("daemon and ticketless client upgrades share one per-IP budget", async () => {
    const { env, rooms } = seededEnv();
    const n = LIMITS.sessionIP.n;
    const daemonRequests = Math.floor(n / 2);

    for (let i = 0; i < daemonRequests; i++) await handleFetch(upgradeReq("daemon", IP_A), env);
    for (let i = daemonRequests; i < n; i++) await handleFetch(upgradeReq("client", IP_A), env);
    expect(rooms.fetchLog.length).toBe(n);

    for (const role of ["daemon", "client"] as const) {
      expect((await handleFetch(upgradeReq(role, IP_A), env)).status).toBe(429);
    }
    expect(rooms.fetchLog.length).toBe(n);
  });

  test("ticket-bearing client upgrades are not charged to the session budget", async () => {
    const { env, rooms } = seededEnv();
    const n = LIMITS.sessionIP.n;

    for (let i = 0; i < n; i++) await handleFetch(upgradeReq("daemon", IP_A), env);
    expect(rooms.fetchLog.length).toBe(n);
    await expirePendingHellos(rooms);

    const ticket = "ab".repeat(16);
    const withTicket = await handleFetch(upgradeReq("client", IP_A, `&pair_ticket=${ticket}`), env);
    // The unknown ticket is rejected by the Room, not by the Worker budget.
    expect(withTicket.status).toBe(404);
    expect(await withTicket.json()).toEqual(UNPAIRED_BODY);
    expect(rooms.fetchLog.length).toBe(n + 1);
  });
});
