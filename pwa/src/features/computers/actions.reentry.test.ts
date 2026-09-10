import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { attachLiveSession, liveSession, setAddingComputer, addingComputer, setComputers, setCredential } from "./catalog-store";
import { phase, setPhase } from "../connection/connection-store";
import { currentScreen, setScreen } from "../../app/navigation-store";
import {
  pairAbortHandle, setPairAbort, resetPairingInput,
} from "../pairing/form-store";
import { clearNotice, disposeNoticeLifecycle } from "../../app/notices-store";
import { batch } from "../../shared/model/domain-store";
import type { PairResult } from "../../lib/protocol/client";
import type { LiveSession } from "../../lib/protocol/session-types";
import { beginAddComputer, cancelAddComputer, forgetCompletionIsStale, leaveComputers, switchComputer } from "./actions";
import { computersFlowId } from "./work";

/**
 * Computers controller reentry ownership. Setup reads and writes named typed
 * domain actions (no global state facade): the abort handle, flow generation,
 * live session/credential and phase/screen are all observed through their
 * owners. The catalog reload/subscription contract is covered by the mounted
 * picker fixture against the real reloadComputers publication.
 */

const pair = (daemonId: string): PairResult => ({
  daemonId,
  hostname: daemonId,
  deviceId: "dev_abcdefgh",
  psk: new Uint8Array(32),
  daemonPk: new Uint8Array(32),
  fp: "0".repeat(16),
  relayOrigin: "https://pairfob.com",
  label: "phone",
  createdAt: 1_700_000_000_000,
});
const a = pair("daemon-a");
const b = pair("daemon-b");
const session = (id: string) => ({ id, isConnected: () => true, close() {}, onEvent: () => () => {} }) as unknown as LiveSession;

beforeEach(async () => {
  await resetBoardTestDOM();
  act(() => {
    clearNotice();
    batch(() => {
      setComputers([a, b]);
      setCredential(a);
      attachLiveSession(session("a"));
      setAddingComputer(false);
      setPhase("live");
      setScreen("computers");
      // The abort handle and pairing input reset through their named actions.
      resetPairingInput();
    });
  });
});

afterEach(() => {
  disposeNoticeLifecycle();
  act(() => {
    attachLiveSession(null);
    setPairAbort(null);
    setPhase("boot");
    // Restore this suite's canonical baseline through the named owner actions:
    // a later suite (e.g. operations/run) reads the default owner credential
    // and expects none injected. The record values must be restored by the
    // owner actions themselves — the old store.reset calls only dropped the
    // subscriber registries and never touched the canonical values. Retaining
    // the registries keeps this suite from dropping external subscriptions.
    setCredential(null);
    setComputers([]);
    setAddingComputer(false);
  });
});

test("cancel Add after an abort listener retires the session lands pick, not live", () => {
  setPairAbort(new AbortController());
  pairAbortHandle()!.signal.addEventListener("abort", () => attachLiveSession(null));
  cancelAddComputer();
  expect(liveSession()).toBeNull();
  expect(phase()).toBe("pick");
  expect(currentScreen()).toBe("home");
  // The add flow is cleared, not left engaged.
  expect(addingComputer()).toBeFalse();
});

test("forgetCompletionIsStale yields to a replacement owner and does not treat a non-current forget as stale", () => {
  const oldSession = { id: "old" };
  const newSession = { id: "new" };
  const base = {
    forgottenDaemonId: a.daemonId,
    wasCurrent: true,
    ownerNow: null as string | null,
    sessionNow: null as object | null,
    sessionAtStart: oldSession,
    flowAtStart: 1,
    flowNow: 1,
  };
  expect(forgetCompletionIsStale({ ...base, ownerNow: b.daemonId, sessionNow: newSession })).toBeTrue();
  expect(forgetCompletionIsStale({ ...base, sessionNow: newSession })).toBeTrue();
  expect(forgetCompletionIsStale(base)).toBeFalse();
  expect(forgetCompletionIsStale({
    ...base,
    forgottenDaemonId: b.daemonId,
    wasCurrent: false,
    ownerNow: a.daemonId,
    sessionNow: oldSession,
  })).toBeFalse();
});

test("forgetCompletionIsStale yields to a later flow even when live and credential are already null", () => {
  const oldSession = { id: "old" };
  expect(forgetCompletionIsStale({
    forgottenDaemonId: a.daemonId,
    wasCurrent: true,
    ownerNow: null,
    sessionNow: null,
    sessionAtStart: oldSession,
    flowAtStart: 1,
    flowNow: 2,
  })).toBeTrue();
  expect(forgetCompletionIsStale({
    forgottenDaemonId: b.daemonId,
    wasCurrent: false,
    ownerNow: null,
    sessionNow: null,
    sessionAtStart: oldSession,
    flowAtStart: 4,
    flowNow: 5,
  })).toBeTrue();
});

test("Add, leave and same-computer switch advance the computers flow", async () => {
  const afterGuard = computersFlowId();
  setPhase("pairing");
  beginAddComputer();
  expect(computersFlowId()).toBe(afterGuard);

  setPhase("live");
  beginAddComputer();
  expect(computersFlowId()).toBe(afterGuard + 1);
  expect(phase()).toBe("connect");
  // beginAddComputer engages the add flow and publishes it to the domain.
  expect(addingComputer()).toBeTrue();

  leaveComputers("home");
  expect(computersFlowId()).toBe(afterGuard + 2);
  expect(currentScreen()).toBe("home");

  await act(async () => {
    setAddingComputer(false);
    setCredential(a);
    attachLiveSession(session("a"));
    setPhase("live");
    setScreen("computers");
  });
  await switchComputer(a.daemonId);
  expect(computersFlowId()).toBe(afterGuard + 3);
  expect(currentScreen()).toBe("home");
});
