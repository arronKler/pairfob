import { nativeNotify, type NativeNotifyBridge } from "./native-notify";
import { isNativeRuntime } from "./runtime-config";

/**
 * How notifications reach this build. Web Push is the existing path; a native
 * shell raises local notifications through its bridge, and a device push
 * channel (FCM, per OEM in mainland China) could join it later.
 */
export type PushChannel = "web" | "local" | "fcm" | "hms" | "mipush" | "oppo" | "vivo" | "honor" | "aggregator";

export type NativePlatform = {
  kind: "android" | "ios";
  /** Empty when the shell exposes no notification bridge. */
  pushChannels: PushChannel[];
};

/**
 * Which native shell this user agent belongs to. Callers that already know
 * they are in a shell (a native-only settings row) read this directly; the
 * runtime flag alone cannot tell Android from iOS.
 */
export function nativePlatformKind(): NativePlatform["kind"] {
  if (typeof navigator === "undefined") return "android";
  const agent = navigator.userAgent;
  // An iPad can present a desktop-class user agent ("Macintosh") while still
  // being a touch device; without the second test it would be read as Android
  // and offered the Android update card.
  const ipad = /Macintosh/i.test(agent) && navigator.maxTouchPoints > 1;
  return /iPhone|iPad|iPod/i.test(agent) || ipad ? "ios" : "android";
}

/** The native shell's platform facts, or null in the hosted web build. */
export function nativePlatform(
  native = isNativeRuntime(),
  notify: Pick<NativeNotifyBridge, "post"> | null = nativeNotify(),
): NativePlatform | null {
  if (!native) return null;
  return { kind: nativePlatformKind(), pushChannels: notify ? ["local"] : [] };
}

/**
 * Whether this build has a native notification path to call. The local bridge
 * is the one channel today; a shell without it keeps the Settings row off
 * instead of pretending Web Push works inside a WebView.
 */
export function nativePushAvailable(platform: NativePlatform | null = nativePlatform()): boolean {
  return platform !== null && platform.pushChannels.length > 0;
}

export function supportsWebPush(): boolean {
  if (isNativeRuntime()) return false;
  return typeof navigator !== "undefined"
    && "serviceWorker" in navigator
    && "PushManager" in window
    && "Notification" in window;
}

/**
 * A native app is already installed, so the iOS Add to Home Screen detour and
 * its Web Push requirement never apply there.
 */
export function needsHomeScreen(): boolean {
  if (isNativeRuntime()) return false;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return ios && !window.matchMedia("(display-mode: standalone)").matches
    && !(navigator as Navigator & { standalone?: boolean }).standalone;
}
