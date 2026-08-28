import { describe, expect, test } from "bun:test";
import { handleFetch } from "./worker.ts";
import { testEnv } from "./testutil/make-room.ts";

function get(url: string, method = "GET"): Promise<Response> {
  return handleFetch(new Request(url, { method }), testEnv());
}

describe("www redirects to the apex", () => {
  test("readable pages move to the canonical host and keep path and query", async () => {
    const res = await get("https://www.pairfob.com/doc?x=1");
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("https://pairfob.com/doc?x=1");
  });

  test("the apex itself is never redirected", async () => {
    expect((await get("https://pairfob.com/v2/health")).status).toBe(200);
  });

  test("protocol surfaces on www are left alone", async () => {
    // A 301 cannot be followed by a WS handshake, and enroll must not resend
    // credentials to a second host.
    for (const path of ["/v2/ws", "/v2/enroll", "/v1/ws", "/api/config"]) {
      const res = await get("https://www.pairfob.com" + path);
      expect(res.status).not.toBe(301);
    }
    const post = await get("https://www.pairfob.com/v2/enroll", "POST");
    expect(post.status).not.toBe(301);
  });
});
