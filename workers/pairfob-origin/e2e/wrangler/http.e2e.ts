/// <reference types="@cloudflare/vitest-pool-workers" />
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("wrangler/miniflare HTTP (not a hibernation proof)", () => {
  it("GET /v2/health", async () => {
    const res = await SELF.fetch("https://pairfob.com/v2/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, protocol: 2 });
  });

  it("GET /api/config is protocol 2 with no-store", async () => {
    const res = await SELF.fetch("https://pairfob.com/api/config");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { protocol: number };
    expect(body.protocol).toBe(2);
  });

  it("GET /v1/ws is 426", async () => {
    const res = await SELF.fetch("https://pairfob.com/v1/ws");
    expect(res.status).toBe(426);
  });

  it("GET /v2/ws?pair_loc= is 404 unpaired without upgrade", async () => {
    const res = await SELF.fetch(
      "https://pairfob.com/v2/ws?role=client&daemon_id=d_aaaaaaaaaaaaaaaaaaaa&pair_loc=WJ3K9M",
      { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "pairfob.v2", Origin: "https://pairfob.com" } },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: { code: "unpaired" } });
  });
});
