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

/** Blank means no alias; otherwise at most 64 runes and no control characters. */
export function validComputerAlias(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  return Array.from(trimmed).length <= 64 && !/[\u0000-\u001f\u007f-\u009f]/.test(trimmed);
}

export function computerTitle(pair: PairResult): string {
  const alias = pair.alias?.trim();
  if (alias) return alias;
  const host = pair.hostname?.trim();
  return host || t("computer.unnamed");
}

/**
 * What to call the computer on screen: this browser's alias, then the name the
 * runtime reported, then the saved hostname, then the generic "this computer".
 */
export function computerDisplayName(pair: PairResult | null | undefined, reportedHost?: string | null): string {
  const alias = pair?.alias?.trim();
  if (alias) return alias;
  const host = reportedHost?.trim();
  if (host) return host;
  return pair ? computerTitle(pair) : t("settings.currentComputer");
}

/** Re-pairing the same daemon keeps the name this browser gave it. */
export function withCarriedAlias(pair: PairResult, existing: PairResult | null | undefined): PairResult {
  const alias = existing?.alias?.trim();
  if (!alias || pair.alias?.trim()) return pair;
  return { ...pair, alias };
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
