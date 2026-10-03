import { pickResumeCredential } from "./computer-catalog.ts";
import { validDaemonId, validDeviceId } from "./identifiers.ts";
import { b64url, b64urlDecode } from "./protocol/bytes.ts";
import type { PairResult } from "./protocol/client.ts";
import { fingerprint16 } from "./protocol/hello.ts";
import { recordConnectionDiagnostic } from "./protocol/connection-diagnostics";

export interface StoredCredential {
  daemon_id: string;
  device_id: string;
  device_psk: string;
  daemon_pk: string;
  relay_origin: string;
  fp: string;
  label: string;
  created_at: number;
  hostname?: string;
  last_seen?: number;
}

const DB_NAME = "pairfob";
const DB_VERSION = 2;
const STORE = "credentials";
const SETTINGS = "settings";
const LAST_USED_KEY = "last_used_daemon_id";
export const CREDENTIAL_READ_TIMEOUT_MS = 4000;
/**
 * How many credential records this browser last saw, kept beside IndexedDB.
 * A suspended Android browser can answer a read with an empty store; the
 * count tells that apart from a browser that never paired. Only a number.
 */
export const SAVED_COUNT_KEY = "pairfob.saved-computers.v1";

function storageTimeout(): Error {
  const error = new Error("Credential storage did not respond");
  error.name = "TimeoutError";
  return error;
}

function storageEmpty(): Error {
  const error = new Error("Credential storage returned no saved computers");
  error.name = "EmptyCatalogError";
  return error;
}

