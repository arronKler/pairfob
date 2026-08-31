import { t } from "./lib/i18n";
import { parseRuntimeOperationsConfig } from "./lib/operations";
import { reportMutationError } from "./mutations";
import { render } from "./paint";
import { haptic, showError, showStatus, state } from "./state";
import { track } from "./lib/telemetry";

export function openSettings(): void {
  state.screen = "settings";
  track("pwa_settings");
  void refreshSettings();
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
  const session = state.live;
  const request = ++state.settingsRequest;
  state.settingsLoading = true;
  state.devicesError = "";
  state.pushConfigError = "";
  if (state.screen === "settings") render();
  if (!session) {
    state.settingsLoading = false;
    return;
  }
  const [devices, config, subscription] = await Promise.allSettled([
    session.listDevices(),
    session.getConfig(),
    hasLocalPushSubscription(),
  ]);
  if (request !== state.settingsRequest || state.live !== session) return;
  if (devices.status === "fulfilled") {
    state.deviceList = Array.isArray(devices.value.devices) ? devices.value.devices : [];
  } else {
    state.devicesError = t("err.devicesLoad");
  }
  if (config.status === "fulfilled") {
    try {
      parseRuntimeOperationsConfig(config.value);
      state.pushEnabled = config.value.push_enabled === true;
    } catch {
      state.pushEnabled = null;
      state.pushConfigError = t("err.pushConfigBad");
    }
  } else {
    state.pushEnabled = null;
    state.pushConfigError = t("err.pushStatusLoad");
  }
  if (subscription.status === "fulfilled") {
    state.pushSubscribed = subscription.value;
  } else {
    state.pushSubscribed = null;
    if (!state.pushConfigError) state.pushConfigError = t("err.pushPhoneStatus");
  }
  state.settingsLoading = false;
  if (state.screen === "settings") render();
}

function vapidKey(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0)).buffer as ArrayBuffer;
}

export async function enablePush(): Promise<void> {
  const session = state.live;
  if (!session || !supportsWebPush()) {
    showError(t("err.pushUnsupported"));
    render();
    return;
  }
  try {
    const config = await session.getConfig();
    parseRuntimeOperationsConfig(config);
    state.pushEnabled = config.push_enabled === true;
    if (!state.pushEnabled) throw new Error(t("err.pushComputerOff"));
    if (typeof config.vapid_public !== "string" || !config.vapid_public) throw new Error(t("err.pushNotReady"));
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error(t("err.pushPermission"));
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ||
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKey(config.vapid_public),
      }));
    await session.pushSubscribe(subscription.toJSON());
    state.pushSubscribed = true;
    await refreshSettings();
    haptic(10);
    showStatus(t("push.enabled"));
  } catch (error) {
    await reportMutationError(session, error);
  }
  if (state.live === session) render();
}
