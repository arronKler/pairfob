import { preparedPushConfig, rememberPushConfig, type PushConfig } from "./push-config";
import { computerSubscription, preparePushRegistration, subscribeComputer } from "./push-registrations";
export { selectNetworkMode } from "./network-preference";
import { currentScreen, goToScreen } from "../../app/navigation-store";
import { liveSession } from "../computers/catalog-store";
import { openPaneId } from "../session/session-store";
import { commitView } from "../../app/host";
import {
  applyDeviceList, beginSettingsRead, endSettingsRead, pushConfigError, setDevicesError,
  setPushConfigError, setPushEnabled, setPushSubscribed, settingsRequestIsCurrent,
} from "../connection/runtime-store";
import { showError, showStatus } from "../../app/notices-store";
import { t } from "../../lib/i18n";
import { supportsWebPush } from "../../lib/platform";
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
  void refreshSettings(true);
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

export { supportsWebPush } from "../../lib/platform";

/** Whether this browser holds a subscription made with the connected computer's key. */
async function computerSubscribed(push: PushConfig | undefined): Promise<boolean> {
  if (!supportsWebPush() || !push) return false;
  const app = await navigator.serviceWorker.getRegistration();
  if (!app) return false;
  const subscribed = (await computerSubscription(app, push.daemon_id, push.vapid_public)) !== null;
  if (push.push_enabled && Notification.permission !== "denied") {
    void preparePushRegistration(app, push.daemon_id, push.vapid_public).catch(() => undefined);
  }
  return subscribed;
}

/** Get the connected computer's worker ready before a tap may subscribe it. */
export function preparePush(): void {
  const session = liveSession();
  const push = session ? preparedPushConfig(session) : undefined;
  if (!push?.push_enabled || !supportsWebPush() || Notification.permission === "denied") return;
  void navigator.serviceWorker.getRegistration()
    .then(app => app && preparePushRegistration(app, push.daemon_id, push.vapid_public))
    .catch(() => undefined);
}

export async function refreshSettings(reuseQuota = false): Promise<void> {
  void checkDaemonRelease();
  void refreshAgentQuota(reuseQuota);
  void loadHerdSessions();
  const session = liveSession();
  const request = beginSettingsRead();
  if (!session || !settingsReadStillOwned(request, session)) {
    endSettingsRead(request);
    return;
  }
  const [devices, config] = await Promise.allSettled([
    session.listDevices(),
    session.getConfig(),
  ]);
  if (!settingsReadStillOwned(request, session)) return;
  // The computer's own count for this device: a subscription the browser holds
  // but the computer never saved (its PushSubscribe was lost) is not "on".
  let computerHolds: boolean | null = null;
  if (devices.status === "fulfilled") {
    const list = Array.isArray(devices.value.devices) ? devices.value.devices : [];
    const count = list.find(device => device.self)?.subscription_count;
    if (typeof count === "number") computerHolds = count > 0;
    applyDeviceList(list, "");
  } else {
    setDevicesError(t("err.devicesLoad"));
  }
  if (!settingsReadStillOwned(request, session)) return;
  if (config.status === "fulfilled") {
    acceptDaemonVersion(config.value);
    if (!settingsReadStillOwned(request, session)) return;
    try {
      parseRuntimeOperationsConfig(config.value);
      rememberPushConfig(session, config.value);
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
  const [subscribed] = await Promise.allSettled([computerSubscribed(preparedPushConfig(session))]);
  if (!settingsReadStillOwned(request, session)) return;
  if (subscribed.status === "fulfilled") {
    setPushSubscribed(subscribed.value && computerHolds !== false);
  } else {
    setPushSubscribed(null);
    if (!settingsReadStillOwned(request, session)) return;
    if (!pushConfigError()) setPushConfigError(t("err.pushPhoneStatus"));
  }
  if (!settingsReadStillOwned(request, session)) return;
  endSettingsRead(request);
}

export async function enablePush(): Promise<boolean> {
  const session = liveSession();
  if (!session || !supportsWebPush()) {
    showError(t("err.pushUnsupported"));
    return false;
  }
  try {
    const config = preparedPushConfig(session);
    if (!config) throw new Error(t("err.pushNotReady"));
    if (!config.push_enabled) throw new Error(t("err.pushComputerOff"));
    if (!config.vapid_public) throw new Error(t("err.pushNotReady"));
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (!sessionStillOwned(session)) return false;
    if (permission !== "granted") throw new Error(t("err.pushPermission"));
    const registration = await navigator.serviceWorker.ready;
    if (!sessionStillOwned(session)) return false;
    // A switch to another computer meanwhile leaves this subscription with this
    // computer's registration, unsent; the next tap here reuses it.
    const subscription = await subscribeComputer(registration, config.daemon_id, config.vapid_public);
    if (!sessionStillOwned(session)) return false;
    await session.pushSubscribe(subscription.toJSON());
    if (!sessionStillOwned(session)) return false;
    setPushSubscribed(true);
    if (!sessionStillOwned(session)) return false;
    await refreshSettings();
    if (!sessionStillOwned(session)) return false;
    haptic(10);
    showStatus(t("push.enabled"));
    return true;
  } catch (error) {
    if (!sessionStillOwned(session)) return false;
    await reportMutationError(session, error);
    return false;
  }
}
