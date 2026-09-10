import { t } from "../../lib/i18n";
import type { NetworkMode } from "../../lib/network-mode";
import type { FinishedP2PAttemptObservation } from "../../lib/protocol/client";

/**
 * Pure copy for the settings connection card. The caller supplies the live
 * transport observation; this file does not read application state.
 */

export type SettingsNetworkInput = {
  sessionTransport: "relay" | "p2p";
  relayRttMs: number | null;
  p2pEnabled: boolean;
  networkMode: NetworkMode;
  lastP2PAttempt: FinishedP2PAttemptObservation | null;
};

export function settingsNetworkPath(input: SettingsNetworkInput): string {
  if (input.sessionTransport === "p2p") {
    return input.relayRttMs === null ? t("settings.networkP2PPending") : t("settings.networkRttP2P", { ms: input.relayRttMs });
  }
  if (input.p2pEnabled && input.networkMode === "p2p") {
    return input.relayRttMs === null ? t("settings.networkP2PRelayPending") : t("settings.networkP2PRelay", { ms: input.relayRttMs });
  }
  return input.relayRttMs === null ? t("settings.networkRelayPending") : t("settings.networkRttRelay", { ms: input.relayRttMs });
}

export function settingsNetworkHelp(input: Pick<SettingsNetworkInput, "networkMode">): string {
  if (input.networkMode === "p2p") return t("settings.networkP2PNote");
  return t("settings.networkNote");
}

export function settingsNetworkP2PFail(input: SettingsNetworkInput): string {
  if (!input.p2pEnabled || input.networkMode === "relay" || input.sessionTransport === "p2p") return "";
  const attempt = input.lastP2PAttempt;
  if (!attempt || attempt.result !== "failed") return "";
  switch (attempt.extra) {
    case "ice_timeout":
    case "ice_failed":
    case "offer":
      return t("settings.networkP2PFailedICE");
    case "channel_timeout":
    case "channel_failed":
      return t("settings.networkP2PFailedChannel");
    case "signal":
    case "answer":
      return t("settings.networkP2PFailedSignal");
    case "handshake":
    case "commit":
    case "probe":
      return t("settings.networkP2PFailedVerify");
    default:
      return t("settings.networkP2PFailed");
  }
}
