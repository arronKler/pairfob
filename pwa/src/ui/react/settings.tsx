import type { ReactNode } from "react";
import { openComputers } from "../../computers";
import { computerTitle } from "../../lib/computer-catalog";
import { t } from "../../lib/i18n";
import { NETWORK_MODE_OPTIONS, type NetworkMode } from "../../lib/network-mode";
import { type DeviceSummary } from "../../lib/protocol/client";
import { TERM_MODE_OPTIONS } from "../../lib/terminal-mode";
import {
  displayDeviceLabel,
  formatDeviceAge,
  notificationAction,
  shortDeviceId,
  TERM_MODE_LABEL,
  visiblePairedDevices,
} from "../../lib/ui-model";
import { revokeDevice, revokeSelf } from "../../live-operations";
import { enablePush, refreshSettings, selectNetworkMode } from "../../live-settings";
import { adoptScreen } from "../../compose-drafts";
import { render } from "../../paint";
import { setDefaultComposeLive, setDefaultTermMode, state } from "../../state";
import { isDesk } from "../../viewport";
import { herdStatus } from "../chrome";
import { AgentQuotaSummary } from "./agent-quota-summary";
import {
  AppNotice,
  BackBar,
  Button,
  EmptyState,
  Feedback,
  LanguageControl,
  ListGroupControl,
  SetHeading,
  SetNavRow,
  SetRow,
} from "./chrome";
import { DaemonUpdate } from "./daemon-update";

const NETWORK_MODE_COPY: Record<NetworkMode, "settings.networkAuto" | "settings.networkP2P" | "settings.networkRelay"> = {
  auto: "settings.networkAuto",
  p2p: "settings.networkP2P",
  relay: "settings.networkRelay",
};

function networkPathCopy(): string {
  if (state.sessionTransport === "p2p") {
    return state.relayRttMs === null ? t("settings.networkP2PPending") : t("settings.networkRttP2P", { ms: state.relayRttMs });
  }
  if (state.p2pEnabled && state.networkMode === "p2p") {
    return state.relayRttMs === null ? t("settings.networkP2PRelayPending") : t("settings.networkP2PRelay", { ms: state.relayRttMs });
  }
  return state.relayRttMs === null ? t("settings.networkRelayPending") : t("settings.networkRttRelay", { ms: state.relayRttMs });
}

function networkHelpCopy(): string {
  if (state.networkMode === "p2p") return t("settings.networkP2PNote");
  return t("settings.networkNote");
}

function helpWithCode(before: string, code: string, after: string) {
  return { before, code, after };
}

