import type { LiveSession, PairResult } from "../../lib/protocol/client";
import { createDomain, detach, immutableCopy } from "../../shared/model/domain-store";

/**
 * Computers domain: the paired-computer catalog, the credential in use, and the
 * live session that credential opened. Pairing *input* lives in `pairing.ts`;
 * the daemon-side device list and settings live in `runtime.ts`.
 */
export type ComputersRecord = {
  computers: PairResult[];
  credential: PairResult | null;
  lastUsedDaemonId: string | null;
  addingComputer: boolean;
  live: LiveSession | null;
};

/**
 * `live` is a declared opaque handle: a session is a live resource whose identity
 * callers compare (`state.live === owner.session`), and production or fixture
 * sessions may be plain objects, so the snapshot shares it by identity instead of
 * copying and freezing it. A credential is owned data and is detached instead.
 */
const computersDomain = createDomain<ComputersRecord, "live">("computers", {
  computers: [],
  credential: null,
  lastUsedDaemonId: null,
  addingComputer: false,
  live: null,
}, { opaque: ["live"] });
export const computersStore = computersDomain.store;
const { read, write } = computersDomain.controller;


/**
 * Foreign key-handle fields of a pair, shared by identity and never copied or
 * frozen — the same contract the published snapshot applies to `live`. The
 * plain identity metadata around them (daemonId, deviceId, label, …) is what
 * the canonical readers detach and freeze.
 */
const PAIR_KEY_HANDLES = ["psk", "daemonPk"] as const;

/** Adopt the catalog. The caller keeps no writable path into domain data. */
export function setComputers(computers: readonly PairResult[]): void {
  write((record) => {
    record.computers = detach([...computers]);
  });
}

export function setAddingComputer(adding: boolean): void {
  if (read().addingComputer === adding) return;
  write((record) => {
    record.addingComputer = adding;
  });
}

/**
 * Canonical paired-computer catalog, as an owned detached view.
 *
 * Each call re-reads the live canonical record and detach-freezes a copy, so a
 * caller can never write through a returned entry into the canonical catalog —
 * not on a plain read, and not inside a staged batch where `store.get()` is
 * still the stale published snapshot. Key material stays a shared foreign
 * handle (identity, never cloned or frozen). The boot decision reads this live.
 */
export function computers(): readonly PairResult[] {
  return read().computers.map((pair) => immutableCopy(pair, PAIR_KEY_HANDLES));
}

/**
 * The credential currently in use, or null before pairing/resume.
 *
 * Like `computers()`, this returns detached frozen plain metadata re-read at
 * action time with its key-handle fields shared by identity — never a writable
 * alias of the canonical credential and never a stale published copy.
 */
export function credential(): PairResult | null {
  const pair = read().credential;
  return pair ? immutableCopy(pair, PAIR_KEY_HANDLES) : null;
}

/** The daemon the last successful resume picked; a hint, never authority. */
export function lastUsedDaemon(): string | null {
  return read().lastUsedDaemonId;
}

/**
 * Adopt the credential a pairing or resume produced, remembering it as last used.
 * The record is detached — its key material is a foreign handle and stays shared —
 * so whoever produced it cannot edit the connected identity afterwards.
 */
export function setCredential(credential: PairResult | null): void {
  write((record) => {
    record.credential = credential ? detach(credential) : null;
    record.lastUsedDaemonId = credential?.daemonId ?? record.lastUsedDaemonId;
  });
}

export function setLastUsedDaemon(daemonId: string | null): void {
  if (read().lastUsedDaemonId === daemonId) return;
  write((record) => {
    record.lastUsedDaemonId = daemonId;
  });
}

/** The established session that owns reads, writes and events. */
export function attachLiveSession(session: LiveSession | null): void {
  if (read().live === session) return;
  write((record) => {
    record.live = session;
  });
}

/** The established session handle. Opaque by contract: identity, never a copy. */
export function liveSession(): LiveSession | null {
  return read().live;
}

export function daemonId(): string {
  return read().credential?.daemonId || "anon";
}

/** The connected computer, or null before pairing/resume. Scope reads use this. */
export function currentDaemonId(): string | null {
  return read().credential?.daemonId ?? null;
}

export function currentDeviceId(): string | null {
  return read().credential?.deviceId ?? null;
}

export function addingComputer(): boolean {
  return read().addingComputer;
}
