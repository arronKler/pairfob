import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import "../../../test-support/boot-dom";
import type { LiveSession, PairResult } from "../../lib/protocol/client";
import { attachLiveSession, liveSession, setCredential } from "../computers/catalog-store";
import { connectionStore, noteRelayRtt, sessionTransport, setSessionTransport } from "./connection-store";
import { setScreen } from "../../app/navigation-store";
import { resetObservationLifecycle, selectPane } from "../session/session-store";
import { batch } from "../../shared/model/domain-store";
import { ComputerSessions } from "../computers/session-pool";
import { observeSessionEvent, type SessionEventPorts } from "./session-events";

const pair: PairResult = { daemonId: "A", deviceId: "dev", fp: "f" } as unknown as PairResult;

let stops: Array<() => void> = [];
let calls: string[] = [];
let session: LiveSession;
let pool: ComputerSessions;

const eventPorts: SessionEventPorts = {
  documentVisible: () => true,
  commitView: () => calls.push("commitView"),
  clearNotice: () => calls.push("clear"),
  showStatus: () => calls.push("status"),
  startPolling: () => calls.push("start"),
  stopPolling: () => calls.push("stop"),
  refreshRuntime: async () => {
    calls.push("runtime");
  },
  refreshSnapshot: async () => {
    calls.push("snapshot");
  },
  wakePane: () => calls.push("pane"),
  preloadFullTerminal: () => calls.push("preload"),
  handleGuidedEvent: () => false,
  handleFullTerminalEvent: () => false,
  handleInactiveTerminal: async () => {
    calls.push("inactive");
  },
  handleActiveTerminal: async () => {
    calls.push("active");
  },
  sessionEventNotice: () => "",
};

beforeEach(async () => {
  stops = [];
  calls = [];
  resetObservationLifecycle();
  selectPane("");
  setScreen("home");
  session = {
    isConnected: () => true,
    onEvent: () => () => undefined,
    close() {},
  } as unknown as LiveSession;
  pool = new ComputerSessions(3);
  await pool.activate(pair, async () => session);
  attachLiveSession(session);
  batch(() => {
    setCredential(pair);
    noteRelayRtt(null);
    setSessionTransport("relay");
  });
});

afterEach(() => {
  for (const stop of stops) stop();
  attachLiveSession(null);
  resetObservationLifecycle();
});

describe("session event observation", () => {
  test("foreground checking and the first retry preserve P2P presentation without a warning", () => {
    session.isChecking = () => true;
    setSessionTransport("p2p");
    for (const type of ["checking", "disconnected", "reconnecting"] as const) {
      calls = [];
      observeSessionEvent(pool, "A", session, { type }, eventPorts);
      expect(calls).toEqual(["stop", "clear", "commitView"]);
      expect(sessionTransport()).toBe("p2p");
    }
    session.isChecking = () => false;
    calls = [];
    observeSessionEvent(pool, "A", session, { type: "connected" }, eventPorts);
    expect(calls).toEqual(["clear", "start", "commitView", "runtime"]);
  });

  test("a latency RTT publication switching sessions cannot write the old event's transport", () => {
    stops.push(connectionStore.subscribe(() => {
      if (connectionStore.get().relayRttMs === 8 && liveSession() === session) {
        attachLiveSession({ isConnected: () => true } as unknown as LiveSession);
        setSessionTransport("relay");
      }
    }));
    observeSessionEvent(pool, "A", session, { type: "latency", rttMs: 8, transport: "p2p" }, eventPorts);
    expect(connectionStore.get().sessionTransport).toBe("relay");
    expect(calls).toEqual([]);
  });

  test("a latency event without transport preserves the canonical pending transport", () => {
    // Baseline published projection is relay.
    setSessionTransport("relay");
    const relaySnapshot = connectionStore.get();
    // The canonical live transport advances to p2p through the named action;
    // the bridge staged this as a dirty-only write (live p2p, published
    // projection still relay until the next commit). Pin the published reader
    // to the relay projection until the event's own publication supersedes it,
    // which a subscription observes synchronously. Restored in finally.
    setSessionTransport("p2p");
    expect(sessionTransport()).toBe("p2p");
    const originalGet = connectionStore.get;
    let pinned = true;
    connectionStore.get = () => (pinned ? relaySnapshot : originalGet.call(connectionStore));
    const unsubscribe = connectionStore.subscribe(() => { pinned = false; });
    try {
      expect(connectionStore.get().sessionTransport).toBe("relay");

      observeSessionEvent(pool, "A", session, { type: "latency", rttMs: 8 }, eventPorts);

      // The event carried no transport, so the observer kept the canonical
      // live value (p2p) and its own publication flushed it to the projection;
      // a reader that answered from the stale snapshot would have reset to relay.
      expect(sessionTransport()).toBe("p2p");
      expect(connectionStore.get().sessionTransport).toBe("p2p");
      expect(calls).toEqual([]);
    } finally {
      unsubscribe();
      connectionStore.get = originalGet;
    }
  });

  test("an ordinary latency update rounds RTT, adopts transport and preloads once", () => {
    observeSessionEvent(pool, "A", session, { type: "latency", rttMs: 8.2, transport: "p2p" }, eventPorts);
    expect(connectionStore.get().relayRttMs).toBe(8);
    expect(connectionStore.get().sessionTransport).toBe("p2p");
    expect(calls).toEqual(["preload"]);
    calls = [];
    // Already on p2p: no second preload.
    observeSessionEvent(pool, "A", session, { type: "latency", rttMs: 9, transport: "p2p" }, eventPorts);
    expect(calls).toEqual([]);
  });

  test("poke routing and inactive-terminal ownership stay per-session", () => {
    observeSessionEvent(pool, "A", session, { type: "poke", reason: "herdr_online" }, eventPorts);
    expect(calls).toEqual(["runtime"]);
    calls = [];
    attachLiveSession(null);
    observeSessionEvent(pool, "A", session, { type: "terminal", code: "revoked" }, eventPorts);
    expect(calls).toEqual(["inactive"]);
  });

  test("a disconnect publication switching sessions stops only the retiring owner's effects", () => {
    stops.push(connectionStore.subscribe(() => {
      if (connectionStore.get().relayRttMs === null && liveSession() === session) {
        attachLiveSession({ isConnected: () => true } as unknown as LiveSession);
        setSessionTransport("relay");
      }
    }));
    observeSessionEvent(pool, "A", session, { type: "disconnected" }, eventPorts);
    expect(liveSession()).not.toBe(session);
    // The old owner's stop/status/paint must not run for the replacement.
    expect(calls).toEqual([]);
  });
});
