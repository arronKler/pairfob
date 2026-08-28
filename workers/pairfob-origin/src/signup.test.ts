import { beforeEach, describe, expect, test } from "bun:test";
import { SELF_GRANT_PER_IP, SELF_GRANT_WINDOW_MS } from "./constants.ts";
import { sha256Hex } from "./crypto.ts";
import { getGrantByHash } from "./d1.ts";
import { handleEnroll } from "./enroll.ts";
import { resetLimits } from "./limits.ts";
import { handleSignup } from "./signup.ts";
import { FakeD1 } from "./testutil/fake-d1.ts";
import { testEnv } from "./testutil/make-room.ts";

beforeEach(() => resetLimits());

function signupReq(extra?: HeadersInit, ip = "203.0.113.7"): Request {
  return new Request("https://pairfob.com/v2/grants", {
    method: "POST",
    headers: {
      Origin: "https://pairfob.com",
      Host: "pairfob.com",
      "CF-Connecting-IP": ip,
      ...extra,
    },
  });
}

describe("self-serve grants", () => {
  test("a visitor gets a usable grant", async () => {
    const d1 = new FakeD1();
    const env = testEnv({ d1 });

    const res = await handleSignup(signupReq(), env, 1_000_000);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { join_grant: string; max_daemons: number };
    expect(body.join_grant).toMatch(/^jg_[0-9a-f]{32}$/);
    expect(body.max_daemons).toBe(2);

    const row = await getGrantByHash(d1, await sha256Hex(body.join_grant));
    expect(row?.max_daemons).toBe(2);
    expect(row?.label).toBe("self-serve");

    const enrolled = await handleEnroll(
      new Request("https://pairfob.com/v2/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
        body: JSON.stringify({
          v: 2,
          join_grant: body.join_grant,
          daemon_id: "d_" + "11".repeat(10),
          reconnect_token: "rt_" + "11".repeat(16),
        }),
      }),
      env,
    );
    expect(enrolled.status).toBe(200);
  });

  test("signup is open by default and can be shut off", async () => {
    const openEnv = testEnv();
    const config = await handleSignup(new Request("https://pairfob.com/v2/grants"), openEnv, 1);
    expect(config.status).toBe(200);
    expect(await config.json()).toEqual({ ok: true, open: true, max_daemons: 2 });

    const d1 = new FakeD1();
    const closedEnv = testEnv({ d1, signupOpen: "0" });
    const closed = await handleSignup(signupReq(), closedEnv, 1_000_000);
    expect(closed.status).toBe(403);
    expect(d1.grants.size).toBe(0);
  });

  test("a missing or cross-site Origin is rejected", async () => {
    const env = testEnv();
    const bare = new Request("https://pairfob.com/v2/grants", {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.7" },
    });
    expect((await handleSignup(bare, env, 1_000_000)).status).toBe(403);

    const cross = signupReq({ Origin: "https://evil.example" });
    expect((await handleSignup(cross, env, 1_000_000)).status).toBe(403);
  });

  test("D1 caps grants per address and releases the slot after the window", async () => {
    const d1 = new FakeD1();
    const env = testEnv({ d1 });
    const start = 5_000_000;

    for (let i = 0; i < SELF_GRANT_PER_IP; i++) {
      const ok = await handleSignup(signupReq(), env, start + i);
      expect(ok.status).toBe(200);
    }
    expect(d1.grants.size).toBe(SELF_GRANT_PER_IP);

    const over = await handleSignup(signupReq(), env, start + 10);
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ ok: false, error: { code: "rate_limited" } });
    expect(d1.grants.size).toBe(SELF_GRANT_PER_IP);

    resetLimits();
    const other = await handleSignup(signupReq(undefined, "198.51.100.4"), env, start + 11);
    expect(other.status).toBe(200);

    resetLimits();
    const later = await handleSignup(signupReq(), env, start + SELF_GRANT_WINDOW_MS + 1);
    expect(later.status).toBe(200);
  });

  test("the per-isolate limiter refuses a burst before D1", async () => {
    const d1 = new FakeD1();
    const originalBatch = d1.batch.bind(d1);
    let batches = 0;
    d1.batch = async (statements) => {
      batches++;
      return originalBatch(statements);
    };
    const env = testEnv({ d1 });

    for (let i = 0; i < 20; i++) await handleSignup(signupReq(), env, 7_000_000 + i);
    expect(batches).toBe(8);
  });
});
