import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { LiveSession, PairResult, SessionEvent } from "../../lib/protocol/client";
import { attachLiveSession, credential, liveSession, setCredential } from "../computers/catalog-store";
import { connectionStore, setPhase, phase } from "./connection-store";
import { setScreen } from "../../app/navigation-store";
import { resetGenerationsForTests } from "./generations";

const happy = new Window({ url: "https://pairfob.com/", width: 390, height: 844 });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Node",
  "DocumentFragment",
  "localStorage",
  "sessionStorage",
] as const) {
  g[key] = (happy as unknown as Record<string, unknown>)[key];
}
g.location = happy.location;
g.FormData = happy.FormData;
g.getComputedStyle = happy.getComputedStyle.bind(happy);
g.matchMedia = happy.matchMedia.bind(happy);
g.requestAnimationFrame = happy.requestAnimationFrame.bind(happy);
happy.document.body.innerHTML = '<main id="app"></main>';

const { capabilityEnabled } = await import("../operations/capabilities-store");
const { domainStores } = await import("../../app/domain-publication");
// The controller graph reaches ui modules and the root state bridge, which
// touch `#app` at module evaluation. Import it only after this file's own DOM
// is installed above, never via a static import that would evaluate before the
// DOM boundary or depend on another test file installing the realm first.
const { closeComputerSession, establish } = await import("./controller");

type FakeSession = LiveSession & { closed: number; configs: number; emit: (event: SessionEvent) => void };

function pair(daemonId: string, deviceId = `phone_${daemonId}`): PairResult {
  return {
    daemonId,
    deviceId,
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
    close: () => {
      session.closed += 1;
    },
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
    configs: 0,
    getConfig: async () => {
      session.configs += 1;
      return {};
    },
    snapshot: async () => ({ panes: [] }),
  } as unknown as FakeSession;
  return session;
}

const daemonIds = ["lifecycle_a", "lifecycle_b", "lifecycle_c"];

afterEach(() => {
  for (const daemonId of daemonIds) closeComputerSession(daemonId);
  attachLiveSession(null);
  setCredential(null);
  setPhase("pick");
  setScreen("home");
  resetGenerationsForTests();
});

