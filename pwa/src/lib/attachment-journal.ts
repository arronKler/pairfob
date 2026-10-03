/**
 * Native IndexedDB persistence for attachment journal records.
 *
 * One database (`pairfob-attachments-v1`, version 1), one object store
 * (`records`) with OUT-OF-LINE tuple keys [daemonId, paneId, localId]. This
 * module is deliberately small and native: no promise-based IDB wrapper
 * framework, no in-memory fallback. Every mutation is one IndexedDB
 * transaction driven by request callbacks (nothing is awaited between IDB
 * requests, which would let the transaction auto-close), and operations are
 * serialized through a module queue so capacity accounting cannot race.
 *
 * Put semantics (single readwrite transaction, all atomic):
 *   1. encode the incoming record with the codec (invalid input rejects and
 *      never opens a transaction);
 *   2. reject a future updatedAt (> 5 min ahead) or an already-expired record
 *      (TTL 24 h);
 *   3. cursor every stored row; decode each with the codec and verify the
 *      actual primary key equals the value's own key tuple (a foreign or
 *      corrupt key cannot cross scopes); expired / future-skewed / corrupt
 *      rows are deleted inside the same transaction;
 *   4. sum surviving OTHER rows (the same-key replacement excluded) and add
 *      the incoming row's slot and bytes UNCONDITIONALLY via the pure
 *      journalCapacityAfterPut helper, so a larger replacement can never
 *      bypass the 50 record / 100 MiB caps; on overflow the transaction is
 *      aborted (the prune deletes roll back too) and the put rejects. Valid
 *      rows are never evicted to make room.
 *
 * Listing one pane also prunes expired/corrupt rows in that pane (readwrite).
 * All transactions are awaited to completion and bounded by a 5 s timeout
 * (which aborts the transaction); the connection is closed after every
 * operation. blocked (version open), unavailable (no IDB / security block),
 * quota, generic error and timeout are reported as distinct plain Errors.
 */
import {
  attachmentRecordBytes,
  decodeAttachmentRecord,
  encodeAttachmentRecord,
  validateJournalId,
} from "./attachment-journal-codec.ts";
import type {
  AttachmentJournalRecord,
  StoredAttachmentRecord,
} from "./attachment-journal-codec.ts";

export type { AttachmentJournalRecord, StoredAttachmentRecord };

const DB_NAME = "pairfob-attachments-v1";
const DB_VERSION = 1;
const STORE_NAME = "records";

/** Records older than this at read time are stale and get pruned. */
export const ATTACHMENT_JOURNAL_TTL_MS = 24 * 60 * 60 * 1000;
/** Tolerance for clock skew: timestamps further ahead are rejected/corrupt. */
export const ATTACHMENT_JOURNAL_MAX_FUTURE_MS = 5 * 60 * 1000;
export const ATTACHMENT_JOURNAL_MAX_RECORDS = 50;
export const ATTACHMENT_JOURNAL_MAX_BYTES = 100 * 1024 * 1024;
/** Bounded wait for both database open and any one transaction. */
const OPERATION_TIMEOUT_MS = 5000;

type JournalKey = [daemonId: string, paneId: string, localId: string];

/** Copy a possibly-readonly codec key into a mutable IDB-valid tuple. */
function toIdbKey(key: readonly string[]): JournalKey {
  return [key[0], key[1], key[2]];
}

function journalError(kind: string, detail: string, cause?: unknown): Error {
  const error = new Error(`attachment journal ${kind}: ${detail}`);
  if (cause !== undefined) (error as { cause?: unknown }).cause = cause;
  return error;
}

function describeError(error: unknown, detail: string): Error {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "QuotaExceededError") {
    return journalError(
      "quota",
      "browser storage quota exceeded while persisting attachments; existing records were kept",
      error,
    );
  }
  if (name === "SecurityError" || name === "InvalidStateError" || name === "InvalidAccessError") {
    return journalError("unavailable", `storage blocked by browser policy (${name})`, error);
  }
  if (name === "AbortError") return journalError("aborted", detail, error);
  if (name) return journalError("error", `${detail} (${name})`, error);
  return journalError("error", detail, error);
}

function idbFactory(): IDBFactory | null {
  try {
    if (typeof indexedDB !== "undefined" && indexedDB) return indexedDB;
  } catch {
    // Accessing the global can throw under restrictive browser policies.
  }
  return null;
}

