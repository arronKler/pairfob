import { pickResumeCredential } from "./computer-catalog.ts";
import { validDaemonId, validDeviceId } from "./identifiers.ts";
import { b64url, b64urlDecode } from "./protocol/bytes.ts";
import type { PairResult } from "./protocol/client.ts";
import { fingerprint16 } from "./protocol/hello.ts";

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
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "daemon_id" });
      if (!db.objectStoreNames.contains(SETTINGS)) db.createObjectStore(SETTINGS);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB upgrade blocked"));
  });
}

export async function saveCredential(pair: PairResult): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(encodeCredential(pair));
      tx.oncomplete = () => resolve();
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
    return await new Promise<unknown>((resolve, reject) => {
      if (!db.objectStoreNames.contains(SETTINGS)) {
        resolve(undefined);
        return;
      }
      const request = db.transaction(SETTINGS, "readonly").objectStore(SETTINGS).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("setting read failed"));
    });
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
    const values = await new Promise<unknown[]>((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("credential read failed"));
    });
    const credentials = values
      .map((value) => {
        const stored = validateStoredCredential(value) || migrateLegacyCredential(value, origin);
        return stored && stored.relay_origin === origin ? decodeCredential(stored) : null;
      })
      .filter((item): item is PairResult => item !== null);
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
  const credentials = await readCredentials(origin);
  const lastUsed = await readSetting(LAST_USED_KEY);
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
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(daemonId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("credential delete failed"));
      tx.onabort = () => reject(tx.error || new Error("credential delete aborted"));
    });
  } finally {
    db.close();
  }
}