describe("connection lifecycle", () => {
  test("establish publishes destination identity without a live handle wearing old capabilities", async () => {
    const mixed: string[] = [];
    const stop = domainStores.map((store) =>
      store.subscribe(() => {
        if (liveSession() && capabilityEnabled("create_tab")) mixed.push(`${store.name}:granted`);
      }),
    );
    const created = new Map<string, FakeSession>();
    const connect = async (credential: PairResult) => {
      const session = fakeSession();
      created.set(credential.daemonId, session);
      return session;
    };
    await establish(pair(daemonIds[0]), connect);
    expect(liveSession()).toBe(created.get(daemonIds[0]));
    expect(phase()).toBe("live");
    expect(credential()?.daemonId).toBe(daemonIds[0]);
    expect(capabilityEnabled("create_tab")).toBe(false);
    expect(mixed).toEqual([]);
    for (const release of stop) release();
  });

  test("a slower first establish cannot attach after a newer one has won", async () => {
    let releaseFirst!: (session: LiveSession) => void;
    let started = false;
    const firstConnect = (_credential: PairResult) => {
      started = true;
      return new Promise<LiveSession>((resolve) => {
        releaseFirst = resolve;
      });
    };
    const second = fakeSession();
    const first = fakeSession();
    const firstDone = establish(pair(daemonIds[0]), firstConnect);
    for (let i = 0; i < 30 && !started; i += 1) await Promise.resolve();
    expect(started).toBe(true);
    // B completes fully while A's connector is still pending: no global
    // activation queue may hold B behind A.
    await establish(pair(daemonIds[1]), async () => second);
    releaseFirst(first);
    await firstDone;
    expect(credential()?.daemonId).toBe(daemonIds[1]);
    expect(liveSession()).toBe(second);
    expect(first.closed).toBe(0);
  });

  test("a subscriber that starts a third establish during B adoption wins the live handle", async () => {
    const created = new Map<string, FakeSession>();
    let holdC!: (session: LiveSession) => void;
    let startedC = false;
    const connect = async (credential: PairResult) => {
      const session = fakeSession();
      created.set(credential.daemonId, session);
      if (credential.daemonId === daemonIds[2]) {
        startedC = true;
        return new Promise<LiveSession>((resolve) => {
          holdC = resolve;
        });
      }
      return session;
    };
    const { computersStore } = await import("../computers/catalog-store");
    let cDone: Promise<void> | undefined;
    const stop = computersStore.subscribe(() => {
      if (liveSession() === created.get(daemonIds[1]) && !startedC) {
        cDone = establish(pair(daemonIds[2]), connect);
      }
    });
    await establish(pair(daemonIds[0]), connect);
    const a = created.get(daemonIds[0])!;
    const bDone = establish(pair(daemonIds[1]), connect);
    for (let i = 0; i < 40 && !startedC; i += 1) await Promise.resolve();
    await bDone;
    const b = created.get(daemonIds[1])!;
    expect(startedC).toBe(true);
    const c = fakeSession();
    holdC(c);
    await cDone;
    expect(credential()?.daemonId).toBe(daemonIds[2]);
    expect(liveSession()).toBe(c);
    expect(b.configs).toBe(0);
    expect(a.closed).toBe(0);
    expect(b.closed).toBe(0);
    expect(c.closed).toBe(0);
    stop();
  });

  test("expected-session remove of an old handle does not close the replacement", async () => {
    const { ComputerSessions } = await import("../computers/session-pool");
    const pool = new ComputerSessions();
    const first = fakeSession();
    const replacement = fakeSession();
    const sessions = [first, replacement];
    let index = 0;
    await pool.activate(pair(daemonIds[0]), async () => sessions[index++]!);
    await pool.activate(pair(daemonIds[0], `phone_${daemonIds[0]}_b`), async () => sessions[index++]!);
    expect(first.closed).toBe(1);
    expect(pool.remove(daemonIds[0], first)).toBe(false);
    expect(replacement.closed).toBe(0);
    expect(pool.get(daemonIds[0])).toBe(replacement);
  });

  test("a superseded activation keeps its retained entry bound for later reuse", async () => {
    let releaseFirst!: (session: LiveSession) => void;
    let started = false;
    const firstConnect = () => {
      started = true;
      return new Promise<LiveSession>((resolve) => {
        releaseFirst = resolve;
      });
    };
    const first = fakeSession();
    const firstDone = establish(pair(daemonIds[0]), firstConnect);
    for (let i = 0; i < 30 && !started; i += 1) await Promise.resolve();
    await establish(pair(daemonIds[1]), async () => fakeSession());
    releaseFirst(first);
    await firstDone;
    expect(first.closed).toBe(0);
    // The retained superseded entry must have a live listener lifetime: a
    // later establish reuses it and events reach the lifecycle callback.
    await establish(pair(daemonIds[0]), async () => first);
    expect(liveSession()).toBe(first);
    first.emit({ type: "latency", rttMs: 42, transport: "relay" });
    expect(connectionStore.get().relayRttMs).toBe(42);
  });

  test("a caller mutating the pair while persistence awaits cannot retarget the establish", async () => {
    const created = new Map<string, FakeSession>();
    const connect = async (credential: PairResult) => {
      const session = fakeSession();
      created.set(credential.daemonId, session);
      return session;
    };
    const input = pair(daemonIds[0]);
    const done = establish(input, connect);
    input.daemonId = "poison";
    await done;
    expect(credential()?.daemonId).toBe(daemonIds[0]);
    expect(liveSession()).toBe(created.get(daemonIds[0]));
    expect(created.has("poison")).toBe(false);
  });
});
