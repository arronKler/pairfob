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
    state.devicesError = "设备列表暂时读不到，请稍后重试。";
  }
  if (config.status === "fulfilled") {
    try {
      parseRuntimeOperationsConfig(config.value);
      state.pushEnabled = config.value.push_enabled === true;
    } catch {
      state.pushEnabled = null;
      state.pushConfigError = "通知配置格式不正确，请更新电脑端。";
    }
  } else {
    state.pushEnabled = null;
    state.pushConfigError = "通知状态暂时读不到，请稍后重试。";
  }
  if (subscription.status === "fulfilled") {
    state.pushSubscribed = subscription.value;
  } else {
    state.pushSubscribed = null;
    if (!state.pushConfigError) state.pushConfigError = "这台手机的通知状态暂时读不到，请稍后重试。";
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
    showError("当前浏览器不支持网页通知。");
    render();
    return;
  }
  try {
    const config = await session.getConfig();
    parseRuntimeOperationsConfig(config);
    state.pushEnabled = config.push_enabled === true;
    if (!state.pushEnabled) throw new Error("电脑端尚未开启通知。看「电脑端设置方法」的步骤。");
    if (typeof config.vapid_public !== "string" || !config.vapid_public) throw new Error("电脑端通知配置还没准备好，请稍后重试。");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("浏览器没有允许通知。请在浏览器设置中允许后重试。");
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
    showStatus("通知已开启。");
  } catch (error) {
    await reportMutationError(session, error);
  }
  if (state.live === session) render();
}