function networkP2PFailCopy(): string {
  if (!state.p2pEnabled || state.networkMode === "relay" || state.sessionTransport === "p2p") return "";
  const attempt = state.lastP2PAttempt;
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

function NetworkModeControl() {
  return (
    <div className="seg" role="radiogroup" aria-label={t("settings.networkAria")} aria-busy={state.transportSwitching || undefined}>
      {NETWORK_MODE_OPTIONS.map((id) => {
        const selected = state.networkMode === id;
        return (
          <Button
            key={id}
            className={`seg-item${selected ? " on" : ""}`}
            role="radio"
            aria-checked={selected}
            disabled={id === "p2p" && !state.p2pEnabled}
            onClick={() => void selectNetworkMode(id)}
          >{t(NETWORK_MODE_COPY[id])}</Button>
        );
      })}
    </div>
  );
}

function DefaultTermModeControl() {
  return (
    <div className="seg" role="radiogroup" aria-label={t("mode.defaultAria")}>
      {TERM_MODE_OPTIONS.map((id) => {
        const selected = state.defaultTermMode === id;
        return (
          <Button
            key={id}
            className={`seg-item${selected ? " on" : ""}`}
            role="radio"
            aria-checked={selected}
            onClick={() => {
              if (state.defaultTermMode === id) return;
              setDefaultTermMode(id);
              render();
            }}
          >{TERM_MODE_LABEL[id]}</Button>
        );
      })}
    </div>
  );
}

function ComposeLiveControl() {
  return (
    <div className="seg compose-live" role="radiogroup" aria-label={t("pane.inputAria")}>
      {(
        [
          { live: false, label: t("compose.batch") },
          { live: true, label: t("compose.live") },
        ] as const
      ).map((option) => {
        const selected = state.defaultComposeLive === option.live;
        return (
          <Button
            key={option.live ? "1" : "0"}
            className={`seg-item${selected ? " on" : ""}`}
            data-live={option.live ? "1" : "0"}
            role="radio"
            aria-checked={selected}
            onClick={() => {
              if (state.defaultComposeLive === option.live) return;
              setDefaultComposeLive(option.live);
              render();
            }}
          >{option.label}</Button>
        );
      })}
    </div>
  );
}

function LabeledStack({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="set-row set-row-stack set-field">
      <span className="set-key">{label}</span>
      {children}
    </div>
  );
}

function DeviceRow({ device }: { device: DeviceSummary }) {
  const name = displayDeviceLabel(device.label || "") || t("device.unnamed");
  const activity = t("device.lastUsed", { when: formatDeviceAge(device.last_seen || device.created_at) });
  const notifications = device.subscription_count ? t("device.notifyOn") : t("device.notifyOff");
  return (
    <div className="device">
      <div className="device-body">
        <div className="device-head">
          <strong className="device-name">{name}</strong>
          {device.self ? <span className="pill pill-live">{t("device.self")}</span> : null}
          {!device.self && device.connected === true ? <span className="pill pill-live">{t("device.connected")}</span> : null}
          {!device.self && device.connected === false ? <span className="pill pill-idle">{t("device.offline")}</span> : null}
        </div>
        <code className="device-id" title={device.device_id}>
          {shortDeviceId(device.device_id)}
        </code>
        <p className="device-meta">{activity + notifications}</p>
      </div>
      {!device.self ? (
        <Button
          className="device-forget"
          aria-label={t("settings.unpairOtherAria", { name })}
          disabled={!state.live?.isConnected()}
          onClick={() => void revokeDevice(device)}
        >{t("settings.unpairOther")}</Button>
      ) : null}
    </div>
  );
}

function DevicesSection() {
  const devices = visiblePairedDevices(state.deviceList);
  const othersHelp = devices.some((device) => !device.self)
    ? () => [helpWithCode(t("settings.manageOthersBody"), "pairfob forget N", t("settings.sentenceEnd"))]
    : undefined;
  return (
    <>
      <SetHeading text={t("settings.devices")} help={othersHelp} />
      {state.settingsLoading && !devices.length ? (
        <Feedback value={{ text: t("settings.devicesLoading"), tone: "status" }} />
      ) : state.devicesError ? (
        <Feedback value={{ text: state.devicesError, tone: "error" }} />
      ) : devices.length ? (
        <div className="set-card device-card">
          {devices.map((device) => (
            <DeviceRow key={device.device_id} device={device} />
          ))}
        </div>
      ) : (
        <EmptyState spec={{ figure: "device", title: t("settings.noOtherDevicesTitle"), sub: t("settings.noOtherDevices") }} />
      )}
    </>
  );
}

export function SettingsContent({ withBack }: { withBack: boolean }) {
  const status = herdStatus();
  const p2pFail = networkP2PFailCopy();
  const self = state.deviceList.find((device) => device.self && !device.revoked_at);
  const notifyHelp =
    state.pushEnabled === false && !state.settingsLoading
      ? () => [helpWithCode(t("settings.pushHowtoBody"), "PAIRFOB_PUSH=1", t("settings.pushHowtoTail"))]
      : undefined;
  const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const pushAction = notificationAction(state.pushEnabled, state.pushSubscribed, pushSupported, state.settingsLoading);
  return (
    <>
      {withBack ? (
        <BackBar
          title={t("settings.title")}
          onBack={() => {
            adoptScreen(isDesk() && state.paneId ? "pane" : "home");
            render();
          }}
        />
      ) : null}
      <AppNotice />
      <SetHeading text={t("settings.connection")} help={[networkHelpCopy()]} />
      <div className="set-card">
        <SetNavRow
          label={t("settings.computer")}
          value={state.herdHost || (state.credential ? computerTitle(state.credential) : t("settings.currentComputer"))}
          onClick={openComputers}
        />
        <SetRow label={t("settings.status")} value={status.text} tone={status.tone} />
        <SetRow label={t("settings.networkRtt")} value={networkPathCopy()} />
        <div className="set-row set-row-stack network-mode-row">
          {p2pFail ? <p className="set-note network-p2p-fail">{p2pFail}</p> : null}
          {!state.p2pEnabled ? <p className="set-note">{t("settings.networkP2POff")}</p> : null}
          <NetworkModeControl />
        </div>
        {self ? <SetRow label={t("settings.thisPhone")} value={displayDeviceLabel(self.label || "") || t("settings.pairedPhone")} /> : null}
      </div>
      <AgentQuotaSummary />
      <SetHeading text={t("settings.language")} help={[t("settings.languageNote")]} />
      <div className="set-card">
        <div className="set-row">
          <LanguageControl />
        </div>
      </div>
      <SetHeading text={t("settings.list")} help={[t("settings.listNote")]} />
      <div className="set-card">
        <div className="set-row">
          <ListGroupControl />
        </div>
      </div>
      <SetHeading text={t("settings.defaults")} help={[t("settings.modeNote"), t("settings.inputNote")]} />
      <div className="set-card">
        <LabeledStack label={t("settings.mode")}>
          <DefaultTermModeControl />
        </LabeledStack>
        <LabeledStack label={t("settings.input")}>
          <ComposeLiveControl />
        </LabeledStack>
      </div>
      <SetHeading text={t("settings.notifications")} help={notifyHelp} />
      <div className="set-card">
        <div className="set-row set-row-stack">
          <p className="set-note">
            {state.pushEnabled === false
              ? t("settings.pushComputerOff")
              : state.pushSubscribed === true
                ? t("settings.pushOn")
                : t("settings.pushOff")}
          </p>
          <Button className="btn btn-small" onClick={() => void enablePush()} disabled={pushAction.disabled}>{pushAction.label}</Button>
        </div>
      </div>
      {state.pushConfigError ? <Feedback value={{ text: state.pushConfigError, tone: "error" }} /> : null}
      <DevicesSection />
      <SetHeading text={t("settings.danger")} />
      <div className="set-card">
        <div className="set-row set-row-stack">
          <p className="set-note">{t("settings.unpairNote")}</p>
          <Button className="btn btn-small btn-danger" onClick={() => void revokeSelf()}>{t("settings.unpair")}</Button>
        </div>
      </div>
      {state.devicesError || state.pushConfigError ? (
        <Button className="btn btn-small btn-ghost retry" onClick={() => void refreshSettings()}>{t("retry")}</Button>
      ) : null}
      <DaemonUpdate />
    </>
  );
}

export function SettingsScreen() {
  return (
    <div className="page settings-page">
      <SettingsContent withBack />
    </div>
  );
}
