import { t } from "../../lib/i18n";
import { nativeNotify, type NativeNotificationPermission, type NativeNotificationStatus } from "../../lib/native-notify";

/**
 * This phone's local notifications: the persisted on/off choice and the native
 * status that decides whether the OS will actually show one. Web Push keeps its
 * own storage in the browser's subscription; this module serves the native
 * shell only, where the page asks MainActivity instead.
 */

const KEY = "pairfob:localPush";

type LocalPushRecord = { enabled: boolean; keepAlive: boolean };

const OFF: LocalPushRecord = { enabled: false, keepAlive: false };
const listeners = new Set<() => void>();
let memory: LocalPushRecord | null = null;
let revision = 0;
// What the bridge last said about its ongoing notification. Absent a bridge it
// stays false, so a hidden page never opens the background lane on a guess.
let keepAlive = false;

function parse(raw: string | null): LocalPushRecord | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<LocalPushRecord> | null;
    if (!value || typeof value !== "object") return null;
    return { enabled: value.enabled === true, keepAlive: value.keepAlive === true };
  } catch {
    return null;
  }
}

function stored(): LocalPushRecord | null {
  try { return parse(localStorage.getItem(KEY)) ?? memory; }
  catch { return memory; }
}

function write(record: LocalPushRecord): void {
  memory = record;
  try {
    localStorage.setItem(KEY, JSON.stringify(record));
    memory = null;
  } catch { /* in-memory fallback */ }
  revision++;
  for (const listener of listeners) listener();
}

export function localNotificationsEnabled(): boolean {
  return (stored() ?? OFF).enabled;
}

export function localPushRevision(): number {
  return revision;
}

export function subscribeLocalPush(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function keepAliveEnabled(): boolean {
  return keepAlive;
}

/** Read the native status and cache its keep-alive fact; null when there is no bridge. */
export async function refreshLocalPush(): Promise<NativeNotificationStatus | null> {
  const bridge = nativeNotify();
  if (!bridge) return null;
  const status = await bridge.status();
  keepAlive = status.keepAlive;
  return status;
}

export async function enableLocalNotifications(): Promise<void> {
  const bridge = nativeNotify();
  if (!bridge) return;
  let permission: NativeNotificationPermission;
  try {
    permission = await bridge.requestPermission();
  } catch {
    // The prompt itself can be unavailable; that is not a denial and reads
    // better than the bridge's own request failure.
    throw new Error(t("notify.enableFailed"));
  }
  if (permission !== "granted") throw new Error(t("err.pushPermission"));
  // A frozen page raises nothing, so the keep-alive has to be real before the
  // choice is stored; following the click alone would promise notices the OS
  // never lets the page run to send.
  if (!await bridge.setKeepAlive(true).catch(() => false)) throw new Error(t("notify.enableFailed"));
  keepAlive = true;
  write({ enabled: true, keepAlive: true });
}

export async function disableLocalNotifications(): Promise<void> {
  const bridge = nativeNotify();
  write({ enabled: false, keepAlive: false });
  keepAlive = false;
  // Both native steps are independent and idempotent; a failed one must not
  // leave the other running after the page already says off.
  if (bridge) await Promise.allSettled([bridge.cancelAll(), bridge.setKeepAlive(false)]);
}
