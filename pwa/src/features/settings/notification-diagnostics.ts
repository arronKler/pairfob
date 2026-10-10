import { sanitizeConnectionDiagnostic, type ConnectionDiagnostic } from "../../lib/protocol/connection-diagnostics";

/** Same-origin worker evidence; no worker wake-up or network request is needed. */
export type WorkerNotificationEvidence = {
  status: "ok" | "missing" | "unavailable" | "timeout";
  records: ConnectionDiagnostic[];
};

export async function readWorkerNotificationEvidence(): Promise<WorkerNotificationEvidence> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async (): Promise<WorkerNotificationEvidence> => {
    try {
      const response = await caches.match("/__pairfob_notification_diagnostics__", {
        cacheName: "pairfob-notification-diagnostics-v1",
      });
      if (!response) return { status: "missing", records: [] };
      const raw: unknown = await response.json();
      if (!Array.isArray(raw)) return { status: "unavailable", records: [] };
      const now = Date.now();
      const records = raw.slice(-100).map(row => sanitizeConnectionDiagnostic(row, now))
        .filter((row): row is ConnectionDiagnostic => row !== null && row.event.startsWith("notify_sw_"));
      return { status: "ok", records };
    } catch { return { status: "unavailable", records: [] }; }
  };
  try {
    return await Promise.race([read(), new Promise<WorkerNotificationEvidence>(resolve => {
      timer = setTimeout(() => resolve({ status: "timeout", records: [] }), 1000);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
