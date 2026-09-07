import { button, node } from "../lib/dom";
import { t } from "../lib/i18n";
import { quotaIsStale, type AgentQuota, type QuotaStatus } from "../lib/agent-quota";
import { ProtocolError } from "../lib/protocol/errors";
import type { LiveSession } from "../lib/protocol/session-types";
import { adoptScreen } from "../compose-drafts";
import { app, state } from "../state";
import { render } from "../paint";
import { backBar, setHeading } from "./chrome";

type QuotaView = { loading: boolean; items: AgentQuota[] | null; error: string };
export const providerNames = { codex: "Codex", claude: "Claude Code", antigravity: "Antigravity", copilot: "GitHub Copilot", cursor: "Cursor", grok: "Grok Build" };
const providerHelp = { codex: "quota.codexHelp", claude: "quota.claudeHelp", antigravity: "quota.antigravityHelp", copilot: "quota.copilotHelp", cursor: "quota.cursorHelp", grok: "quota.grokHelp" } as const;
export const views = new WeakMap<LiveSession, QuotaView>();
const statusKeys = {
  ok: "quota.ok", stale: "quota.stale", not_installed: "quota.notInstalled", not_logged_in: "quota.notLoggedIn",
  unsupported: "quota.unsupported", unavailable: "quota.unavailable", setup_required: "quota.setupRequired", auth_required: "quota.authRequired", not_running: "quota.notRunning",
} as const satisfies Record<QuotaStatus, string>;

export async function refreshAgentQuota(): Promise<void> {
  const session = state.live;
  if (!session || !session.isConnected() || views.get(session)?.loading) return;
  const view: QuotaView = { loading: true, items: views.get(session)?.items ?? null, error: "" };
  views.set(session, view);
  if ((state.screen === "settings" || state.screen === "quota")) render();
  try {
    view.items = await session.agentQuota();
  } catch (error) {
    view.items = null;
    view.error = t(error instanceof ProtocolError && error.code === "unknown_op" ? "quota.upgrade" : "quota.failed");
  } finally {
    view.loading = false;
    if (state.live === session && (state.screen === "settings" || state.screen === "quota")) render();
  }
}

export function quotaPanel(): HTMLElement {
  const section = node("section", "quota-panel");
  section.append(setHeading(t("quota.title"), [t("quota.note")]));
  const view = state.live ? views.get(state.live) : undefined;
  const refresh = button(t(view?.loading ? "quota.loading" : "quota.refresh"), "btn btn-small btn-ghost", () => void refreshAgentQuota());
  refresh.disabled = !!view?.loading || !state.live?.isConnected();
  section.append(refresh);
  section.setAttribute("aria-busy", String(!!view?.loading));
  if (view?.error) section.append(node("p", "set-note", view.error));
  if (!state.live?.isConnected()) section.append(node("p", "set-note", t("quota.offline")));
  const hasData = (q: AgentQuota) => q.status === "ok" && !quotaIsStale(q);
  const items = [...(view?.items ?? [])].sort((a, b) => Number(hasData(b)) - Number(hasData(a)));
  for (const q of items) {
    const card = node("div", "set-card quota-card");
    const row = node("div", "set-row");
    const title = providerNames[q.provider];
    row.append(node("strong", "set-key", title), node("span", "set-value", q.plan || t("quota.planUnknown")));
    card.append(row);
    const body = node("div", "set-row set-row-stack");
    const stale = (q.status === "ok" || q.status === "stale") && quotaIsStale(q);
    const status = stale ? "stale" : q.status;
    body.append(node("p", "set-note", t(statusKeys[status])));
    if (status === "ok") {
      for (const w of q.windows) {
        const remaining = Math.round((100 - w.used_percent) * 10) / 10;
        const label = w.window_minutes && w.window_minutes % 1440 === 0
          ? t("quota.days", { count: w.window_minutes / 1440 })
          : w.window_minutes && w.window_minutes % 60 === 0
            ? t("quota.hours", { count: w.window_minutes / 60 })
            : w.window_minutes ? t("quota.window", { minutes: w.window_minutes }) : w.name;
        if (w.unlimited) {
          body.append(node("span", "quota-window-label", `${w.name} · ${t("quota.unlimited")}`));
          continue;
        }
        body.append(node("span", "quota-window-label", `${label} · ${t("quota.remaining", { percent: remaining })}`));
        if (w.window_minutes > 0) body.append(node("small", "set-note", w.name));
        const bar = node("progress", "quota-progress") as HTMLProgressElement;
        bar.max = 100;
        bar.value = remaining;
        bar.setAttribute("aria-label", `${title} ${label}`);
        body.append(bar, node("small", "set-note", w.resets_at ? t("quota.resets", { when: new Date(w.resets_at * 1000).toLocaleString() }) : t("quota.resetUnknown")));
      }
    }
    if (["auth_required", "not_installed", "not_running", "not_logged_in"].includes(q.status)) body.append(node("p", "set-note", t(providerHelp[q.provider])));
    if (q.observed_at) body.append(node("small", "set-note", t("quota.updated", { when: new Date(q.observed_at * 1000).toLocaleString() })));
    if (q.provider === "copilot") body.append(node("p", "set-note", t("quota.copilotNote")));
    if (q.provider === "grok") body.append(node("p", "set-note", t("quota.grokNote")));
    if (q.source === "statusline") body.append(node("p", "set-note", t("quota.claudeNote")));
    if (q.status === "setup_required") body.append(node("code", "quota-command", "pairfob quota-setup-claude"));
    card.append(body);
    section.append(card);
  }
  return section;
}

export function openQuota(): void {
  adoptScreen("quota");
  render();
  void refreshAgentQuota();
}
export function fillQuota(container: HTMLElement): void {
  container.append(backBar(t("quota.title"), () => { adoptScreen("settings"); render(); }), node("p", "set-note", t("quota.summaryNote")), quotaPanel());
}
export function renderQuota(): void {
  const root = node("div", "page quota-page");
  fillQuota(root);
  app.replaceChildren(root);
}
