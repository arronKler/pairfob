import { useSyncExternalStore, type ReactNode } from "react";
import { openComputers } from "../../features/computers/actions";
import { useComputers } from "../../features/computers/hooks";
import { useConnection, useRuntime } from "../../features/connection/hooks";
import { usePreferences } from "../../features/settings/hooks";
import type { ConnectionRecord } from "../../features/connection/connection-store";
import type { PreferencesRecord } from "../../features/settings/preferences-store";
import type { RuntimeRecord } from "../../features/connection/runtime-store";
import type { DomainView } from "../../shared/model/domain-store";
import { computerTitle } from "../../lib/computer-catalog";
import { langRevision, subscribeLang, t } from "../../lib/i18n";
import { NETWORK_MODE_OPTIONS, type NetworkMode } from "../../lib/network-mode";
import { type DeviceSummary } from "../../lib/protocol/client";
import { TERM_MODE_OPTIONS, type TermMode } from "../../lib/terminal-mode";
import {
  displayDeviceLabel,
  formatDeviceAge,
  notificationAction,
  shortDeviceId,
  TERM_MODE_LABEL,
  visiblePairedDevices,
} from "../../lib/ui-model";
import { revokeDevice, revokeSelf } from "../../features/operations/controller";
import { enablePush, leaveSettings, refreshSettings, selectNetworkMode } from "../../features/settings/actions";
import { setDefaultComposeLive, setDefaultTermMode } from "../../features/settings/preferences-store";
import { herdStatusOf } from "../../features/connection/herd-status";
import { AgentQuotaSummary } from "../../pages/quota/quota-summary";
import { AppNotice } from "../../app/notice";
import { ListGroupControl } from "../../features/dashboard/components/herd-controls";
import { BackBar, Button, EmptyState, Feedback, SetHeading, SetNavRow, SetRow } from "../../shared/ui/primitives";
import { LanguageControl } from "../../features/settings/language";
import { DaemonUpdate } from "../../features/settings/daemon-update-view";
import { settingsNetworkHelp, settingsNetworkP2PFail, settingsNetworkPath } from "../../features/settings/model";

const NETWORK_MODE_COPY: Record<NetworkMode, "settings.networkAuto" | "settings.networkP2P" | "settings.networkRelay"> = {
  auto: "settings.networkAuto",
  p2p: "settings.networkP2P",
  relay: "settings.networkRelay",
};

function helpWithCode(before: string, code: string, after: string) {
  return { before, code, after };
}

/** Re-render mounted copy on the i18n revision (advances on every applied language action). */
function useLang(): void {
  useSyncExternalStore(subscribeLang, langRevision);
}

function NetworkModeControl({ connection }: { connection: ConnectionRecord }) {
  return (
    <div className="seg" role="radiogroup" aria-label={t("settings.networkAria")} aria-busy={connection.transportSwitching || undefined}>
      {NETWORK_MODE_OPTIONS.map((id) => {
        const selected = connection.networkMode === id;
        return (
          <Button
            key={id}
            className={`seg-item${selected ? " on" : ""}`}
            role="radio"
            aria-checked={selected}
            disabled={id === "p2p" && !connection.p2pEnabled}
            onClick={() => void selectNetworkMode(id)}
          >{t(NETWORK_MODE_COPY[id])}</Button>
        );
      })}
    </div>
  );
}

function DefaultTermModeControl({ defaultTermMode }: { defaultTermMode: TermMode }) {
  return (
    <div className="seg" role="radiogroup" aria-label={t("mode.defaultAria")}>
      {TERM_MODE_OPTIONS.map((id) => {
        const selected = defaultTermMode === id;
        return (
          <Button
            key={id}
            className={`seg-item${selected ? " on" : ""}`}
            role="radio"
            aria-checked={selected}
            onClick={() => {
              if (defaultTermMode === id) return;
              setDefaultTermMode(id);
            }}
          >{TERM_MODE_LABEL[id]}</Button>
        );
      })}
    </div>
  );
}

