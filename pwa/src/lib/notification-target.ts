import { validDaemonId } from "./identifiers.ts";

export type NotificationTarget = { daemonId: string; paneId: string };
export type NotificationTargetResolution =
  | { kind: "wait" }
  | { kind: "missing" }
  | { kind: "open"; paneId: string };

const PANE_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/;

/** Parse a notification deep link that remains in the URL fragment and never reaches the origin. */
export function parseNotificationTarget(hash: string): NotificationTarget | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const keys = [...params.keys()];
  if (keys.length !== 3 || new Set(keys).size !== 3 || keys.some((key) => !["notify", "d", "pane"].includes(key))) return null;
  const daemonId = params.get("d");
  const paneId = params.get("pane");
  if (params.get("notify") !== "1" || !validDaemonId(daemonId) || !paneId || !PANE_ID_RE.test(paneId)) return null;
  return { daemonId, paneId };
}

export function resolveNotificationTarget(
  target: NotificationTarget,
  currentDaemonId: string | undefined,
  paneIds: Iterable<string>,
): NotificationTargetResolution {
  if (target.daemonId !== currentDaemonId) return { kind: "wait" };
  return new Set(paneIds).has(target.paneId) ? { kind: "open", paneId: target.paneId } : { kind: "missing" };
}
