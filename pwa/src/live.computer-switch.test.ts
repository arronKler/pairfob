import { Window } from "happy-dom";
import { afterEach, describe, expect, test } from "bun:test";
import type { LiveSession, PairResult, SessionEvent } from "./lib/protocol/client.ts";

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

const { state } = await import("./state.ts");
const { setRenderer } = await import("./paint.ts");
const { closeComputerSession, establish, refreshSnapshot } = await import("./live.ts");

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

afterEach(() => {
  for (const daemonId of daemonIds) closeComputerSession(daemonId);
  state.live = null;
  state.credential = null;
  state.phase = "pick";
  state.screen = "home";
  state.fullTerminal = false;
  setRenderer(() => undefined);
});

describe("switching among paired computers", () => {
  test("connects only on first activation and retains prior sessions", async () => {
    setRenderer(() => undefined);
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
    expect(state.live).toBe(b);

    await establish(pair(daemonIds[0]), connect);
    expect(connects).toBe(2);
    expect(state.live).toBe(a);
    expect(state.relayRttMs).toBe(42);
    expect(state.sessionTransport).toBe("p2p");
    expect(a.closed).toBe(0);
    expect(b.closed).toBe(0);
  });

  test("an inactive terminal failure removes only that session", async () => {
    setRenderer(() => undefined);
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
    expect(state.live).toBe(b);
    await establish(pair(daemonIds[0]), connect);
    expect(connects).toBe(3);
  });

  test("an old snapshot cannot overwrite the newly activated computer", async () => {
    setRenderer(() => undefined);
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

    expect(state.credential?.daemonId).toBe(daemonIds[1]);
    expect(state.agents).toEqual([]);
  });
});
