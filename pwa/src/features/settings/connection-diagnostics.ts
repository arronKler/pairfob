import { connectionDiagnostics } from "../../lib/protocol/connection-diagnostics";

export function exportConnectionDiagnostics(): void {
  const report = { version: 1, exported_at: new Date().toISOString(), records: connectionDiagnostics() };
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `pairfob-connection-${Date.now()}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
