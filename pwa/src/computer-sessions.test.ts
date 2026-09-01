import { describe, expect, test } from "bun:test";
import { ComputerSessions } from "./computer-sessions.ts";
import type { LiveSession, PairResult, SessionEvent } from "./lib/protocol/client.ts";

type FakeSession = LiveSession & {
  closed: number;
  network: boolean[];
  reconnects: number;
  transports: string[];
  emit: (event: SessionEvent) => void;
};

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
    network: [],
    reconnects: 0,
    transports: [],
    close: () => { session.closed += 1; },
    setNetworkAvailable: (available: boolean) => { session.network.push(available); },
    reconnectNow: () => { session.reconnects += 1; },
    switchTransport: async (mode: string) => { session.transports.push(mode); },
    onEvent: (listener: (event: SessionEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (event: SessionEvent) => {
      for (const listener of listeners) listener(event);
    },
  } as unknown as FakeSession;
  return session;
}

describe("page-local computer sessions", () => {
  test("connects lazily and reuses a session after switching away", async () => {
    const pool = new ComputerSessions();
    const created: FakeSession[] = [];
    const connect = async () => {
      const session = fakeSession();
      created.push(session);
      return session;
    };
    const events: string[] = [];
    const listen = (daemonId: string, _session: LiveSession, event: SessionEvent) => events.push(`${daemonId}:${event.type}`);

    expect(created).toHaveLength(0);
    const a = await pool.activate(pair("a"), connect);
    pool.bind("a", a.session, listen);
    const b = await pool.activate(pair("b"), connect);
    pool.bind("b", b.session, listen);
    const again = await pool.activate(pair("a"), connect);

    expect(created).toHaveLength(2);
    expect(a.reused).toBe(false);
    expect(b.reused).toBe(false);
    expect(again.reused).toBe(true);
    expect(again.session).toBe(a.session);
    created[0].emit({ type: "poke" });
    expect(events).toEqual(["a:poke"]);
  });

  test("a new credential replaces the old session for the same computer", async () => {
    const pool = new ComputerSessions();
    const sessions = [fakeSession(), fakeSession()];
    let index = 0;
    const connect = async () => sessions[index++];
    const first = await pool.activate(pair("a", "phone_old"), connect);
    pool.bind("a", first.session, () => undefined);
    const replacement = await pool.activate(pair("a", "phone_new"), connect);
    pool.bind("a", replacement.session, () => undefined);

    expect(replacement.session).not.toBe(first.session);
    expect(sessions[0].closed).toBe(1);
    sessions[0].emit({ type: "terminal", code: "revoked" });
    expect(pool.get("a")).toBe(sessions[1]);
  });

  test("keeps three recently activated sessions and evicts the LRU", async () => {
    const pool = new ComputerSessions(3);
    const sessions = new Map<string, FakeSession>();
    const connect = async (credential: PairResult) => {
      const session = fakeSession();
      sessions.set(credential.daemonId, session);
      return session;
    };

    await pool.activate(pair("a"), connect);
    await pool.activate(pair("b"), connect);
    await pool.activate(pair("c"), connect);
    await pool.activate(pair("a"), connect);
    await pool.activate(pair("d"), connect);

    expect(sessions.get("b")?.closed).toBe(1);
    expect(pool.get("a")).toBe(sessions.get("a"));
    expect(pool.get("c")).toBe(sessions.get("c"));
    expect(pool.get("d")).toBe(sessions.get("d"));
  });

  test("broadcasts reachability and reconnect while transport changes skip the active session", async () => {
    const pool = new ComputerSessions();
    const a = fakeSession();
    const b = fakeSession();
    const sessions = [a, b];
    let index = 0;
    const connect = async () => sessions[index++];
    await pool.activate(pair("a"), connect);
    await pool.activate(pair("b"), connect);

    pool.setNetworkAvailable(false);
    pool.reconnectNow();
    pool.syncTransportMode("relay", b);
    await Promise.resolve();

    expect(a.network).toEqual([false]);
    expect(b.network).toEqual([false]);
    expect(a.reconnects).toBe(1);
    expect(b.reconnects).toBe(1);
    expect(a.transports).toEqual(["relay"]);
    expect(b.transports).toEqual([]);
  });
});