/**
 * Open the one database, creating the keyless store on upgrade. A blocked
 * upgrade or security refusal rejects distinctly; if the open succeeds after
 * a timeout already fired, the late connection is closed and dropped.
 */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const factory = idbFactory();
    if (!factory) {
      reject(journalError("unavailable", "IndexedDB is not available in this context"));
      return;
    }
    if (typeof IDBKeyRange === "undefined") {
      reject(journalError("unavailable", "IndexedDB key ranges are not available"));
      return;
    }
    let settled = false;
    let request: IDBOpenDBRequest;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(journalError("timeout", `database open exceeded ${OPERATION_TIMEOUT_MS}ms`));
    }, OPERATION_TIMEOUT_MS);

    try {
      request = factory.open(DB_NAME, DB_VERSION);
    } catch (cause) {
      clearTimeout(timer);
      reject(describeError(cause, "database open threw"));
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        // Out-of-line keys: callers supply the [daemonId, paneId, localId]
        // tuple explicitly; no keyPath is derived from the value.
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => {
      if (settled) {
        // Late success (e.g. after an open timeout): never leak the handle.
        try { request.result.close(); } catch { /* already gone */ }
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(request.result);
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(journalError("blocked", "another tab holds an older attachment database open; close it and retry"));
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(describeError(request.error, "database open failed"));
    };
  });
}

type TxControl<T> = {
  finish: (value: T) => void;
  fail: (error: Error) => void;
};

function commitTransaction(tx: IDBTransaction): void {
  // commit() is the explicit flush on modern browsers; older ones auto-commit.
  const maybeCommit = (tx as IDBTransaction & { commit?: () => void }).commit;
  if (typeof maybeCommit === "function") maybeCommit.call(tx);
}

/**
 * Run one native transaction. `execute` runs synchronously and registers IDB
 * request callbacks; it must NOT await. It calls finish() once its last
 * request succeeds; resolution waits for the transaction's complete event so
 * abort (including timeout abort and quota) is always observed.
 */
function runTransaction<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  execute: (store: IDBObjectStore, control: TxControl<T>) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE_NAME, mode);
    } catch (cause) {
      reject(describeError(cause, "could not start transaction"));
      return;
    }
    let settled = false;
    let finished = false;
    let result: T;
    const control: TxControl<T> = {
      finish(value) {
        if (settled || finished) return;
        finished = true;
        result = value;
        try {
          commitTransaction(tx);
        } catch {
          /* Auto-commit still applies once the request queue drains. */
        }
      },
      fail(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          tx.abort(); // roll back every request issued in this transaction
        } catch {
          /* already complete/aborted */
        }
        reject(error);
      },
    };
    const timer = setTimeout(() => {
      control.fail(journalError("timeout", `${mode} transaction exceeded ${OPERATION_TIMEOUT_MS}ms`));
    }, OPERATION_TIMEOUT_MS);

    tx.addEventListener("complete", () => {
      if (settled) return;
      if (!finished) {
        control.fail(journalError("error", "transaction completed before its cursor finished"));
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    });
    tx.addEventListener("abort", () => {
      // Our own timeout/fail already rejected; otherwise surface the abort.
      if (settled) return;
      control.fail(describeError(tx.error, "transaction aborted"));
    });
    tx.addEventListener("error", (event) => {
      // Request errors bubble here by default and abort the transaction.
      // During this event tx.error may still be null; use the failed
      // request's error so QuotaExceededError is classified distinctly.
      const target = event.target as IDBRequest | null;
      control.fail(describeError(target?.error ?? tx.error, "transaction request failed"));
    });

    try {
      execute(tx.objectStore(STORE_NAME), control);
    } catch (cause) {
      control.fail(describeError(cause, "transaction work threw"));
    }
  });
}

/** Compare an IDB primary key (unknown) with the record's own key tuple. */
function sameKey(actual: unknown, expected: JournalKey): boolean {
  return Array.isArray(actual)
    && actual.length === 3
    && actual[0] === expected[0]
    && actual[1] === expected[1]
    && actual[2] === expected[2];
}

