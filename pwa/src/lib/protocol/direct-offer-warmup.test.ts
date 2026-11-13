import { expect, test } from "bun:test";
import { DirectOfferWarmup } from "./direct-offer-warmup";
import { DirectError, type DirectOffer } from "./direct-peer";

function fixture() {
  let calls = 0, closes = 0;
  let signal: AbortSignal | undefined;
  let resolve!: (offer: DirectOffer) => void;
  let reject!: (error: Error) => void;
  const ready = new Promise<DirectOffer>((yes, no) => { resolve = yes; reject = no; });
  const network = new EventTarget();
  const warmup = new DirectOfferWarmup(async input => { calls++; signal = input; return ready; }, network);
  const offer = { attemptId: "p2p_test", sdp: "sdp", iceGathering: "complete", close: () => { closes++; } } as DirectOffer;
  return { warmup, network, offer, resolve: () => resolve(offer), reject, calls: () => calls, closes: () => closes, signal: () => signal };
}

test("one preparation is taken once, with no second ICE offer", async () => {
  const f = fixture();
  f.warmup.start(); f.warmup.start();
  await Promise.resolve();
  expect(f.calls()).toBe(1);
  f.resolve();
  expect(await f.warmup.take()).toBe(f.offer);
  expect(f.warmup.take()).toBeUndefined();
  f.warmup.cancel();
  expect(f.closes()).toBe(0); // Ownership passed to the upgrade.
});

test("cancelled work closes a late result and leaves the warmup reusable", async () => {
  const f = fixture();
  f.warmup.start(); await Promise.resolve();
  f.warmup.cancel();
  expect(f.signal()?.aborted).toBe(true);
  f.resolve(); await Bun.sleep(0);
  expect(f.closes()).toBe(1);
  expect(f.warmup.take()).toBeUndefined();
  f.warmup.start();
  expect(await f.warmup.take()).toBe(f.offer);
  expect(f.calls()).toBe(2);
});

test("cancelling a ready preparation closes its peer", async () => {
  const f = fixture(); f.warmup.start(); f.resolve(); await Bun.sleep(0);
  f.warmup.cancel(); f.warmup.cancel();
  expect(f.closes()).toBe(1);
});

test("a failed preparation is consumed once instead of retried immediately", async () => {
  const f = fixture(); f.warmup.start();
  const failure = new DirectError("ice_timeout", "timeout");
  f.reject(failure); await Bun.sleep(0);
  await expect(f.warmup.take()).rejects.toBe(failure);
  expect(f.calls()).toBe(1);
  expect(f.warmup.take()).toBeUndefined();
});

test("upgrade cancellation aborts an unfinished preparation and closes its late peer", async () => {
  const f = fixture(); f.warmup.start(); await Promise.resolve();
  const owner = new AbortController();
  const result = f.warmup.take(owner.signal)!;
  owner.abort(); f.resolve();
  await expect(result).rejects.toMatchObject({ diagnostic: "cancelled" });
  expect(f.signal()?.aborted).toBe(true);
  expect(f.closes()).toBe(1);
});

test("an already aborted upgrade cannot consume a ready peer", async () => {
  const f = fixture(); f.warmup.start(); f.resolve(); await Bun.sleep(0);
  const owner = new AbortController(); owner.abort();
  await expect(f.warmup.take(owner.signal)).rejects.toMatchObject({ diagnostic: "cancelled" });
  expect(f.closes()).toBe(1);
});

test("network change discards an old-path offer without starting another", async () => {
  const f = fixture(); f.warmup.start(); f.resolve(); await Bun.sleep(0);
  f.network.dispatchEvent(new Event("change"));
  expect(f.closes()).toBe(1);
  expect(f.warmup.take()).toBeUndefined();
  expect(f.calls()).toBe(1);
});

test("a taken peer is no longer owned by the warmup's network listener", async () => {
  const f = fixture(); f.warmup.start(); f.resolve();
  await f.warmup.take(); f.network.dispatchEvent(new Event("change"));
  expect(f.closes()).toBe(0);
});

test("a preparation cancelled in the same turn never opens a peer", async () => {
  const f = fixture(); f.warmup.start(); f.warmup.cancel();
  await Bun.sleep(0);
  expect(f.calls()).toBe(0);
});

test("a cancelled preparation finishing late cannot replace its successor", async () => {
  let resolveOld!: (offer: DirectOffer) => void, resolveNew!: (offer: DirectOffer) => void;
  const old = new Promise<DirectOffer>(resolve => { resolveOld = resolve; });
  const next = new Promise<DirectOffer>(resolve => { resolveNew = resolve; });
  let calls = 0, oldClosed = 0, nextClosed = 0;
  const warmup = new DirectOfferWarmup(() => ++calls === 1 ? old : next);
  const oldOffer = { close: () => { oldClosed++; } } as DirectOffer;
  const nextOffer = { close: () => { nextClosed++; } } as DirectOffer;
  warmup.start(); await Promise.resolve(); warmup.cancel();
  warmup.start(); resolveNew(nextOffer);
  resolveOld(oldOffer); await Bun.sleep(0);
  expect(await warmup.take()).toBe(nextOffer);
  expect(oldClosed).toBe(1); expect(nextClosed).toBe(0);
});
