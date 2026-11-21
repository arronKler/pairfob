export type DesktopReasonKind =
  | "kicked"
  | "locked"
  | "sleeping"
  | "perm_screen"
  | "perm_accessibility"
  | "stopped_on_host"
  | "display_unavailable";

export type ParsedDesktopReason = {
  kind: DesktopReasonKind | null;
  cleanMessage: string;
};

const VALID_REASONS: ReadonlySet<DesktopReasonKind> = new Set([
  "kicked",
  "locked",
  "sleeping",
  "perm_screen",
  "perm_accessibility",
  "stopped_on_host",
  "display_unavailable",
]);

const REASON_PREFIX_RE = /^\s*\[reason:([a-z_]+)\]\s*/i;
const LEGACY_NON_RETRYABLE_RE =
  /lock|sleep|asleep|permission|screen recording|accessibility|disabled|revoked|denied|unsupported|kicked|conflict|锁屏|锁定|休眠|睡眠|权限|未开启|已停用|接管/i;

function isDesktopReasonKind(value: string): value is DesktopReasonKind {
  return VALID_REASONS.has(value as DesktopReasonKind);
}

function inferLegacyReason(message: string): DesktopReasonKind | null {
  if (/screen\s*recording|屏幕录制/i.test(message)) return "perm_screen";
  if (/accessibility|辅助功能/i.test(message)) return "perm_accessibility";
  if (/\b(lock|locked|lock\s*screen)\b|锁屏|锁定/i.test(message)) return "locked";
  if (/\b(sleep|sleeping|asleep)\b|休眠|睡眠/i.test(message)) return "sleeping";
  if (/display.*unavailable|no\s+active\s+display|no\s+display|显示器不可用/i.test(message)) return "display_unavailable";
  if (/stopped\s+on\s+host|主机.*停止/i.test(message)) return "stopped_on_host";
  if (/taken\s+over\s+by\s+another|另一窗口接管/i.test(message)) return "kicked";
  return null;
}

/**
 * Extracts a structured `DesktopReasonKind` from a protocol error code, a
 * `[reason:<kind>]` message prefix, or legacy unprefixed daemon messages.
 */
export function parseDesktopReason(message: string, code?: string): ParsedDesktopReason {
  const match = REASON_PREFIX_RE.exec(message);
  const cleanMessage = (match ? message.slice(match[0].length) : message).trim();

  if (code === "kicked") {
    return { kind: "kicked", cleanMessage };
  }
  if (match) {
    const rawKind = match[1]!.toLowerCase();
    if (isDesktopReasonKind(rawKind)) {
      return { kind: rawKind, cleanMessage };
    }
  }
  return {
    kind: inferLegacyReason(cleanMessage),
    cleanMessage,
  };
}

/**
 * Returns true only for transient transport/ICE errors where automatic retry
 * can succeed without user intervention or kicking another active window.
 */
export function isAutoRetryableDesktopError(message: string, code?: string): boolean {
  if (code === "kicked" || code === "conflict" || code === "unsupported" || code === "invalid_argument") {
    return false;
  }
  if (parseDesktopReason(message, code).kind !== null) {
    return false;
  }
  if (LEGACY_NON_RETRYABLE_RE.test(message)) {
    return false;
  }
  return true;
}
