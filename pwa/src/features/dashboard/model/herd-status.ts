/**
 * Herd status projection.
 *
 * The status line and the brand dot are a pure function of reachability: what the
 * phone knows about the network, the session and the runtime the daemon reported.
 * Loss of contact is never process death, so "unverifiable" is a warning and only
 * a connected session that reports `runtime=offline` is exited.
 *
 * `ui/chrome.ts#herdStatus` still projects the same ladder from the legacy record
 * for screens that have not migrated; `herd-status.test.ts` pins the two together
 * until that copy is retired.
 */
import { t } from "../../../lib/i18n";
import { runtimeLiveness, type RuntimeLiveness, type RuntimeLivenessInput } from "../../../lib/runtime-liveness";
import type { HerdStatus } from "./herd-view";

export function herdLivenessModel(input: RuntimeLivenessInput): RuntimeLiveness {
  return runtimeLiveness(input);
}

export function herdStatusModel(input: RuntimeLivenessInput & { herdHost: string; liveness?: RuntimeLiveness }): HerdStatus {
  const liveness = input.liveness ?? runtimeLiveness(input);
  if (!input.networkOnline) return { tone: "warn", text: t("chrome.networkOffline") };
  if (liveness === "unverifiable") {
    return { tone: "warn", text: input.connected ? t("chrome.unverifiable") : t("chrome.reconnecting") };
  }
  if (liveness === "exited") return { tone: "off", text: t("chrome.herdrOff") };
  if (input.runtimeKind === "fake") return { tone: "demo", text: t("chrome.demo") };
  if (input.herdHost) return { tone: "live", text: t("chrome.connectedHost", { host: input.herdHost }) };
  return { tone: "live", text: t("chrome.connected") };
}
