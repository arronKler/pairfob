import { t } from "./i18n";
import { OPERATION_INPUT_LIMITS } from "./operations";

export type FormResult<T> = { ok: true; value: T } | { ok: false; message: string; field?: string };

export function accepted<T>(value: T): FormResult<T> {
  return { ok: true, value };
}

export function rejected<T>(message: string, field?: string): FormResult<T> {
  return { ok: false, message, ...(field ? { field } : {}) };
}

export function openWorktreeTargetError(path: string, branch: string): string | null {
  if (!path && !branch) return t("form.needPathOrBranch");
  if (path && branch) return t("form.pathXorBranch");
  return null;
}

export function splitRatioError(raw: string): string | null {
  if (!raw) return null;
  const ratio = Number(raw);
  return Number.isFinite(ratio) && ratio > 0 && ratio < 1 ? null : t("form.needRatio");
}

export function resizeAmountError(raw: string): string | null {
  const amount = Number(raw);
  return Number.isFinite(amount) && amount > 0 && amount <= 1 ? null : t("form.needAmount");
}

export const LAST_AGENT_KIND_KEY = "pairfob:lastAgentKind";

export function loadLastAgentKind(agentKinds: string[]): string {
  try {
    const raw = localStorage.getItem(LAST_AGENT_KIND_KEY);
    if (!raw) return "";
    const kind = raw.trim().slice(0, OPERATION_INPUT_LIMITS.agentKind);
    return agentKinds.includes(kind) ? kind : "";
  } catch {
    return "";
  }
}

function rememberAgentKind(kind: string): void {
  try {
    localStorage.setItem(LAST_AGENT_KIND_KEY, kind.slice(0, OPERATION_INPUT_LIMITS.agentKind));
  } catch {
    /* storage blocked; the next form just starts from a terminal again */
  }
}

export function readAgentKind(data: FormData, agentKinds: string[]): FormResult<string | undefined> {
  const agentKind = String(data.get("agent_kind") || "").trim();
  if (agentKind && !agentKinds.includes(agentKind)) return rejected(t("form.needKind"), "agent_kind");
  rememberAgentKind(agentKind);
  return accepted(agentKind || undefined);
}
