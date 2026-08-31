import { describe, expect, test } from "bun:test";
import { ProtocolError } from "./protocol/client.ts";
import { clientWsURL, loadOriginConfig, parseOriginConfig } from "./origin-config.ts";

describe("origin config", () => {
  test("parses protocol 2 only", () => {
    expect(parseOriginConfig({ protocol: 2, build: "abc" })).toEqual({ protocol: 2, build: "abc" });
    expect(() => parseOriginConfig({ protocol: 1, build: "dev" })).toThrow(ProtocolError);
    expect(() => parseOriginConfig({ protocol: 3, build: "x" })).toThrow(ProtocolError);
    expect(() => parseOriginConfig({ protocol: 2 })).toThrow(ProtocolError);
  });

  test("GET /api/config uses no-store and stores protocol", async () => {
    const calls: string[] = [];
    const config = await loadOriginConfig(async (input, init) => {
      calls.push(`${init?.cache}:${String(input)}`);
      return new Response(JSON.stringify({ protocol: 2, build: "s11" }), { status: 200 });
    });
    expect(config).toEqual({ protocol: 2, build: "s11" });
    expect(calls).toEqual(["no-store:/api/config"]);
  });

  test("network failures become bad_relay instead of a generic TypeError", async () => {
    try {
      await loadOriginConfig(async () => {
        throw new TypeError("Failed to fetch");
      });
      throw new Error("expected loadOriginConfig to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe("bad_relay");
    }
  });

  test("ws URL is /v2/ws with role, daemon_id, and ticket", () => {
    const site = { protocol: "https:", host: "pairfob.com" };
    expect(clientWsURL(2, site)).toBe("wss://pairfob.com/v2/ws?role=client");
    expect(clientWsURL(2, site, { daemonId: "d_0123456789abcdefabcd" })).toBe(
      "wss://pairfob.com/v2/ws?role=client&daemon_id=d_0123456789abcdefabcd",
    );
    expect(
      clientWsURL(2, site, { daemonId: "d_0123456789abcdefabcd", pairTicket: "aa".repeat(16) }),
    ).toBe(`wss://pairfob.com/v2/ws?role=client&daemon_id=d_0123456789abcdefabcd&pair_ticket=${"aa".repeat(16)}`);
    expect(() => clientWsURL(1, site)).toThrow(ProtocolError);
    expect(clientWsURL(2, site)).not.toContain("/v1/ws");
    expect(clientWsURL(2, site, { daemonId: "d_0123456789abcdefabcd" })).not.toContain("pair_loc");
  });
});
