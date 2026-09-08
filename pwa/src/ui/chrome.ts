import { t } from "../lib/i18n";
import { runtimeLiveness, type RuntimeLiveness } from "../lib/runtime-liveness";
import { state, type StatusTone } from "../state";

export type EmptyFigure = "panes" | "grid" | "link" | "device";

export type EmptySpec = {
  title: string;
  sub: string;
  figure?: EmptyFigure;
  action?: { label: string; run: () => void; disabled?: boolean };
};

/** Interrupt is a mutation: only a live, currently-working agent may show Stop. */
export function canInterruptAgent(status: string): boolean {
  return status === "working" && herdLiveness() === "live";
}

/** Loss of contact is never process death: only a connected session that reports `runtime=offline` is exited. */
export function herdLiveness(): RuntimeLiveness {
  return runtimeLiveness({
    connected: state.live?.isConnected() === true,
    networkOnline: state.networkOnline,
    runtimeKind: state.runtimeKind,
  });
}

export function herdStatus(): { tone: StatusTone; text: string } {
  if (!state.networkOnline) return { tone: "warn", text: t("chrome.networkOffline") };
  const verdict = herdLiveness();
  if (verdict === "unverifiable") {
    const connected = state.live?.isConnected() === true;
    return { tone: "warn", text: connected ? t("chrome.unverifiable") : t("chrome.reconnecting") };
  }
  if (verdict === "exited") return { tone: "off", text: t("chrome.herdrOff") };
  if (state.runtimeKind === "fake") return { tone: "demo", text: t("chrome.demo") };
  if (state.herdHost) return { tone: "live", text: t("chrome.connectedHost", { host: state.herdHost }) };
  return { tone: "live", text: t("chrome.connected") };
}
