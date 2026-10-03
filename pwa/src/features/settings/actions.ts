export { selectNetworkMode } from "./network-preference";
import { currentScreen, goToScreen } from "../../app/navigation-store";
import { liveSession } from "../computers/catalog-store";
import { openPaneId } from "../session/session-store";
import { commitView } from "../../app/host";
import {
  applyDeviceList, beginSettingsRead, endSettingsRead, pushConfigError, pushEnabled, setDevicesError,
  setPushConfigError, setPushEnabled, setPushSubscribed, settingsRequestIsCurrent,
} from "../connection/runtime-store";
import { showError, showStatus } from "../../app/notices-store";
import { t } from "../../lib/i18n";
import { parseRuntimeOperationsConfig } from "../../lib/operations";
import { haptic } from "../../shared/ui/dom/feedback";
import { reportMutationError } from "../connection/mutations";
import { track } from "../../lib/telemetry";
import { bindSessionOwnerFromLive } from "../../features/session/bind-live";
import { applyComposeDraft, bumpViewIncarnation, parkComposeView } from "../session/drafts/compose-drafts";
import { isDesk } from "../../app/viewport";
import { acceptDaemonVersion, checkDaemonRelease, markDaemonConfigIncompatible } from "./daemon-update";
import { refreshAgentQuota } from "../agent-quota/actions";
import { loadHerdSessions } from "../herd-sessions/load";
import { setSettingsSection, type SettingsSection } from "./settings-section";

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

/** Open Settings on one of its pages (the overview unless asked otherwise). */
export function openSettingsSection(section: SettingsSection): void {
  setSettingsSection(section);
  if (currentScreen() !== "settings") openSettings();
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
  setSettingsSection("overview");
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
  void loadHerdSessions();
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
