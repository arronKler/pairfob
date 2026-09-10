import { expect, test } from "bun:test";
import { claimPairingPage, pairingWorkId, releasePairingPage, retirePairingWork } from "./work";

test("retirePairingWork bumps the generation so a captured id is stale", () => {
  const before = pairingWorkId();
  retirePairingWork();
  expect(pairingWorkId()).toBe(before + 1);
  const captured = pairingWorkId();
  retirePairingWork();
  expect(pairingWorkId()).not.toBe(captured);
});

test("releasing a page instance retires work unless the same owner reclaims it", () => {
  const first = {};
  const second = {};
  claimPairingPage(first);
  const work = pairingWorkId();
  claimPairingPage(first);
  expect(pairingWorkId()).toBe(work);
  releasePairingPage(first);
  expect(pairingWorkId()).not.toBe(work);
  claimPairingPage(first);
  expect(pairingWorkId()).toBe(work);
  releasePairingPage(first);
  claimPairingPage(second);
  expect(pairingWorkId()).not.toBe(work);
  const afterSecond = pairingWorkId();
  releasePairingPage(first);
  expect(pairingWorkId()).toBe(afterSecond);
  releasePairingPage(second);
  expect(pairingWorkId()).toBe(afterSecond + 1);
  releasePairingPage(second);
  expect(pairingWorkId()).toBe(afterSecond + 1);
});

test("explicit retirement cannot be restored by reclaiming a released page", () => {
  const owner = {};
  claimPairingPage(owner);
  const work = pairingWorkId();
  releasePairingPage(owner);
  retirePairingWork();
  claimPairingPage(owner);
  expect(pairingWorkId()).not.toBe(work);
});
