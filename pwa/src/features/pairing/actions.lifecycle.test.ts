import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { attachLiveSession, setAddingComputer, setComputers, setCredential } from "../computers/catalog-store";
import { phase, setPhase } from "../connection/connection-store";
import {
  pairingStore, pairAbortHandle, setPairAbort, pairAwaitingApproval, resetPairingInput,
  setPairAwaitingApproval, setPairManualOpen,
} from "./form-store";
import { clearNotice } from "../../app/notices-store";
import {
  cancelPairing, disposePairingPageTransport, pairingErrorStillOwned,
} from "./actions";
import {
  claimPairingPage, claimPairingTransport, pairingWorkId, releasePairingPage, retirePairingWork,
} from "./work";
import { cancelAddComputer } from "../computers/actions";


beforeEach(async () => {
  await resetBoardTestDOM();
  act(() => {
    // First-pair fixture: the direct Cancel test lands `connect` only when no
    // catalog, credential, live session, pairing input or notice remains from
    // an earlier test (named value resets, not subscriber clears).
    setPhase("connect");
    setPairAbort(null);
    resetPairingInput();
    setPairManualOpen(false);
    clearNotice();
    setAddingComputer(false);
    setComputers([]);
    setCredential(null);
    attachLiveSession(null);
  });
});

afterEach(() => {
  act(() => {
    resetPairingInput();
    setPairAbort(null);
    clearNotice();
    setPhase("boot");
    setAddingComputer(false);
  });
});

test("a cancelled handshake still owns landing while phase is pairing and the abort handle is ours", () => {
  const abort = new AbortController();
  const work = pairingWorkId();
  act(() => {
    setPairAbort(abort);
    setPhase("pairing");
  });
  retirePairingWork();
  abort.abort();
  expect(pairingWorkId()).not.toBe(work);
  expect(pairingErrorStillOwned(work, abort)).toBeTrue();
});

test("a superseded handshake does not land over a new attempt's abort handle", () => {
  const oldAbort = new AbortController();
  const newAbort = new AbortController();
  const work = pairingWorkId();
  act(() => {
    setPairAbort(oldAbort);
    setPhase("pairing");
  });
  retirePairingWork();
  oldAbort.abort();
  act(() => setPairAbort(newAbort));
  expect(pairingErrorStillOwned(work, oldAbort)).toBeFalse();
});

test("cancelPairing lands connect without waiting for a protocol rejection", () => {
  const abort = new AbortController();
  act(() => {
    setPairAbort(abort);
    setPhase("pairing");
  });
  cancelPairing();
  expect(phase()).toBe("connect");
  expect(pairAbortHandle()).toBeNull();
  expect(abort.signal.aborted).toBeTrue();
  expect(pairAwaitingApproval()).toBeFalse();
});

test("a released page no longer owns landing even with a live abort handle", () => {
  const abort = new AbortController();
  const page = {};
  claimPairingPage(page);
  const work = pairingWorkId();
  act(() => {
    setPairAbort(abort);
    setPhase("pairing");
  });
  releasePairingPage(page);
  expect(pairingErrorStillOwned(work, abort, page)).toBeFalse();
});

test("a replacement attempt on the same page takes landing away from the old abort", () => {
  const oldAbort = new AbortController();
  const newAbort = new AbortController();
  const page = {};
  claimPairingPage(page);
  const work = pairingWorkId();
  act(() => {
    setPairAbort(oldAbort);
    setPhase("pairing");
  });
  retirePairingWork();
  act(() => setPairAbort(newAbort));
  expect(pairingErrorStillOwned(work, oldAbort, page)).toBeFalse();
});

test("the still-mounted page keeps landing while its own handle is current", () => {
  const abort = new AbortController();
  const page = {};
  claimPairingPage(page);
  const work = pairingWorkId();
  act(() => {
    setPairAbort(abort);
    setPhase("pairing");
  });
  retirePairingWork();
  abort.abort();
  expect(pairingErrorStillOwned(work, abort, page)).toBeTrue();
});

test("page transport disposal aborts only the handshake that page started", () => {
  const page = {};
  const first = new AbortController();
  claimPairingTransport(page, first);
  disposePairingPageTransport(page);
  expect(first.signal.aborted).toBeTrue();
  const replacement = {};
  const second = new AbortController();
  claimPairingTransport(page, second);
  disposePairingPageTransport(replacement);
  expect(second.signal.aborted).toBeFalse();
  disposePairingPageTransport(page);
  expect(second.signal.aborted).toBeTrue();
});

test("cancelPairing leaves a replacement attempt's handle and phase alone", () => {
  const first = new AbortController();
  act(() => {
    setPairAbort(first);
    setPairAwaitingApproval(true);
    setPhase("pairing");
  });
  const second = new AbortController();
  let replaced = false;
  const stop = pairingStore.subscribe(() => {
    if (replaced || pairAwaitingApproval()) return;
    replaced = true;
    setPairAbort(second);
    setPhase("pairing");
  });
  try {
    cancelPairing();
  } finally {
    stop();
  }
  expect(replaced).toBeTrue();
  expect(first.signal.aborted).toBeTrue();
  expect(second.signal.aborted).toBeFalse();
  expect(pairAbortHandle()).toBe(second);
  expect(phase()).toBe("pairing");
});

test("leaving add-computer retires pairing work so a captured scan id is stale", () => {
  const captured = pairingWorkId();
  act(() => {
    setAddingComputer(true);
    setPhase("connect");
  });
  cancelAddComputer();
  expect(pairingWorkId()).not.toBe(captured);
});
