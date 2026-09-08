import { Fragment } from "react";
import { locale, t, type CopyKey } from "../../lib/i18n";
import { quotaIsStale, type AgentQuota, type QuotaStatus } from "../../lib/agent-quota";
import { adoptScreen } from "../../compose-drafts";
import { render } from "../../paint";
import { state } from "../../state";
import { providerNames, refreshAgentQuota, views } from "../agent-quota";
import { BackBar, Button } from "./chrome";

const providerHelp = {
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

function quotaWindowName(name: string): string {
  const key = WINDOW_NAMES[name] ?? WINDOW_NAMES[name.replaceAll("_", " ")];
  return key ? t(key) : name;
}

function formatQuotaWhen(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(locale());
}

function QuotaWindows({ q, title }: { q: AgentQuota; title: string }) {
  return (
    <>
      {q.windows.map((w, index) => {
        const remaining = Math.round((100 - w.used_percent) * 10) / 10;
        const label = w.window_minutes && w.window_minutes % 1440 === 0
          ? t("quota.days", { count: w.window_minutes / 1440 })
          : w.window_minutes && w.window_minutes % 60 === 0
            ? t("quota.hours", { count: w.window_minutes / 60 })
            : w.window_minutes
              ? t("quota.window", { minutes: w.window_minutes })
              : quotaWindowName(w.name);
        const windowName = quotaWindowName(w.name);
        if (w.unlimited) {
          return (
            <span key={`${w.name}:${index}`} className="quota-window-label">
              {`${windowName} · ${t("quota.unlimited")}`}
            </span>
          );
        }
        return (
          <Fragment key={`${w.name}:${index}`}>
            <span className="quota-window-label">{`${label} · ${t("quota.remaining", { percent: remaining })}`}</span>
            {w.window_minutes > 0 ? <small className="set-note">{windowName}</small> : null}
            <progress className="quota-progress" max={100} value={remaining} aria-label={`${title} ${label}`} />
            <small className="set-note">{w.resets_at ? t("quota.resets", { when: formatQuotaWhen(w.resets_at) }) : t("quota.resetUnknown")}</small>
          </Fragment>
        );
      })}
    </>
  );
}

function QuotaCard({ q }: { q: AgentQuota }) {
  const title = providerNames[q.provider];
  const stale = (q.status === "ok" || q.status === "stale") && quotaIsStale(q);
  const status = stale ? "stale" : q.status;
  const helpStatuses = ["auth_required", "not_installed", "not_running", "not_logged_in"];
  return (
    <div className="set-card quota-card">
      <div className="set-row">
        <strong className="set-key">{title}</strong>
        <span className="set-value">{q.plan || t("quota.planUnknown")}</span>
      </div>
      <div className="set-row set-row-stack">
        <p className="set-note">{t(statusKeys[status])}</p>
        {status === "ok" ? <QuotaWindows q={q} title={title} /> : null}
        {helpStatuses.includes(q.status) ? <p className="set-note">{t(providerHelp[q.provider])}</p> : null}
        {q.observed_at ? <small className="set-note">{t("quota.updated", { when: formatQuotaWhen(q.observed_at) })}</small> : null}
        {q.provider === "copilot" ? <p className="set-note">{t("quota.copilotNote")}</p> : null}
        {q.provider === "grok" ? <p className="set-note">{t("quota.grokNote")}</p> : null}
        {q.source === "statusline" ? <p className="set-note">{t("quota.claudeNote")}</p> : null}
        {q.status === "setup_required" ? <code className="quota-command">pairfob quota-setup-claude</code> : null}
      </div>
    </div>
  );
}

export function QuotaPanel() {
  const view = state.live ? views.get(state.live) : undefined;
  const hasData = (q: AgentQuota) => q.status === "ok" && !quotaIsStale(q);
  const items = [...(view?.items ?? [])].sort((a, b) => Number(hasData(b)) - Number(hasData(a)));
  return (
    <section className="quota-panel" aria-busy={!!view?.loading}>
      {view?.error ? <p className="set-note">{view.error}</p> : null}
      {!state.live?.isConnected() ? <p className="set-note">{t("quota.offline")}</p> : null}
      {items.map((q) => (
        <QuotaCard key={q.provider} q={q} />
      ))}
    </section>
  );
}

export function QuotaContent() {
  const view = state.live ? views.get(state.live) : undefined;
  const loading = !!view?.loading;
  return (
    <>
      <BackBar
        title={t("quota.title")}
        onBack={() => {
          adoptScreen("settings");
          render();
        }}
      >
        <div className="topbar-actions">
          <Button
            className="topbar-create quota-refresh"
            disabled={loading || !state.live?.isConnected()}
            aria-busy={loading}
            onClick={() => void refreshAgentQuota()}
          >{t(loading ? "quota.loading" : "quota.refresh")}</Button>
        </div>
      </BackBar>
      <QuotaPanel />
    </>
  );
}

export function QuotaScreen() {
  return (
    <div className="page settings-page quota-page">
      <QuotaContent />
    </div>
  );
}
