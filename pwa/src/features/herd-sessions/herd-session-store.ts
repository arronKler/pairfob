import { createDomain, detach } from "../../shared/model/domain-store";
import type { HerdSessionSummary } from "../../lib/protocol/session-ws";

/**
 * Herd-sessions domain: which Herdr sessions the connected daemon can see, and
 * which one subsequent session-scoped RPCs target.
 *
 * Named "herd-sessions" (not "sessions") because `features/session/` already
 * owns an unrelated concept - the paired phone-daemon connection itself. A
 * Herdr session is a completely different thing: one of possibly several
 * independent, named terminal-multiplexer sessions the SAME connection can
 * address, gated behind the daemon's PAIRFOB_MULTI_SESSION opt-in.
 */
export type HerdSessionsRecord = {
  sessions: HerdSessionSummary[];
  /** null selects the default session, matching HerdSessionSummary["name"]. */
  current: string | null;
  /** False until a ListSessions call has actually succeeded once. */
  supported: boolean;
};

const herdSessionsDomain = createDomain<HerdSessionsRecord>("herd-sessions", {
  sessions: [],
  current: null,
  supported: false,
});
export const herdSessionsStore = herdSessionsDomain.store;
const { read, write } = herdSessionsDomain.controller;

export function herdSessions(): HerdSessionSummary[] {
  return read().sessions.map((session) => ({ name: session.name, running: session.running }));
}

export function currentHerdSession(): string | null {
  return read().current;
}

export function herdSessionsSupported(): boolean {
  return read().supported;
}

/** Adopt a fresh ListSessions result. The payload is detached, as with other domains. */
export function setHerdSessions(sessions: readonly HerdSessionSummary[]): void {
  write((record) => {
    record.sessions = detach(sessions.map((session): HerdSessionSummary => ({ name: session.name, running: session.running })));
    record.supported = true;
  });
}

/** ListSessions failed or the daemon does not support it: fail closed, hide the switcher. */
export function setHerdSessionsUnsupported(): void {
  write((record) => {
    record.sessions = [];
    record.supported = false;
  });
}

export function setCurrentHerdSession(name: string | null): void {
  write((record) => {
    record.current = name;
  });
}

/** A dropped connection invalidates what the daemon last reported. */
export function clearHerdSessions(): void {
  write((record) => {
    record.sessions = [];
    record.current = null;
    record.supported = false;
  });
}
