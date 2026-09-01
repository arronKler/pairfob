import type { NetworkMode } from "./lib/network-mode";
import type {
  FinishedP2PAttemptObservation,
  LiveSession,
  P2PAttemptObservation,
  PairResult,
  SessionEvent,
} from "./lib/protocol/client";
import type { ReconnectReason } from "./lib/protocol/session-types";

type SessionEntry = {
  deviceId: string;
  fingerprint: string;
  session: LiveSession;
  unsubscribe: (() => void) | null;
  activated: number;
  lastLatencyMs: number | null;
  transport: "relay" | "p2p";
  lastP2PAttempt: FinishedP2PAttemptObservation | null;
  attemptListener: P2PAttemptListener | null;
};

export type SessionConnector = (
  pair: PairResult,
  observeP2PAttempt: (observation: P2PAttemptObservation) => void,
) => Promise<LiveSession>;
export type SessionListener = (daemonId: string, session: LiveSession, event: SessionEvent) => void;
export type P2PAttemptListener = (
  daemonId: string,
  session: LiveSession,
  attempt: FinishedP2PAttemptObservation,
) => void;

export type ActivatedSession = {
  session: LiveSession;
  reused: boolean;
  lastLatencyMs: number | null;
  transport: "relay" | "p2p";
  lastP2PAttempt: FinishedP2PAttemptObservation | null;
};

/** Page-local, lazily populated sessions. A full page load creates a fresh pool. */
export class ComputerSessions {
  private readonly entries = new Map<string, SessionEntry>();
  private activation = 0;

  constructor(private readonly maxEntries = 3) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new RangeError("maxEntries must be positive");
  }

  async activate(pair: PairResult, connect: SessionConnector): Promise<ActivatedSession> {
    const existing = this.entries.get(pair.daemonId);
    if (existing && existing.deviceId === pair.deviceId && existing.fingerprint === pair.fp) {
      existing.activated = ++this.activation;
      return {
        session: existing.session,
        reused: true,
        lastLatencyMs: existing.lastLatencyMs,
        transport: existing.transport,
        lastP2PAttempt: existing.lastP2PAttempt,
      };
    }
    if (existing) this.remove(pair.daemonId, existing.session);

    let connected: LiveSession | null = null;
    let pendingAttempt: FinishedP2PAttemptObservation | null = null;
    const session = await connect(pair, (observation) => {
      const { result, extra } = observation;
      if (result === "cancelled") return;
      const attempt: FinishedP2PAttemptObservation = { result, extra };
      pendingAttempt = attempt;
      if (!connected) return;
      const current = this.entries.get(pair.daemonId);
      if (!current || current.session !== connected || current.deviceId !== pair.deviceId || current.fingerprint !== pair.fp) {
        return;
      }
      current.lastP2PAttempt = attempt;
      current.attemptListener?.(pair.daemonId, connected, attempt);
    });
    connected = session;
    const entry: SessionEntry = {
      deviceId: pair.deviceId,
      fingerprint: pair.fp,
      session,
      unsubscribe: null,
      activated: ++this.activation,
      lastLatencyMs: null,
      transport: "relay",
      lastP2PAttempt: pendingAttempt,
      attemptListener: null,
    };
    this.entries.set(pair.daemonId, entry);
    this.evictOverflow(pair.daemonId);
    return { session, reused: false, lastLatencyMs: null, transport: "relay", lastP2PAttempt: pendingAttempt };
  }

  bind(
    daemonId: string,
    session: LiveSession,
    listen: SessionListener,
    listenP2PAttempt?: P2PAttemptListener,
  ): boolean {
    const entry = this.entries.get(daemonId);
    if (!entry || entry.session !== session || entry.unsubscribe) return false;
    const unsubscribe = session.onEvent((event) => {
      if (event.type === "latency" && typeof event.rttMs === "number") {
        entry.lastLatencyMs = Math.max(0, Math.round(event.rttMs));
        entry.transport = event.transport ?? entry.transport;
      } else if (event.type === "disconnected" || event.type === "reconnecting") {
        entry.lastLatencyMs = null;
        entry.transport = "relay";
      }
      listen(daemonId, session, event);
    });
    if (this.entries.get(daemonId) !== entry) {
      unsubscribe();
      return false;
    }
    entry.unsubscribe = unsubscribe;
    entry.attemptListener = listenP2PAttempt ?? null;
    return true;
  }

  get(daemonId: string): LiveSession | null {
    return this.entries.get(daemonId)?.session ?? null;
  }

  has(daemonId: string, session: LiveSession): boolean {
    return this.entries.get(daemonId)?.session === session;
  }

  remove(daemonId: string, expected?: LiveSession): boolean {
    const entry = this.entries.get(daemonId);
    if (!entry || (expected && entry.session !== expected)) return false;
    this.entries.delete(daemonId);
    try {
      entry.unsubscribe?.();
    } finally {
      entry.session.close();
    }
    return true;
  }

  setNetworkAvailable(available: boolean): void {
    for (const entry of this.entries.values()) entry.session.setNetworkAvailable(available);
  }

  reconnectNow(reason: ReconnectReason = "probe"): void {
    for (const entry of this.entries.values()) entry.session.reconnectNow(reason);
  }

  syncTransportMode(mode: NetworkMode, except?: LiveSession): void {
    for (const entry of this.entries.values()) {
      if (entry.session === except) continue;
      void entry.session.switchTransport(mode).catch(() => undefined);
    }
  }

  private evictOverflow(protectedDaemonId: string): void {
    while (this.entries.size > this.maxEntries) {
      let oldest: [string, SessionEntry] | null = null;
      for (const candidate of this.entries) {
        if (candidate[0] === protectedDaemonId) continue;
        if (!oldest || candidate[1].activated < oldest[1].activated) oldest = candidate;
      }
      if (!oldest) return;
      this.remove(oldest[0], oldest[1].session);
    }
  }
}
