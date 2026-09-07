import { button, node } from "../lib/dom";
import { t } from "../lib/i18n";
import { quotaIsStale, type AgentQuota } from "../lib/agent-quota";
import { setHeading } from "./chrome";
import { state } from "../state";
import { openQuota, providerNames, views } from "./agent-quota";

const shortNames = { codex: "Codex", claude: "Claude", antigravity: "Antigravity", copilot: "Copilot", cursor: "Cursor", grok: "Grok" };
export function quotaOverview(q: AgentQuota | undefined): number | "unlimited" | null {
  if (!q || q.status !== "ok" || quotaIsStale(q)) return null;
  const windows = q.provider === "copilot" ? q.windows.filter(w => w.name === "premium interactions") : q.windows;
  if (!windows.length) return null;
  const limited = windows.filter(w => !w.unlimited);
  return limited.length ? Math.min(...limited.map(w => 100 - w.used_percent)) : "unlimited";
}

export function quotaSummary(): HTMLElement {
  const section = node("section", "quota-summary");
  const heading = setHeading(t("quota.title"), [t("quota.note"), t("quota.summaryNote")]);
  heading.classList.add("quota-summary-heading");
  const details = button(`${t("quota.details")} ›`, "quota-details", openQuota);
  heading.insertBefore(details, heading.querySelector(".set-help"));
  const strip = node("div", "quota-strip");
  const view = state.live ? views.get(state.live) : undefined;
  section.setAttribute("aria-busy", String(!!view?.loading));
  const entries = (Object.keys(providerNames) as AgentQuota["provider"][]).map(provider => {
    const q = view?.items?.find(q => q.provider === provider);
    const value = state.live?.isConnected() && !view?.error ? quotaOverview(q) : null;
    return { provider, value };
  });
  entries.sort((a, b) => Number(a.value === null) - Number(b.value === null));
  for (const { provider, value } of entries) {
    const label = typeof value === "number" ? t("quota.remaining", { percent: Math.round(value) }) : value === "unlimited" ? t("quota.unlimited") : t("quota.unavailable");
    const item = button("", "quota-mini", openQuota);
    item.setAttribute("aria-label", `${providerNames[provider]} · ${label} · ${t("quota.details")}`);
    const ring = node("span", `quota-ring${value === null ? " is-unknown" : ""}`);
    ring.setAttribute("aria-hidden", "true");
    ring.style.setProperty("--quota-angle", `${typeof value === "number" ? value * 3.6 : value === "unlimited" ? 360 : 0}deg`);
    ring.append(node("span", "quota-ring-center", value === "unlimited" ? "∞" : value === null ? "—" : `${Math.round(value)}%`));
    item.append(ring, node("span", "quota-mini-name", shortNames[provider]));
    strip.append(item);
  }
  section.append(heading, strip);
  return section;
}
