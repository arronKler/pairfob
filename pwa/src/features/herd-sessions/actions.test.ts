import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { attachLiveSession, setComputers, setCredential } from "../computers/catalog-store";
import { currentScreen, setScreen } from "../../app/navigation-store";
import { batch } from "../../shared/model/domain-store";
import type { LiveSession } from "../../lib/protocol/session-types";
import type { PairResult } from "../../lib/protocol/client";
import { loadHerdSessions, switchHerdSession } from "./actions";
import { currentHerdSession, herdSessions, herdSessionsSupported, setCurrentHerdSession, setHerdSessions } from "./herd-session-store";

/**
 * Herd-sessions controller. Setup mirrors computers/actions.reentry.test.ts:
 * a live session is attached through the catalog store's named owner action,
 * not a global fixture, so each test controls exactly what its mock exposes.
 */

const pair: PairResult = {
  daemonId: "daemon-a",
  hostname: "daemon-a",
  deviceId: "dev_abcdefgh",
  psk: new Uint8Array(32),
  daemonPk: new Uint8Array(32),
  fp: "0".repeat(16),
  relayOrigin: "https://pairfob.com",
  label: "phone",
  createdAt: 1_700_000_000_000,
};

function mockSession(overrides: Partial<LiveSession> = {}): LiveSession {
  return {
    isConnected: () => true,
    snapshot: async () => ({}),
    close() {},
    onEvent: () => () => {},
    ...overrides,
  } as unknown as LiveSession;
}

beforeEach(async () => {
  await resetBoardTestDOM();
  act(() => {
    batch(() => {
      setComputers([pair]);
      setCredential(pair);
      setScreen("home");
    });
    setHerdSessions([]);
    setCurrentHerdSession(null);
  });
});

afterEach(() => {
  act(() => {
    attachLiveSession(null);
    setCredential(null);
    setComputers([]);
  });
});

test("loadHerdSessions marks unsupported when the daemon has no listSessions", async () => {
  act(() => attachLiveSession(mockSession()));
  await loadHerdSessions();
  expect(herdSessionsSupported()).toBeFalse();
  expect(herdSessions()).toEqual([]);
});

test("loadHerdSessions adopts a successful listing", async () => {
  const sessions = [{ name: null, running: true }, { name: "heydru", running: true }, { name: "derecho", running: false }];
  act(() => attachLiveSession(mockSession({ listSessions: async () => ({ sessions }) })));
  await loadHerdSessions();
  expect(herdSessionsSupported()).toBeTrue();
  expect(herdSessions()).toEqual(sessions);
});

test("loadHerdSessions fails closed on any listSessions rejection, not just unknown_op/unsupported", async () => {
  act(() => setHerdSessions([{ name: "stale", running: true }]));
  act(() => attachLiveSession(mockSession({
    listSessions: async () => { throw new Error("network blip"); },
  })));
  await loadHerdSessions();
  expect(herdSessionsSupported()).toBeFalse();
  expect(herdSessions()).toEqual([]);
});

test("switchHerdSession is a no-op when the daemon does not support setSession", () => {
  act(() => attachLiveSession(mockSession()));
  switchHerdSession("heydru");
  expect(currentHerdSession()).toBeNull();
});

test("switchHerdSession is a no-op when the target is already current", () => {
  let calls = 0;
  act(() => attachLiveSession(mockSession({ setSession: () => { calls += 1; } })));
  act(() => setCurrentHerdSession("heydru"));
  switchHerdSession("heydru");
  expect(calls).toBe(0);
});

test("switchHerdSession selects the session on the live connection and publishes it locally", () => {
  const selected: (string | null)[] = [];
  act(() => attachLiveSession(mockSession({ setSession: (name) => { selected.push(name); } })));
  switchHerdSession("heydru");
  expect(selected).toEqual(["heydru"]);
  expect(currentHerdSession()).toBe("heydru");
});

test("switchHerdSession leaves an open pane for the board, since the old pane has no meaning in the new session", () => {
  act(() => {
    attachLiveSession(mockSession({ setSession: () => {} }));
    setScreen("pane");
  });
  switchHerdSession("derecho");
  expect(currentScreen()).toBe("board");
});

test("switchHerdSession does not disturb navigation off the pane screen", () => {
  act(() => {
    attachLiveSession(mockSession({ setSession: () => {} }));
    setScreen("home");
  });
  switchHerdSession("derecho");
  expect(currentScreen()).toBe("home");
});
