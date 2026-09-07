export type UpdateStatus = { available: boolean; phase: "idle" | "downloading" | "restarting" | "verifying" | "complete" | "failed" | "rolled_back"; target: string; operation_id: string };
export function parseUpdateStatus(value: unknown): UpdateStatus {
  if (!value || typeof value !== "object") throw new Error("Invalid update status");
  const v = value as Record<string, unknown>;
  if (typeof v.available !== "boolean" || typeof v.phase !== "string" || !["idle", "downloading", "restarting", "verifying", "complete", "failed", "rolled_back"].includes(String(v.phase)) || typeof v.target !== "string" || v.target.length > 64 || typeof v.operation_id !== "string" || v.operation_id.length > 131) throw new Error("Invalid update status");
  return v as UpdateStatus;
}
export function updateInProgress(status?: UpdateStatus): boolean { return !!status && ["downloading", "restarting", "verifying"].includes(status.phase); }
