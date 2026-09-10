import { locale, t, type CopyKey } from "../../lib/i18n";
import { quotaIsStale, type AgentQuota, type QuotaRead, type QuotaStatus, type QuotaWindow } from "../../lib/agent-quota";

/**
 * Pure projection from quota protocol data to what the quota surfaces paint.
 *
 * No application state, no paint loop and no DOM: every function here takes the
 * data it needs and returns copy plus structure, so the connected page decides
 * only *which* session and snapshot to project.
 */

export type QuotaProvider = AgentQuota["provider"];

export const providerNames: Record<QuotaProvider, string> = {
  codex: "Codex", claude: "Claude Code", antigravity: "Antigravity",
  copilot: "GitHub Copilot", cursor: "Cursor", grok: "Grok Build",
};

/** Compact ring labels: the summary strip has room for one word per provider. */
export const shortProviderNames: Record<QuotaProvider, string> = {
  codex: "Codex", claude: "Claude", antigravity: "Antigravity",
  copilot: "Copilot", cursor: "Cursor", grok: "Grok",
};

const providerHelpKeys = {
  codex: "quota.codexHelp",
  claude: "quota.claudeHelp",
  antigravity: "quota.antigravityHelp",
  copilot: "quota.copilotHelp",
  cursor: "quota.cursorHelp",
  grok: "quota.grokHelp",
} as const;

const WINDOW_NAMES: Record<string, CopyKey> = {
  "premium interactions": "quota.window.premium",
  chat: "quota.window.chat",
  completions: "quota.window.completions",
  "Shared subscription quota": "quota.window.shared",
  "Included plan": "quota.window.included",
  "five hour": "quota.window.fiveHour",
  five_hour: "quota.window.fiveHour",
  "seven day": "quota.window.sevenDay",
  seven_day: "quota.window.sevenDay",
  "seven day sonnet": "quota.window.sevenDaySonnet",
  "seven day opus": "quota.window.sevenDayOpus",
  "seven day cowork": "quota.window.sevenDayCowork",
  "seven day routines": "quota.window.sevenDayRoutines",
  spend_limit: "quota.window.spend",
  "spend limit": "quota.window.spend",
};

const statusKeys = {
  ok: "quota.ok",
  stale: "quota.stale",
  not_installed: "quota.notInstalled",
  not_logged_in: "quota.notLoggedIn",
  unsupported: "quota.unsupported",
  unavailable: "quota.unavailable",
  setup_required: "quota.setupRequired",
  auth_required: "quota.authRequired",
  not_running: "quota.notRunning",
} as const satisfies Record<QuotaStatus, string>;

/** Statuses whose provider needs a setup hint rather than a number. */
const HELP_STATUSES: QuotaStatus[] = ["auth_required", "not_installed", "not_running", "not_logged_in"];

export function quotaWindowName(name: string): string {
  const key = WINDOW_NAMES[name] ?? WINDOW_NAMES[name.replaceAll("_", " ")];
  return key ? t(key) : name;
}

export function formatQuotaWhen(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(locale());
}

/** One compact allowance number for the summary ring, or null when unknown. */
export function quotaOverview(q: QuotaRead | undefined): number | "unlimited" | null {
  if (!q || q.status !== "ok" || quotaIsStale(q)) return null;
  const windows = q.provider === "copilot" ? q.windows.filter(w => w.name === "premium interactions") : q.windows;
  if (!windows.length) return null;
  const limited = windows.filter(w => !w.unlimited);
  return limited.length ? Math.min(...limited.map(w => 100 - w.used_percent)) : "unlimited";
}

export function ringLabel(value: number | "unlimited" | null): string {
  if (typeof value === "number") return t("quota.remaining", { percent: Math.round(value) });
  if (value === "unlimited") return t("quota.unlimited");
  return t("quota.unavailable");
}

export function ringCenter(value: number | "unlimited" | null): string {
  if (value === "unlimited") return "∞";
  if (value === null) return "—";
  return `${Math.round(value)}%`;
}

export function ringAngle(value: number | "unlimited" | null): string {
  if (typeof value === "number") return `${value * 3.6}deg`;
  if (value === "unlimited") return "360deg";
  return "0deg";
}

export type QuotaWindowModel =
  | { kind: "unlimited"; key: string; labelText: string }
  | {
    kind: "limited"; key: string; labelText: string; remaining: number;
    /** Inner window name, drawn as a note only when the daemon sent a span. */
    windowName: string; showWindowName: boolean;
    progressAria: string; resetCopy: string;
  };

export type QuotaCardModel = {
  provider: QuotaProvider;
  title: string;
  plan: string;
  statusCopy: string;
  /** Windows are drawn only for a fresh `ok` snapshot. */
  windows: QuotaWindowModel[];
  help: string | null;
  /** An extra CLI/current-command hint only some statuses carry (Cursor auth). */
  helpDetail: string | null;
  /** The Cursor auth command, shown before observed and never on other states. */
  helpCommand: string | null;
  observed: string | null;
  /** Provider and source notes, in the order the card has always shown them. */
  notes: string[];
  /** Setup command kept in its original ending placement (Claude setup_required). */
  command: string | null;
};