/** True when a decoded row is fresh per TTL and within clock skew. */
export function isJournalRecordFresh(updatedAt: number, now: number): boolean {
  return updatedAt - now <= ATTACHMENT_JOURNAL_MAX_FUTURE_MS
    && now - updatedAt <= ATTACHMENT_JOURNAL_TTL_MS;
}

export type JournalCapacityTotals = {
  readonly count: number;
  readonly bytes: number;
  readonly allowed: boolean;
};

/**
 * Pure capacity math for one put. `otherCount`/`otherBytes` count ONLY the
 * fresh rows that are NOT the incoming key — a kept same-key row is a
 * replacement and the caller excludes it from these totals. The incoming row
 * ALWAYS occupies one slot and its bytes ALWAYS count, even while replacing
 * an existing row: a bigger replacement must never slip past the byte cap by
 * being counted as zero.
 */
export function journalCapacityAfterPut(
  incomingBytes: number,
  otherCount: number,
  otherBytes: number,
): JournalCapacityTotals {
  const count = otherCount + 1;
  const bytes = otherBytes + incomingBytes;
  return {
    count,
    bytes,
    allowed: count <= ATTACHMENT_JOURNAL_MAX_RECORDS && bytes <= ATTACHMENT_JOURNAL_MAX_BYTES,
  };
}

/**
 * All keys [daemonId, paneId, localId] for one pane. The empty-array bound
 * sorts after every string localId (arrays order above strings in IDB), and
 * the short prefix sorts before its triples.
 */
function paneKeyRange(daemonId: string, paneId: string): IDBKeyRange {
  return IDBKeyRange.bound([daemonId, paneId], [daemonId, paneId, []]);
}

/** All keys [daemonId, paneId, localId] for one daemon and nothing outside it. */
function daemonKeyRange(daemonId: string): IDBKeyRange {
  return IDBKeyRange.bound([daemonId], [daemonId, []]);
}

async function withDatabase<T>(work: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await openDatabase();
  try {
    return await work(db);
  } finally {
    db.close();
  }
}

// Operations are serialized: capacity accounting and deletes must never
// interleave across callers. Each operation still commits through its own
// native IndexedDB transaction.
let queueTail: Promise<unknown> = Promise.resolve();
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const run = queueTail.then(operation, operation);
  queueTail = run.catch(() => { /* keep the chain alive for the next caller */ });
  return run;
}

/**
 * Persist one record, pruning expired/corrupt rows and enforcing the 50 row /
 * 100 MiB caps atomically. Rejects (and keeps every old record) when the
 * input is invalid, stale/future, or the caps would be exceeded.
 */
export function putAttachmentRecord(record: AttachmentJournalRecord): Promise<void> {
  return serialize(() => putNow(record));
}

function putNow(input: AttachmentJournalRecord): Promise<void> {
  const stored = encodeAttachmentRecord(input); // throws plain Error on invalid input
  const now = Date.now();
  if (stored.updatedAt - now > ATTACHMENT_JOURNAL_MAX_FUTURE_MS) {
    return Promise.reject(journalError("rejected", "updatedAt is more than 5 minutes in the future"));
  }
  if (now - stored.updatedAt > ATTACHMENT_JOURNAL_TTL_MS) {
    return Promise.reject(journalError("rejected", "record is already older than the 24 hour journal TTL"));
  }
  const incomingKey = toIdbKey(stored.key);
  const incomingBytes = attachmentRecordBytes(stored);

  return withDatabase((db) => runTransaction<void>(db, "readwrite", (store, control) => {
    let otherCount = 0;
    let otherBytes = 0;
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        // Enumeration (and prune deletes) done — gate BEFORE issuing the put.
        // The existing same-key row was excluded from otherCount/otherBytes;
        // the incoming row always re-counts as one row / its own full bytes.
        const totals = journalCapacityAfterPut(incomingBytes, otherCount, otherBytes);
        if (!totals.allowed) {
          // Abort rolls the prunes AND keeps every prior record: no quota/
          // capacity overshoot can ever leave the store half-mutated.
          control.fail(journalError(
            "capacity",
            `persisting this attachment would exceed the journal cap `
              + `(${totals.count}/${ATTACHMENT_JOURNAL_MAX_RECORDS} records, `
              + `${totals.bytes}/${ATTACHMENT_JOURNAL_MAX_BYTES} bytes); valid rows are never evicted`,
          ));
          return;
        }
        const putRequest = store.put(stored, incomingKey);
        putRequest.onsuccess = () => control.finish(undefined);
        return;
      }
      const decoded = decodeAttachmentRecord(cursor.value);
      const keyMatches = decoded !== null && sameKey(cursor.primaryKey, [
        decoded.daemonId,
        decoded.paneId,
        decoded.localId,
      ]);
      const isIncomingKey = sameKey(cursor.primaryKey, incomingKey);
      // Keep only fresh, codec-valid rows whose real IDB key matches the
      // value's own tuple. Anything else is pruned in this same transaction.
      if (decoded && keyMatches && isJournalRecordFresh(decoded.updatedAt, now)) {
        if (!isIncomingKey) {
          // The same-key row is a replacement and stays OUT of the other*
          // totals; journalCapacityAfterPut counts the incoming row itself.
          otherCount += 1;
          otherBytes += attachmentRecordBytes(cursor.value as StoredAttachmentRecord);
        }
      } else {
        cursor.delete();
      }
      cursor.continue();
    };
  }));
}

