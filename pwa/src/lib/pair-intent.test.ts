import { describe, expect, test } from "bun:test";
import { ProtocolError } from "./protocol/client.ts";
import { requestPairIntent } from "./pair-intent.ts";

const hit = {
  ok: true,
  v: 2,
  daemon_id: "d_0123456789abcdefabcd",
  pair_ref: "4f7a2c9e1b0d88aa55cc3311abde7001",
  pair_ticket: "ab".repeat(16),
  expires_in: 15,
};

describe("pair-intent", () => {
  test("POSTs only v and pair_loc and returns ticket fields", async () => {
    let body = "";
    const intent = await requestPairIntent("WJ3K9M", async (_input, init) => {
      body = String(init?.body || "");
      expect(String(_input)).toBe("/v2/pair-intent");
      expect(init?.method).toBe("POST");
      expect(init?.cache).toBe("no-store");
      return new Response(JSON.stringify(hit), { status: 200 });
    });
    expect(JSON.parse(body)).toEqual({ v: 2, pair_loc: "WJ3K9M" });
    expect(body).not.toContain("pair_ref");
    expect(body).not.toMatch(/"s"/);
    expect(intent).toEqual({
      daemonId: "d_0123456789abcdefabcd",
      pairRef: "4f7a2c9e1b0d88aa55cc3311abde7001",
      pairTicket: "ab".repeat(16),
    });
  });

  test("404 unpaired is a friendly unpaired error", async () => {
    const error = await requestPairIntent("WJ3K9M", async () => {
      return new Response(JSON.stringify({ ok: false, error: { code: "unpaired" } }), { status: 404 });
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe("unpaired");
  });

  test("maps HTTP 429 to rate_limited", async () => {
    const error = await requestPairIntent("WJ3K9M", async () => {
      return new Response(JSON.stringify({ ok: false, error: { code: "rate_limited" } }), { status: 429 });
    }).catch((caught) => caught);
    expect((error as ProtocolError).code).toBe("rate_limited");
  });

  test("cancels the HTTP lookup when the user cancels pairing", async () => {
    const controller = new AbortController();
    const pending = requestPairIntent("WJ3K9M", async (_input, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }, controller.signal);
    controller.abort();
    const error = await pending.catch((caught) => caught);
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe("pairing_cancelled");
  });
});