function windowLabel(w: QuotaWindow): string {
  return w.window_minutes && w.window_minutes % 1440 === 0
    ? t("quota.days", { count: w.window_minutes / 1440 })
    : w.window_minutes && w.window_minutes % 60 === 0
      ? t("quota.hours", { count: w.window_minutes / 60 })
      : w.window_minutes
        ? t("quota.window", { minutes: w.window_minutes })
        : quotaWindowName(w.name);
}

export function quotaCardModel(q: QuotaRead): QuotaCardModel {
  const title = providerNames[q.provider];
  const stale = (q.status === "ok" || q.status === "stale") && quotaIsStale(q);
  const status = stale ? "stale" : q.status;
  const windows: QuotaWindowModel[] = status === "ok" ? q.windows.map((w, index) => {
    const key = `${w.name}:${index}`;
    const windowName = quotaWindowName(w.name);
    if (w.unlimited) {
      return { kind: "unlimited", key, labelText: `${windowName} · ${t("quota.unlimited")}` };
    }
    const remaining = Math.round((100 - w.used_percent) * 10) / 10;
    const label = windowLabel(w);
    return {
      kind: "limited", key, remaining, windowName,
      labelText: `${label} · ${t("quota.remaining", { percent: remaining })}`,
      showWindowName: w.window_minutes > 0,
      progressAria: `${title} ${label}`,
      resetCopy: w.resets_at ? t("quota.resets", { when: formatQuotaWhen(w.resets_at) }) : t("quota.resetUnknown"),
    };
  }) : [];
  const notes: string[] = [];
  if (q.provider === "copilot") notes.push(t("quota.copilotNote"));
  if (q.provider === "grok") notes.push(t("quota.grokNote"));
  if (q.source === "statusline") notes.push(t("quota.claudeNote"));
  // Help selection is per provider/status. Cursor unsupported gets its own
  // guidance, and only auth_required also carries the keychain hint plus the
  // exact three-line CLI command; other providers' statuses keep their setup
  // hint and no command (setup_required keeps the Claude command below).
  const help = q.provider === "cursor" && q.status === "unsupported"
    ? t("quota.cursorUnsupportedHelp")
    : HELP_STATUSES.includes(q.status)
      ? t(providerHelpKeys[q.provider])
      : null;
  const helpDetail = q.provider === "cursor" && q.status === "auth_required" ? t("quota.cursorKeychainHelp") : null;
  // The Cursor auth command is its own slot shown before observed; the original
  // Claude setup command keeps its ending placement in `command`.
  const helpCommand = q.provider === "cursor" && q.status === "auth_required"
    ? "export AGENT_CLI_CREDENTIAL_STORE=file\ncursor-agent login\npairfob service install"
    : null;
  return {
    provider: q.provider,
    title,
    plan: q.plan || t("quota.planUnknown"),
    statusCopy: t(statusKeys[status]),
    windows,
    help,
    helpDetail,
    helpCommand,
    observed: q.observed_at ? t("quota.updated", { when: formatQuotaWhen(q.observed_at) }) : null,
    notes,
    command: q.status === "setup_required" ? "pairfob quota-setup-claude" : null,
  };
}

/** The slice of a published snapshot the panel and summary projections read. */
export type QuotaSnapshotLike = {
  readonly loading: boolean;
  readonly items: readonly QuotaRead[] | null;
  readonly error: string;
};

export type QuotaPanelModel = {
  busy: boolean;
  error: string | null;
  offline: boolean;
  offlineCopy: string;
  cards: QuotaCardModel[];
};

/** A provider with a fresh snapshot sorts ahead of one that is stale or missing. */
function hasFreshData(q: QuotaRead): boolean {
  return q.status === "ok" && !quotaIsStale(q);
}

export function quotaPanelModel(snapshot: QuotaSnapshotLike | undefined, connected: boolean): QuotaPanelModel {
  return {
    busy: !!snapshot?.loading,
    error: snapshot?.error || null,
    offline: !connected,
    offlineCopy: t("quota.offline"),
    cards: [...(snapshot?.items ?? [])].sort((a, b) => Number(hasFreshData(b)) - Number(hasFreshData(a)))
      .map(quotaCardModel),
  };
}

export type QuotaRingModel = {
  provider: QuotaProvider;
  name: string;
  value: number | "unlimited" | null;
  unknown: boolean;
  center: string;
  angle: string;
  aria: string;
};

export type QuotaSummaryModel = {
  busy: boolean;
  title: string;
  help: string[];
  details: string;
  rings: QuotaRingModel[];
};

export function quotaSummaryModel(snapshot: QuotaSnapshotLike | undefined, connected: boolean): QuotaSummaryModel {
  const details = t("quota.details");
  const entries = (Object.keys(providerNames) as QuotaProvider[]).map(provider => {
    const q = snapshot?.items?.find(item => item.provider === provider);
    return { provider, value: connected && !snapshot?.error ? quotaOverview(q) : null };
  });
  entries.sort((a, b) => Number(a.value === null) - Number(b.value === null));
  return {
    busy: !!snapshot?.loading,
    title: t("quota.title"),
    help: [t("quota.note"), t("quota.summaryNote")],
    details: `${details} ›`,
    rings: entries.map(({ provider, value }) => ({
      provider,
      value,
      name: shortProviderNames[provider],
      unknown: value === null,
      center: ringCenter(value),
      angle: ringAngle(value),
      aria: `${providerNames[provider]} · ${ringLabel(value)} · ${details}`,
    })),
  };
}
