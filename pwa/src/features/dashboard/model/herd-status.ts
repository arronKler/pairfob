/**
 * Herd status projection.
 *
 * The status line and the brand dot are a pure function of reachability: what the
 * phone knows about the network, the session and the runtime the daemon reported.
 * Loss of contact is never process death, so "unverifiable" is a warning and only
 * a connected session that reports `runtime=offline` is exited.
 */
import { t } from "../../../lib/i18n";
import type { ConnectionPhase } from "../../../lib/connection-phase";
import { runtimeLiveness, type RuntimeLiveness, type RuntimeLivenessInput } from "../../../lib/runtime-liveness";
import type { HerdStatus } from "./herd-view";

export function herdLivenessModel(input: RuntimeLivenessInput): RuntimeLiveness {
  return runtimeLiveness(input);
}

type HerdStatusModelInput = Omit<RuntimeLivenessInput, "connected"> & {
  phase: ConnectionPhase;
  herdHost: string;
  reading?: boolean;
  liveness?: RuntimeLiveness;
};

export function herdStatusModel(input: HerdStatusModelInput): HerdStatus {
  const liveness = input.liveness ?? runtimeLiveness({
    connected: input.phase === "connected",
    networkOnline: input.networkOnline,
    runtimeKind: input.runtimeKind,
  });
  if (!input.networkOnline) return { tone: "warn", text: t("chrome.networkOffline") };
  if (input.phase === "verifying") return { tone: "pending", text: t("chrome.verifying") };
  if (input.phase === "connecting") return { tone: "pending", text: t("chrome.checking") };
  // The first runtime read is still in flight: reading, not a fault.
  if (input.reading && input.phase === "connected" && !input.runtimeKind) return { tone: "pending", text: t("chrome.reading") };
  if (liveness === "unverifiable") {
    return { tone: "warn", text: input.phase === "connected" ? t("chrome.unverifiable") : t("chrome.reconnecting") };
  }
  if (liveness === "exited") return { tone: "off", text: t("chrome.herdrOff") };
  if (input.runtimeKind === "fake") return { tone: "demo", text: t("chrome.demo") };
  if (input.herdHost) return { tone: "live", text: t("chrome.connectedHost", { host: input.herdHost }) };
  return { tone: "live", text: t("chrome.connected") };
}
