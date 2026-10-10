import { connectionDiagnostics } from "../../lib/protocol/connection-diagnostics";
import { readWorkerNotificationEvidence } from "./notification-diagnostics";

export async function exportConnectionDiagnostics(): Promise<void> {
  const worker_notifications = await readWorkerNotificationEvidence();
  const report = { version: 1, exported_at: new Date().toISOString(), records: connectionDiagnostics(), worker_notifications };
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `pairfob-connection-${Date.now()}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
