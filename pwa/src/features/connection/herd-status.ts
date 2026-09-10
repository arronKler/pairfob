import { t } from "../../lib/i18n";
import { runtimeLiveness, type RuntimeLiveness, type RuntimeLivenessInput } from "../../lib/runtime-liveness";
import type { StatusTone } from "../../shared/ui/primitives";

/**
 * Connection runtime status: the pure model behind the herd banners, the
 * settings status row and the interrupt decision.
 *
 * Every function takes its inputs explicitly, so a session or dashboard
 * consumer can project a status from whatever snapshot it already holds instead
 * of reaching for a global. `runtime-status.ts` is the one adapter that reads
 * application state and calls into this.
 *
 * Loss of contact is never process death: a dropped socket, an offline phone or
 * a failed GetConfig only ever mean "unverifiable".
 */

export type HerdStatusInput = RuntimeLivenessInput & {
  /** Last known Herdr host label; empty means the daemon never reported one. */
  herdHost: string;
};

export type HerdStatus = { tone: StatusTone; text: string };

export function herdLivenessOf(input: RuntimeLivenessInput): RuntimeLiveness {
  return runtimeLiveness(input);
}

/** Interrupt is a mutation: only a live, currently-working agent may show Stop. */
export function canInterruptAgentWith(agentStatus: string, liveness: RuntimeLiveness): boolean {
  return agentStatus === "working" && liveness === "live";
}

export function herdStatusOf(input: HerdStatusInput): HerdStatus {
  if (!input.networkOnline) return { tone: "warn", text: t("chrome.networkOffline") };
  const verdict = herdLivenessOf(input);
  if (verdict === "unverifiable") {
    return { tone: "warn", text: input.connected ? t("chrome.unverifiable") : t("chrome.reconnecting") };
  }
  if (verdict === "exited") return { tone: "off", text: t("chrome.herdrOff") };
  if (input.runtimeKind === "fake") return { tone: "demo", text: t("chrome.demo") };
  if (input.herdHost) return { tone: "live", text: t("chrome.connectedHost", { host: input.herdHost }) };
  return { tone: "live", text: t("chrome.connected") };
}