function ComposeLiveControl({ defaultComposeLive }: { defaultComposeLive: boolean }) {
  return (
    <div className="seg compose-live" role="radiogroup" aria-label={t("pane.inputAria")}>
      {(
        [
          { live: false, label: t("compose.batch") },
          { live: true, label: t("compose.live") },
        ] as const
      ).map((option) => {
        const selected = defaultComposeLive === option.live;
        return (
          <Button
            key={option.live ? "1" : "0"}
            className={`seg-item${selected ? " on" : ""}`}
            data-live={option.live ? "1" : "0"}
            role="radio"
            aria-checked={selected}
            onClick={() => {
              if (defaultComposeLive === option.live) return;
              setDefaultComposeLive(option.live);
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

function DeviceRow({ device, connected }: { device: DeviceSummary; connected: boolean }) {
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
          disabled={!connected}
          onClick={() => void revokeDevice(device)}
        >{t("settings.unpairOther")}</Button>
      ) : null}
    </div>
  );
}

function DevicesSection({ runtime, connected }: { runtime: DomainView<RuntimeRecord>; connected: boolean }) {
  const devices = visiblePairedDevices([...runtime.deviceList]);
  const othersHelp = devices.some((device) => !device.self)
    ? () => [helpWithCode(t("settings.manageOthersBody"), "pairfob forget N", t("settings.sentenceEnd"))]
    : undefined;
  return (
    <>
      <SetHeading text={t("settings.devices")} help={othersHelp} />
      {runtime.settingsLoading && !devices.length ? (
        <Feedback value={{ text: t("settings.devicesLoading"), tone: "status" }} />
      ) : runtime.devicesError ? (
        <Feedback value={{ text: runtime.devicesError, tone: "error" }} />
      ) : devices.length ? (
        <div className="set-card device-card">
          {devices.map((device) => (
            <DeviceRow key={device.device_id} device={device} connected={connected} />
          ))}
        </div>
      ) : (
        <EmptyState spec={{ figure: "device", title: t("settings.noOtherDevicesTitle"), sub: t("settings.noOtherDevices") }} />
      )}
    </>
  );
}

function useSettingsView() {
  const connection = useConnection();
  const runtime = useRuntime();
  const preferences = usePreferences();
  const computers = useComputers();
  return { connection, runtime, preferences, computers };
}

export function SettingsContent({ withBack }: { withBack: boolean }) {
  const { connection, runtime, preferences, computers } = useSettingsView();
  useLang();
  // Project the status row from the same published snapshots the surrounding
  // panel reads. The live handle is the snapshot's opaque identity; a staged
  // composition hold keeps the panel on the published phase/online values until
  // the queued commit, so the row can never show offline a frame early.
  const connected = computers.live?.isConnected() === true;
  const status = herdStatusOf({
    connected,
    networkOnline: connection.networkOnline,
    runtimeKind: runtime.runtimeKind,
    herdHost: runtime.herdHost,
  });
  const networkInput = {
    sessionTransport: connection.sessionTransport,
    relayRttMs: connection.relayRttMs,
    p2pEnabled: connection.p2pEnabled,
    networkMode: connection.networkMode,
    lastP2PAttempt: connection.lastP2PAttempt,
  };
  const p2pFail = settingsNetworkP2PFail(networkInput);
  const self = runtime.deviceList.find((device) => device.self && !device.revoked_at);
  const notifyHelp =
    runtime.pushEnabled === false && !runtime.settingsLoading
      ? () => [helpWithCode(t("settings.pushHowtoBody"), "PAIRFOB_PUSH=1", t("settings.pushHowtoTail"))]
      : undefined;
  const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const pushAction = notificationAction(runtime.pushEnabled, runtime.pushSubscribed, pushSupported, runtime.settingsLoading);
  return (
    <>
      {withBack ? (
        <BackBar
          title={t("settings.title")}
          onBack={leaveSettings}
        />
      ) : null}
      <AppNotice />
      <SetHeading text={t("settings.connection")} help={[settingsNetworkHelp(networkInput)]} />
      <div className="set-card">
        <SetNavRow
          label={t("settings.computer")}
          value={runtime.herdHost || (computers.credential ? computerTitle(computers.credential) : t("settings.currentComputer"))}
          onClick={openComputers}
        />
        <SetRow label={t("settings.status")} value={status.text} tone={status.tone} />
        <SetRow label={t("settings.networkRtt")} value={settingsNetworkPath(networkInput)} />
        <div className="set-row set-row-stack network-mode-row">
          {p2pFail ? <p className="set-note network-p2p-fail">{p2pFail}</p> : null}
          {!connection.p2pEnabled ? <p className="set-note">{t("settings.networkP2POff")}</p> : null}
          <NetworkModeControl connection={connection} />
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
          <DefaultTermModeControl defaultTermMode={preferences.defaultTermMode} />
        </LabeledStack>
        <LabeledStack label={t("settings.input")}>
          <ComposeLiveControl defaultComposeLive={preferences.defaultComposeLive} />
        </LabeledStack>
      </div>
      <SetHeading text={t("settings.notifications")} help={notifyHelp} />
      <div className="set-card">
        <div className="set-row set-row-stack">
          <p className="set-note">
            {runtime.pushEnabled === false
              ? t("settings.pushComputerOff")
              : runtime.pushSubscribed === true
                ? t("settings.pushOn")
                : t("settings.pushOff")}
          </p>
          <Button className="btn btn-small" onClick={() => void enablePush()} disabled={pushAction.disabled}>{pushAction.label}</Button>
        </div>
      </div>
      {runtime.pushConfigError ? <Feedback value={{ text: runtime.pushConfigError, tone: "error" }} /> : null}
      <DevicesSection runtime={runtime} connected={connected} />
      <SetHeading text={t("settings.danger")} />
      <div className="set-card">
        <div className="set-row set-row-stack">
          <p className="set-note">{t("settings.unpairNote")}</p>
          <Button className="btn btn-small btn-danger" onClick={() => void revokeSelf()}>{t("settings.unpair")}</Button>
        </div>
      </div>
      {runtime.devicesError || runtime.pushConfigError ? (
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