import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import type { LiveSession, PairResult, SessionEvent } from "../../lib/protocol/client";
import { closeComputerSession, establish, refreshSnapshot } from "./controller";
import { attachLiveSession, computersStore, liveSession, setCredential } from "../computers/catalog-store";
import { connectionStore, networkOnline, sessionTransport, setNetworkOnline, setPhase } from "./connection-store";
import { dashboardStore } from "../dashboard/catalog-store";
import { resetObservationLifecycle, resetPaneView, selectPane, setFullTerminal } from "../session/session-store";
import { setScreen } from "../../app/navigation-store";
import { resetGenerationsForTests } from "./generations";

type FakeSession = LiveSession & {
  closed: number;
  emit: (event: SessionEvent) => void;
};

function pair(daemonId: string): PairResult {
  return {
    daemonId,
    deviceId: `phone_${daemonId}`,
    psk: new Uint8Array(32),
    daemonPk: new Uint8Array(32),
    relayOrigin: "https://pairfob.com",
    fp: `fp_${daemonId}`,
    label: "test",
    createdAt: 1,
  };
}

function fakeSession(): FakeSession {
  const listeners = new Set<(event: SessionEvent) => void>();
  const session = {
    closed: 0,
    close: () => { session.closed += 1; },
    isConnected: () => true,
    setNetworkAvailable: () => undefined,
    reconnectNow: () => undefined,
    switchTransport: async () => undefined,
    onEvent: (listener: (event: SessionEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (event: SessionEvent) => {
      for (const listener of listeners) listener(event);
    },
    getConfig: async () => ({}),
    snapshot: async () => ({ panes: [] }),
  } as unknown as FakeSession;
  return session;
}

const daemonIds = ["computer_switch_a", "computer_switch_b"];

beforeEach(async () => {
  await resetBoardTestDOM();
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
  resetGenerationsForTests();
  setNetworkOnline(true);
});

afterEach(() => {
  for (const daemonId of daemonIds) closeComputerSession(daemonId);
  attachLiveSession(null);
  setCredential(null);
  setPhase("pick");
  setScreen("home");
  setFullTerminal(false);
  selectPane("");
  resetPaneView();
  resetObservationLifecycle();
});

describe("switching among paired computers", () => {
  test("connects only on first activation and retains prior sessions", async () => {
    const created = new Map<string, FakeSession>();
    let connects = 0;
    const connect = async (credential: PairResult) => {
      connects += 1;
      const session = fakeSession();
      created.set(credential.daemonId, session);
      return session;
    };

    await establish(pair(daemonIds[0]), connect);
    const a = created.get(daemonIds[0])!;
    a.emit({ type: "latency", rttMs: 42, transport: "p2p" });
    expect(connects).toBe(1);

    await establish(pair(daemonIds[1]), connect);
    const b = created.get(daemonIds[1])!;
    expect(connects).toBe(2);
    expect(a.closed).toBe(0);
    expect(liveSession()).toBe(b);

    await establish(pair(daemonIds[0]), connect);
    expect(connects).toBe(2);
    expect(liveSession()).toBe(a);
    expect(connectionStore.get().relayRttMs).toBe(42);
    expect(sessionTransport()).toBe("p2p");
    expect(a.closed).toBe(0);
    expect(b.closed).toBe(0);
  });

  test("an inactive terminal failure removes only that session", async () => {
    const created = new Map<string, FakeSession>();
    let connects = 0;
    const connect = async (credential: PairResult) => {
      connects += 1;
      const session = fakeSession();
      created.set(credential.daemonId, session);
      return session;
    };

    await establish(pair(daemonIds[0]), connect);
    const a = created.get(daemonIds[0])!;
    await establish(pair(daemonIds[1]), connect);
    const b = created.get(daemonIds[1])!;
    a.emit({ type: "terminal", code: "kicked" });
    await Promise.resolve();

    expect(a.closed).toBe(1);
    expect(b.closed).toBe(0);
    expect(liveSession()).toBe(b);
    await establish(pair(daemonIds[0]), connect);
    expect(connects).toBe(3);
  });

  test("an old snapshot cannot overwrite the newly activated computer", async () => {
    const created = new Map<string, FakeSession>();
    const connect = async (credential: PairResult) => {
      const session = fakeSession();
      created.set(credential.daemonId, session);
      return session;
    };

    await establish(pair(daemonIds[0]), connect);
    const a = created.get(daemonIds[0])!;
    let resolveOld!: (snapshot: unknown) => void;
    a.snapshot = () => new Promise((resolve) => { resolveOld = resolve; });
    const stale = refreshSnapshot();
    await Promise.resolve();

    await establish(pair(daemonIds[1]), connect);
    resolveOld({ panes: [{ pane_id: "stale_a", workspace_id: "old", agent: "codex" }] });
    await stale;

    expect(computersStore.get().credential?.daemonId).toBe(daemonIds[1]);
    expect(dashboardStore.get().agents).toEqual([]);
  });
});