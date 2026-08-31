import { t } from "./i18n.ts";
import type { PairResult } from "./protocol/client.ts";

const BURNED_CODES = new Set([
  "revoked",
  "unpaired",
  "invalid_credential",
  "bad_proof",
  "bad_signature",
  "fp_mismatch",
]);

export function credentialIsBurned(code: string | undefined): boolean {
  return typeof code === "string" && BURNED_CODES.has(code);
}

export function computerTitle(pair: PairResult): string {
  const host = pair.hostname?.trim();
  return host || t("computer.unnamed");
}

export function pickResumeCredential(credentials: PairResult[], lastUsedDaemonId: string | null): PairResult | null {
  if (!credentials.length) return null;
  if (lastUsedDaemonId) {
    const match = credentials.find((item) => item.daemonId === lastUsedDaemonId);
    if (match) return match;
  }
  return sortComputers(credentials, lastUsedDaemonId)[0] ?? null;
}

export function sortComputers(credentials: PairResult[], lastUsedDaemonId: string | null): PairResult[] {
  return [...credentials].sort((a, b) => {
    if (lastUsedDaemonId) {
      if (a.daemonId === lastUsedDaemonId) return -1;
      if (b.daemonId === lastUsedDaemonId) return 1;
    }
    const seen = (b.lastSeen || b.createdAt) - (a.lastSeen || a.createdAt);
    if (seen) return seen;
    return a.daemonId.localeCompare(b.daemonId);
  });
}

export function phaseAfterComputers(count: number): "pick" | "connect" {
  return count > 0 ? "pick" : "connect";
}