export function savedComputerCount(): number {
  try {
    const value = Number(localStorage.getItem(SAVED_COUNT_KEY));
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function rememberSavedCount(count: number): void {
  try {
    if (count > 0) localStorage.setItem(SAVED_COUNT_KEY, String(count));
    else localStorage.removeItem(SAVED_COUNT_KEY);
  } catch {
    // A stale positive count would hold boot on a store that is really empty.
    try { localStorage.removeItem(SAVED_COUNT_KEY); } catch { /* storage unavailable */ }
  }
}

/** The reader chose to pair again although saved computers were expected. */
export function forgetSavedComputerCount(): void {
  rememberSavedCount(0);
}

function storageFailureCode(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError") return "storage_timeout";
  if (name === "EmptyCatalogError") return "storage_empty";
  if (name === "SecurityError") return "storage_security";
  if (name === "UnknownError") return "storage_unknown";
  return "storage_error";
}

export type CredentialCatalog = {
  credentials: PairResult[];
  lastUsedDaemonId: string | null;
};

function optionalHostname(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const hostname = value.trim();
  if (!hostname || hostname.length > 255 || /[\u0000-\u001f\u007f]/.test(hostname)) return undefined;
  return hostname;
}

function optionalTimestamp(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
}

function exactB64(value: unknown, bytes: number): Uint8Array | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = b64urlDecode(value);
    return decoded.length === bytes && b64url(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

export function validateStoredCredential(value: unknown): StoredCredential | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<StoredCredential>;
  const daemonId = item.daemon_id;
  const deviceId = item.device_id;
  if (
    !validDaemonId(daemonId) ||
    !validDeviceId(deviceId) ||
    typeof item.relay_origin !== "string" ||
    typeof item.fp !== "string" ||
    typeof item.label !== "string" ||
    typeof item.created_at !== "number" || !Number.isSafeInteger(item.created_at)
  ) return null;
  let origin: string;
  try {
    origin = new URL(item.relay_origin).origin;
  } catch {
    return null;
  }
  if (origin !== item.relay_origin) return null;
  const psk = exactB64(item.device_psk, 32);
  const daemonPk = exactB64(item.daemon_pk, 32);
  if (!psk || !daemonPk || fingerprint16(daemonPk) !== item.fp) return null;
  const hostname = optionalHostname(item.hostname);
  const lastSeen = optionalTimestamp(item.last_seen);
  const stored: StoredCredential = {
    daemon_id: daemonId,
    device_id: deviceId,
    device_psk: b64url(psk),
    daemon_pk: b64url(daemonPk),
    relay_origin: origin,
    fp: item.fp,
    label: item.label,
    created_at: item.created_at,
  };
  if (hostname) stored.hostname = hostname;
  if (lastSeen) stored.last_seen = lastSeen;
  return stored;
}

/** Upgrade the prototype's typed-array record without weakening key checks. */
export function migrateLegacyCredential(value: unknown, origin: string): StoredCredential | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const psk = ArrayBuffer.isView(item.device_psk) ? new Uint8Array(item.device_psk.buffer, item.device_psk.byteOffset, item.device_psk.byteLength) : null;
  const daemonPk = ArrayBuffer.isView(item.daemon_pk) ? new Uint8Array(item.daemon_pk.buffer, item.daemon_pk.byteOffset, item.daemon_pk.byteLength) : null;
  if (
    !validDaemonId(item.daemon_id) ||
    !validDeviceId(item.device_id) ||
    !psk || psk.length !== 32 || !daemonPk || daemonPk.length !== 32
  ) return null;
  const stored: StoredCredential = {
    daemon_id: item.daemon_id,
    device_id: item.device_id,
    device_psk: b64url(psk),
    daemon_pk: b64url(daemonPk),
    relay_origin: origin,
    fp: fingerprint16(daemonPk),
    label: "Existing browser",
    created_at: Math.floor(Date.now() / 1000),
  };
  return validateStoredCredential(stored);
}

export function encodeCredential(pair: PairResult): StoredCredential {
  const stored: StoredCredential = {
    daemon_id: pair.daemonId,
    device_id: pair.deviceId,
    device_psk: b64url(pair.psk),
    daemon_pk: b64url(pair.daemonPk),
    relay_origin: pair.relayOrigin,
    fp: pair.fp,
    label: pair.label,
    created_at: pair.createdAt,
  };
  const hostname = optionalHostname(pair.hostname);
  const lastSeen = optionalTimestamp(pair.lastSeen);
  if (hostname) stored.hostname = hostname;
  if (lastSeen) stored.last_seen = lastSeen;
  if (!validateStoredCredential(stored)) throw new Error("invalid credential");
  return stored;
}

export function decodeCredential(stored: StoredCredential): PairResult {
  const valid = validateStoredCredential(stored);
  if (!valid) throw new Error("invalid credential");
  const pair: PairResult = {
    daemonId: valid.daemon_id,
    deviceId: valid.device_id,
    psk: b64urlDecode(valid.device_psk),
    daemonPk: b64urlDecode(valid.daemon_pk),
    relayOrigin: valid.relay_origin,
    fp: valid.fp,
    label: valid.label,
    createdAt: valid.created_at,
  };
  if (valid.hostname) pair.hostname = valid.hostname;
  if (valid.last_seen) pair.lastSeen = valid.last_seen;
  return pair;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => fail(storageTimeout()), CREDENTIAL_READ_TIMEOUT_MS);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "daemon_id" });
      if (!db.objectStoreNames.contains(SETTINGS)) db.createObjectStore(SETTINGS);
    };
    request.onsuccess = () => {
      const db = request.result;
      // A timed-out/blocked open may still finish after a retry owns boot.
      if (settled) { db.close(); return; }
      settled = true;
      clearTimeout(timer);
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => fail(request.error || new Error("IndexedDB open failed"));
    request.onblocked = () => fail(new Error("IndexedDB upgrade blocked"));
  });
}

/** Bound reads as well as open: a suspended storage process may emit no event. */
function readStore<T>(db: IDBDatabase, name: string, read: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, "readonly");
    const request = read(tx.objectStore(name));
    const timer = setTimeout(() => {
      reject(storageTimeout());
      try { tx.abort(); } catch { /* already completed */ }
    }, CREDENTIAL_READ_TIMEOUT_MS);
    request.onsuccess = () => { clearTimeout(timer); resolve(request.result); };
    const fail = () => {
      clearTimeout(timer);
      reject(tx.error || (request.readyState === "done" ? request.error : null)
        || new Error("Credential storage read aborted"));
    };
    request.onerror = fail;
    tx.onerror = fail;
    tx.onabort = fail;
  });
}

