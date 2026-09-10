import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { batch } from "../../shared/model/domain-store";
import {
  clearNotificationTarget, clearPairingFragment, connectionStore, setPhase,
} from "../connection/connection-store";
import {
  attachLiveSession, setComputers, setCredential, setAddingComputer,
} from "../computers/catalog-store";
import { pairCodeDraft, resetPairingInput, setPairCodeDraft, setPairManualOpen } from "./form-store";
import { setScreen } from "../../app/navigation-store";
import { stopPolling } from "../connection/controller";
import * as protocol from "../../lib/protocol/client";
import * as scanner from "../../lib/pairing-scanner";

/**
 * Scanner publication preflight (R1 regression).
 *
 * Adopting a scanned fragment publishes the connection domain. A subscriber to
 * that publication can retire the scan — cancel, back, unmount — and open a
 * replacement manual input. The retired continuation must never start a
 * handshake and must not overwrite the replacement draft. The generation is
 * captured across every publishing step, including the phase/handle batch
 * inside beginPairing.
 */

let handshakes = 0;
const scan = {
  v: 2 as const, code: "ABCDEFGH", pairRef: "ref",
  daemonId: "d_aaaaaaaaaaaaaaaaaaaa", fingerprint: "fingerprint",
};

mock.module("../../lib/protocol/client", () => ({
  ...protocol,
  pairOverWS: async () => {
    handshakes += 1;
    throw new protocol.ProtocolError("pairing_cancelled", "mock never completes");
  },
}));
mock.module("../../lib/pairing-scanner", () => ({
  ...scanner,
  scanPairingCode: async () => ({ ...scan }),
}));

const pairing = await import("./actions");
const work = await import("./work");

beforeEach(async () => {
  await resetBoardTestDOM();
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  handshakes = 0;
  work.retirePairingWork();
  batch(() => {
    setPhase("connect");
    clearPairingFragment();
    clearNotificationTarget();
    attachLiveSession(null);
    setCredential(null);
    setComputers([]);
    resetPairingInput();
    setScreen("home");
  });
});

afterEach(() => {
  // Release this suite's own state by value, not by clearing store subscribers
  // (store.reset only drops listeners/dirty/hold): retire the work and restore
  // the headless connect/home baseline for the next process/case.
  work.retirePairingWork();
  batch(() => {
    setPhase("boot");
    setScreen("home");
    setAddingComputer(false);
    setComputers([]);
    setCredential(null);
    attachLiveSession(null);
    resetPairingInput();
    clearPairingFragment();
    clearNotificationTarget();
  });
  stopPolling();
});

test("an ordinary scan starts exactly one handshake with the scanned code", async () => {
  await pairing.scanPairCode();
  expect(handshakes).toBe(1);
  expect(pairCodeDraft()).toBe("ABCDEFGH");
});

test("a scan retired at the fragment publication neither handshakes nor overwrites the replacement draft", async () => {
  const stop = connectionStore.subscribe(() => {
    if (pairingFragmentGuard()) return;
    work.retirePairingWork();
    setPairCodeDraft("replacement B");
    setPairManualOpen(true);
  });
  function pairingFragmentGuard(): boolean {
    // Retire on the first publication that carries the scanned fragment.
    return connectionStore.get().fragment === null;
  }
  try {
    await pairing.scanPairCode();
  } finally {
    stop();
  }
  expect(handshakes).toBe(0);
  expect(pairCodeDraft()).toBe("replacement B");
});

test("a scan retired at the pairing phase publication still opens no transport", async () => {
  // Retire slightly later: when the phase reaches "pairing" inside beginPairing,
  // a replacement/cancel can still land between the fragment batch and the
  // transport — that continuation must preflight before any RPC.
  const stop = connectionStore.subscribe(() => {
    if (connectionStore.get().phase !== "pairing") return;
    work.retirePairingWork();
  });
  try {
    await pairing.scanPairCode();
  } finally {
    stop();
  }
  expect(handshakes).toBe(0);
});
