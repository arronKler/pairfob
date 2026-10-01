import { validDaemonId } from "../identifiers.ts";

export const MACHINE_STATES = ["available", "disabled", "session_unsupported"] as const;
export const MACHINE_LINK_PHASES = ["idle", "checking", "needs_install", "installing", "offering", "paired", "failed"] as const;
export const MACHINE_LINK_ERRORS = [
  "unreachable", "unsupported", "disabled", "session_unsupported", "not_running",
  "install_failed", "rate_limited", "cancelled", "expired", "internal",
] as const;

export type MachineState = typeof MACHINE_STATES[number];
export type MachineLinkPhase = typeof MACHINE_LINK_PHASES[number];
export type MachineLinkError = typeof MACHINE_LINK_ERRORS[number];

/** Another computer the paired one already reaches. The id is opaque. */
export type MachineSummary = {
  id: string;
  label: string;
  state: MachineState;
  daemonId?: string;
};

export type MachineLinkStatus = {
  operationId: string;
  machineId: string;
  phase: MachineLinkPhase;
  /** One-use pairing link for the machine; present only while offering. */
  pairUrl?: string;
  error?: MachineLinkError;
};

const MACHINE_ID = /^[A-Za-z0-9._-]{1,128}$/;

function invalid(label: string): never {
  throw new Error(`${label} 响应格式不正确`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(label);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (!Object.keys(value).every((key) => allowed.includes(key))) invalid(label);
}

export function validMachineId(value: unknown): value is string {
  return typeof value === "string" && MACHINE_ID.test(value);
}

export function parseMachineList(raw: unknown): MachineSummary[] {
  const label = "ListMachines";
  const result = record(raw, label);
  exactKeys(result, ["machines"], label);
  if (!Array.isArray(result.machines) || result.machines.length > 256) return invalid(label);
  const seen = new Set<string>();
  return result.machines.map((item) => {
    const row = record(item, label);
    exactKeys(row, ["id", "label", "state", "daemon_id"], label);
    if (!validMachineId(row.id) || seen.has(row.id)) return invalid(label);
    if (typeof row.label !== "string" || [...row.label].length > 128) return invalid(label);
    if (!(MACHINE_STATES as readonly unknown[]).includes(row.state)) return invalid(label);
    if (row.daemon_id !== undefined && !validDaemonId(row.daemon_id)) return invalid(label);
    seen.add(row.id);
    return {
      id: row.id,
      label: row.label,
      state: row.state as MachineState,
      ...(row.daemon_id ? { daemonId: row.daemon_id as string } : {}),
    };
  });
}

export function parseMachineLink(raw: unknown): MachineLinkStatus {
  const label = "LinkMachine";
  const result = record(raw, label);
  exactKeys(result, ["operation_id", "machine_id", "phase", "pair_url", "error"], label);
  if (typeof result.operation_id !== "string" || result.operation_id.length > 131) return invalid(label);
  if (typeof result.machine_id !== "string" || result.machine_id.length > 128) return invalid(label);
  if (!(MACHINE_LINK_PHASES as readonly unknown[]).includes(result.phase)) return invalid(label);
  const phase = result.phase as MachineLinkPhase;
  if (result.pair_url !== undefined && (typeof result.pair_url !== "string" || result.pair_url.length > 512 || phase !== "offering")) {
    return invalid(label);
  }
  if (result.error !== undefined && (!(MACHINE_LINK_ERRORS as readonly unknown[]).includes(result.error) || phase !== "failed")) {
    return invalid(label);
  }
  return {
    operationId: result.operation_id,
    machineId: result.machine_id,
    phase,
    ...(result.pair_url ? { pairUrl: result.pair_url as string } : {}),
    ...(result.error ? { error: result.error as MachineLinkError } : {}),
  };
}
