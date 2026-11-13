import { expect, test } from "bun:test";
import { DirectError, type DirectOffer } from "./direct-peer";
import { ProtocolError } from "./errors";
import type { PairResult } from "./pair-ws";
import { prepareDirectSession } from "./session-upgrade";
import type { SessionTransport } from "./session-transport";

function fixture() {
  let closes = 0, sent = 0, accepted = 0;
  const offer: DirectOffer = {
    attemptId: "p2p_0123456789abcdef", sdp: "v=0\r\nm=application\r\n", iceGathering: "complete",
    close: () => { closes++; },
    accept: async () => { accepted++; throw new Error("unexpected accept"); },
  };
  const relay = { kind: "relay", rpc: async () => { sent++; throw new ProtocolError("unknown_op", "old daemon"); } } as unknown as SessionTransport;
  return { offer, relay, pair: {} as PairResult, closes: () => closes, sent: () => sent, accepted: () => accepted };
}

test("an older daemon's refusal closes the prepared peer without a second offer", async () => {
  const f = fixture();
  await expect(prepareDirectSession(f.relay, f.pair, 2, undefined, undefined, () => Promise.resolve(f.offer)))
    .rejects.toMatchObject({ code: "unknown_op", diagnostic: "signal" });
  expect(f.sent()).toBe(1); expect(f.closes()).toBe(1); expect(f.accepted()).toBe(0);
});

test("cancellation between preparation and signaling sends no RPC", async () => {
  const f = fixture(), owner = new AbortController(); owner.abort();
  await expect(prepareDirectSession(f.relay, f.pair, 2, owner.signal, undefined, () => Promise.resolve(f.offer)))
    .rejects.toMatchObject({ diagnostic: "cancelled" });
  expect(f.sent()).toBe(0); expect(f.closes()).toBe(1);
});

test("failed preparation is surfaced to the existing retry policy without signaling", async () => {
  const f = fixture(), error = new DirectError("ice_timeout", "failed");
  await expect(prepareDirectSession(f.relay, f.pair, 2, undefined, undefined, () => Promise.reject(error))).rejects.toBe(error);
  expect(f.sent()).toBe(0);
});

test("a stale non-relay caller does not take ownership of a prepared offer", async () => {
  const f = fixture(); let taken = false;
  const direct = { kind: "p2p" } as SessionTransport;
  await expect(prepareDirectSession(direct, f.pair, 2, undefined, undefined, () => { taken = true; return Promise.resolve(f.offer); }))
    .rejects.toMatchObject({ code: "conflict" });
  expect(taken).toBe(false);
});