export async function saveCredential(pair: PairResult): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      store.put(encodeCredential(pair));
      const count = store.count();
      tx.oncomplete = () => { rememberSavedCount(count.result); resolve(); };
      tx.onerror = () => reject(tx.error || new Error("credential write failed"));
      tx.onabort = () => reject(tx.error || new Error("credential write aborted"));
    });
  } finally {
    db.close();
  }
}

async function readSetting(key: string): Promise<unknown> {
  const db = await openDatabase();
  try {
    if (!db.objectStoreNames.contains(SETTINGS)) return undefined;
    return await readStore(db, SETTINGS, (store) => store.get(key));
  } finally {
    db.close();
  }
}

async function writeSetting(key: string, value: unknown): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      if (!db.objectStoreNames.contains(SETTINGS)) {
        resolve();
        return;
      }
      const tx = db.transaction(SETTINGS, "readwrite");
      tx.objectStore(SETTINGS).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("setting write failed"));
      tx.onabort = () => reject(tx.error || new Error("setting write aborted"));
    });
  } finally {
    db.close();
  }
}

export async function rememberLastUsed(daemonId: string): Promise<void> {
  if (!validDaemonId(daemonId)) return;
  await writeSetting(LAST_USED_KEY, daemonId);
}

async function readCredentials(origin: string): Promise<PairResult[]> {
  const db = await openDatabase();
  try {
    const values = await readStore<unknown[]>(db, STORE, (store) => store.getAll());
    let invalid = 0, otherOrigin = 0;
    const credentials = values
      .map((value) => {
        const stored = validateStoredCredential(value) || migrateLegacyCredential(value, origin);
        if (!stored) { invalid++; return null; }
        if (stored.relay_origin !== origin) { otherOrigin++; return null; }
        return decodeCredential(stored);
      })
      .filter((item): item is PairResult => item !== null);
    recordConnectionDiagnostic({ event: "catalog_read", stored_count: values.length,
      usable_count: credentials.length, invalid_count: invalid, other_origin_count: otherOrigin });
    // Only this browser's own save/delete lowers the count, so an empty answer
    // while computers are expected is a storage failure, not an empty catalog.
    if (!values.length && savedComputerCount() > 0) throw storageEmpty();
    if (values.length) rememberSavedCount(values.length);
    for (const pair of credentials) {
      const raw = values.find((value) => (value as { daemon_id?: string })?.daemon_id === pair.daemonId);
      if (raw && !validateStoredCredential(raw)) {
        queueMicrotask(() => void saveCredential(pair).catch(() => undefined));
      }
    }
    return credentials;
  } finally {
    db.close();
  }
}

export async function loadCatalog(origin: string): Promise<CredentialCatalog> {
  const credentials = await readCredentials(origin).catch((error: unknown) => {
    recordConnectionDiagnostic({ event: "catalog_failed", code: storageFailureCode(error) });
    throw error;
  });
  // This is only an ordering hint. Its failure must not hide validated keys.
  const lastUsed = await readSetting(LAST_USED_KEY).catch((error: unknown) => {
    recordConnectionDiagnostic({ event: "catalog_hint_failed", code: storageFailureCode(error) });
    return null;
  });
  return {
    credentials,
    lastUsedDaemonId: validDaemonId(lastUsed) ? lastUsed : null,
  };
}

export async function loadCredential(origin: string): Promise<PairResult | null> {
  const catalog = await loadCatalog(origin);
  return pickResumeCredential(catalog.credentials, catalog.lastUsedDaemonId);
}

export async function deleteCredential(daemonId: string): Promise<void> {
  let db: IDBDatabase | undefined;
  try {
    db = await openDatabase();
    const opened = db;
    await new Promise<void>((resolve, reject) => {
      const tx = opened.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      store.delete(daemonId);
      const count = store.count();
      tx.oncomplete = () => { rememberSavedCount(count.result); resolve(); };
      tx.onerror = () => reject(tx.error || new Error("credential delete failed"));
      tx.onabort = () => reject(tx.error || new Error("credential delete aborted"));
    });
    recordConnectionDiagnostic({ event: "credential_deleted" });
  } catch (error) {
    recordConnectionDiagnostic({ event: "credential_delete_failed", code: storageFailureCode(error) });
    throw error;
  } finally {
    db?.close();
  }
}
