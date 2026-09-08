import type { CSSProperties } from "react";
import { t } from "../../lib/i18n";
import { type AgentQuota } from "../../lib/agent-quota";
import { state } from "../../state";
import { openQuota, providerNames, views } from "../agent-quota";
import { quotaOverview } from "../agent-quota-summary";
import { Button, SetHeading } from "./chrome";

const shortNames = { codex: "Codex", claude: "Claude", antigravity: "Antigravity", copilot: "Copilot", cursor: "Cursor", grok: "Grok" };

function ringLabel(value: number | "unlimited" | null): string {
  if (typeof value === "number") return t("quota.remaining", { percent: Math.round(value) });
  if (value === "unlimited") return t("quota.unlimited");
  return t("quota.unavailable");
}

function ringCenter(value: number | "unlimited" | null): string {
  if (value === "unlimited") return "∞";
  if (value === null) return "—";
  return `${Math.round(value)}%`;
}

function ringAngle(value: number | "unlimited" | null): string {
  if (typeof value === "number") return `${value * 3.6}deg`;
  if (value === "unlimited") return "360deg";
  return "0deg";
}

export function AgentQuotaSummary() {
  const title = t("quota.title");
  const view = state.live ? views.get(state.live) : undefined;
  const entries = (Object.keys(providerNames) as AgentQuota["provider"][]).map((provider) => {
    const q = view?.items?.find((item) => item.provider === provider);
    const value = state.live?.isConnected() && !view?.error ? quotaOverview(q) : null;
    return { provider, value };
  });
  entries.sort((a, b) => Number(a.value === null) - Number(b.value === null));
  return (
    <section className="quota-summary" aria-busy={!!view?.loading}>
      <SetHeading text={title} help={[t("quota.note"), t("quota.summaryNote")]} className="quota-summary-heading">
        <Button className="quota-details" onClick={openQuota}>{`${t("quota.details")} ›`}</Button>
      </SetHeading>
      <div className="quota-strip">
        {entries.map(({ provider, value }) => {
          const label = ringLabel(value);
          return (
            <Button
              key={provider}
              className="quota-mini"
              onClick={openQuota}
              aria-label={`${providerNames[provider]} · ${label} · ${t("quota.details")}`}
            >
              <span
                className={`quota-ring${value === null ? " is-unknown" : ""}`}
                aria-hidden="true"
                style={{ "--quota-angle": ringAngle(value) } as CSSProperties}
              >
                <span className="quota-ring-center">{ringCenter(value)}</span>
              </span>
              <span className="quota-mini-name">{shortNames[provider]}</span>
            </Button>
          );
        })}
      </div>
    </section>
  );
}