/**
 * List fresh, codec-valid records for exactly one (daemonId, paneId). Invalid
 * ids reject. This is also the TTL cleanup path: it runs readwrite and
 * DELETES every expired / future-skewed / codec-corrupt / foreign-key row
 * encountered inside the pane range, instead of merely hiding it until some
 * future put.
 */
export function listAttachmentRecords(
  daemonId: string,
  paneId: string,
): Promise<AttachmentJournalRecord[]> {
  return serialize(() => {
    validateJournalId(daemonId, "daemonId");
    validateJournalId(paneId, "paneId");
    return withDatabase((db) => runTransaction<AttachmentJournalRecord[]>(
      db,
      "readwrite",
      (store, control) => {
        const records: AttachmentJournalRecord[] = [];
        const now = Date.now();
        const request = store.openCursor(paneKeyRange(daemonId, paneId));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            records.sort((a, b) => a.updatedAt - b.updatedAt);
            control.finish(records);
            return;
          }
          const decoded = decodeAttachmentRecord(cursor.value);
          const keyMatches = decoded !== null && sameKey(cursor.primaryKey, [
            decoded.daemonId,
            decoded.paneId,
            decoded.localId,
          ]);
          if (decoded && keyMatches && isJournalRecordFresh(decoded.updatedAt, now)) {
            records.push(decoded);
          } else {
            // TTL/corruption cleanup: prune in THIS transaction.
            cursor.delete();
          }
          cursor.continue();
        };
      },
    ));
  });
}

/** Delete exactly [daemonId, paneId, localId]; no other row is touched. */
export function deleteAttachmentRecord(
  daemonId: string,
  paneId: string,
  localId: string,
): Promise<void> {
  return serialize(() => {
    validateJournalId(daemonId, "daemonId");
    validateJournalId(paneId, "paneId");
    validateJournalId(localId, "localId");
    const key: JournalKey = [daemonId, paneId, localId];
    return withDatabase((db) => runTransaction<void>(db, "readwrite", (store, control) => {
      const request = store.delete(key as IDBValidKey); // idempotent: deleting an absent key is fine
      request.onsuccess = () => control.finish(undefined);
    }));
  });
}

/**
 * Delete every pane's rows for one daemon, including named Herdr namespaces.
 * Default tuple keys and the v1 record format stay unchanged.
 * `clearDaemonAttachmentRecords` remains as a compatibility alias.
 */
export function clearAttachmentRecords(daemonId: string): Promise<void> {
  return serialize(() => {
    validateJournalId(daemonId, "daemonId");
    return withDatabase((db) => runTransaction<void>(db, "readwrite", (store, control) => {
      const prefix = `${daemonId}:herd:`;
      const ranges = [daemonKeyRange(daemonId), IDBKeyRange.bound([prefix], [`${prefix}\uffff`])];
      const clearNextRange = () => {
        const range = ranges.shift();
        if (!range) { control.finish(undefined); return; }
        const request = store.openCursor(range);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) { clearNextRange(); return; }
          cursor.delete();
          cursor.continue();
        };
      };
      clearNextRange();
    }));
  });
}

export const clearDaemonAttachmentRecords = clearAttachmentRecords;
