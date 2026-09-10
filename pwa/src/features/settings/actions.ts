import { currentScreen, goToScreen } from "../../app/navigation-store";
import { liveSession } from "../computers/catalog-store";
import { openPaneId } from "../session/session-store";
import { commitView } from "../../app/host";
import {
  applyDeviceList, beginSettingsRead, endSettingsRead, pushConfigError, pushEnabled, setDevicesError,
  setPushConfigError, setPushEnabled, setPushSubscribed, settingsRequestIsCurrent,
} from "../connection/runtime-store";
import { networkMode, p2pEnabled, sessionTransport, setNetworkMode, setTransportSwitching } from "../connection/connection-store";
import { clearNotice, showError, showStatus } from "../../app/notices-store";
import { t } from "../../lib/i18n";
import { type NetworkMode } from "../../lib/network-mode";
import { parseRuntimeOperationsConfig } from "../../lib/operations";
import { directFailureDiagnostic } from "../../lib/protocol/client";
import { haptic } from "../../shared/ui/dom/feedback";
import { reportMutationError } from "../connection/mutations";
import { track } from "../../lib/telemetry";
import { syncInactiveTransportMode } from "../connection/controller";
import { bindSessionOwnerFromLive } from "../../features/session/bind-live";
import { applyComposeDraft, bumpViewIncarnation, parkComposeView } from "../session/drafts/compose-drafts";
import { isDesk } from "../../app/viewport";
import { acceptDaemonVersion, checkDaemonRelease, markDaemonConfigIncompatible } from "./daemon-update";
import { refreshAgentQuota } from "../agent-quota/actions";

/**
 * Settings controller — the feature's one connected adapter for settings reads,
 * transport preference and push. Request tokens come from the runtime domain so
 * a stale GetConfig/ListDevices answer cannot land on a replacement session.
 * After every publishing write, re-read the captured session/token before the
 * next mutation so a subscriber that switched computers cannot inherit the rest
 * of this read.
 */

export function settingsReadStillOwned(request: number, session: object | null): boolean {
  return session !== null && settingsRequestIsCurrent(request) && liveSession() === session;
}

export function sessionStillOwned(session: object | null): boolean {
  return session !== null && liveSession() === session;
}

let networkModeSeq = 0;

function p2pFailureMessage(error: unknown): string {
  const diagnostic = directFailureDiagnostic(error);
  let detail = "";
  switch (diagnostic) {
    case "ice_timeout":
    case "ice_failed":
    case "offer":
      detail = t("settings.networkP2PFailedICE");
      break;
    case "channel_timeout":
    case "channel_failed":
      detail = t("settings.networkP2PFailedChannel");
      break;
    case "signal":
    case "answer":
      detail = t("settings.networkP2PFailedSignal");
      break;
    case "handshake":
    case "commit":
    case "probe":
      detail = t("settings.networkP2PFailedVerify");
  }
  return detail ? `${t("settings.networkP2PFailed")} ${detail}` : t("settings.networkP2PFailed");
}

export function openSettings(): void {
  // Leaving the open pane parks its guided draft first: leaveSettings reapplies
  // the parked text on return, so an entry that skips the park would come back
  // to an empty field.
  if (currentScreen() === "pane") parkComposeView();
  goToScreen("settings");
  commitView();
  track("pwa_settings");
  void refreshSettings();
}

/**
 * Leave settings. Returning to the open pane keeps the session-owned draft
 * ceremony the other adopt-screen callers use: invalidate the view incarnation,
 * rebind the live owner and reapply the parked draft. The navigation commits
 * through the application port so the arriving screen is composed synchronously.
 */
export function leaveSettings(): void {
  if (isDesk() && openPaneId()) {
    bumpViewIncarnation();
    goToScreen("pane");
    bindSessionOwnerFromLive();
    applyComposeDraft();
  } else {
    goToScreen("home");
  }
  commitView();
}

function supportsWebPush(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

async function hasLocalPushSubscription(): Promise<boolean> {
  if (!supportsWebPush()) return false;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return false;
  return (await registration.pushManager.getSubscription()) !== null;
}

export async function refreshSettings(): Promise<void> {
  void checkDaemonRelease();
  void refreshAgentQuota();
  const session = liveSession();
  const request = beginSettingsRead();
  if (!session || !settingsReadStillOwned(request, session)) {
    endSettingsRead(request);
    return;
  }
  const [devices, config, subscription] = await Promise.allSettled([
    session.listDevices(),
    session.getConfig(),
    hasLocalPushSubscription(),
  ]);
  if (!settingsReadStillOwned(request, session)) return;
  if (devices.status === "fulfilled") {
    applyDeviceList(Array.isArray(devices.value.devices) ? devices.value.devices : [], "");
  } else {
    setDevicesError(t("err.devicesLoad"));
  }
  if (!settingsReadStillOwned(request, session)) return;
  if (config.status === "fulfilled") {
    acceptDaemonVersion(config.value);
    if (!settingsReadStillOwned(request, session)) return;
    try {
      parseRuntimeOperationsConfig(config.value);
      setPushEnabled(config.value.push_enabled === true);
    } catch {
      markDaemonConfigIncompatible();
      if (!settingsReadStillOwned(request, session)) return;
      setPushEnabled(null);
      if (!settingsReadStillOwned(request, session)) return;
      setPushConfigError(t("err.pushConfigBad"));
    }
  } else {
    setPushEnabled(null);
    if (!settingsReadStillOwned(request, session)) return;
    setPushConfigError(t("err.pushStatusLoad"));
  }
  if (!settingsReadStillOwned(request, session)) return;
  if (subscription.status === "fulfilled") {
    setPushSubscribed(subscription.value);
  } else {
    setPushSubscribed(null);
    if (!settingsReadStillOwned(request, session)) return;
    if (!pushConfigError()) setPushConfigError(t("err.pushPhoneStatus"));
  }
  if (!settingsReadStillOwned(request, session)) return;
  endSettingsRead(request);
}

export async function selectNetworkMode(mode: NetworkMode): Promise<void> {
  if (mode === "p2p" && !p2pEnabled()) return;
  const retry = mode === "p2p" && sessionTransport() !== "p2p";
  if (networkMode() === mode && !retry) return;
  setNetworkMode(mode);
  const session = liveSession();
  const seq = ++networkModeSeq;
  if (!session) {
    syncInactiveTransportMode(mode);
    return;
  }
  syncInactiveTransportMode(mode, session);
  const fromP2P = sessionTransport() === "p2p";
  const connected = session.isConnected();
  setTransportSwitching(true);
  if (connected) {
    if (mode === "p2p") showStatus(t("settings.networkTryingP2P"), true);
    else if (mode === "relay" && fromP2P) showStatus(t("settings.networkSwitchingRelay"), true);
    else if (mode === "auto" && !fromP2P && p2pEnabled()) showStatus(t("settings.networkTryingP2P"));
  }
  try {
    await session.switchTransport(mode);
    if (seq !== networkModeSeq || liveSession() !== session) return;
    if (mode === "p2p" && sessionTransport() === "p2p") showStatus(t("settings.networkP2PConnected"));
    else clearNotice();
  } catch (error) {
    if (seq !== networkModeSeq || liveSession() !== session) return;
    showError(mode === "relay" ? t("settings.networkRelayFailed") : p2pFailureMessage(error));
  } finally {
    if (seq === networkModeSeq && liveSession() === session) setTransportSwitching(false);
  }
}

function vapidKey(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0)).buffer as ArrayBuffer;
}

export async function enablePush(): Promise<void> {
  const session = liveSession();
  if (!session || !supportsWebPush()) {
    showError(t("err.pushUnsupported"));
    return;
  }
  try {
    const config = await session.getConfig();
    if (!sessionStillOwned(session)) return;
    parseRuntimeOperationsConfig(config);
    setPushEnabled(config.push_enabled === true);
    if (!sessionStillOwned(session)) return;
    if (!pushEnabled()) throw new Error(t("err.pushComputerOff"));
    if (typeof config.vapid_public !== "string" || !config.vapid_public) throw new Error(t("err.pushNotReady"));
    const permission = await Notification.requestPermission();
    if (!sessionStillOwned(session)) return;
    if (permission !== "granted") throw new Error(t("err.pushPermission"));
    const registration = await navigator.serviceWorker.ready;
    if (!sessionStillOwned(session)) return;
    const existing = await registration.pushManager.getSubscription();
    if (!sessionStillOwned(session)) return;
    const subscription =
      existing ||
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKey(config.vapid_public),
      }));
    if (!sessionStillOwned(session)) return;
    await session.pushSubscribe(subscription.toJSON());
    if (!sessionStillOwned(session)) return;
    setPushSubscribed(true);
    if (!sessionStillOwned(session)) return;
    await refreshSettings();
    if (!sessionStillOwned(session)) return;
    haptic(10);
    showStatus(t("push.enabled"));
  } catch (error) {
    if (!sessionStillOwned(session)) return;
    await reportMutationError(session, error);
  }
}
