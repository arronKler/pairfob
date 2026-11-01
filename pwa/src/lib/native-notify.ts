/**
 * The native shell's local-notification bridge. MainActivity exposes it as
 * `window.PairfobNotify`; the hosted web build has no bridge, so every caller
 * gets null and the Android notification row never renders.
 */

import type { NativeMessagePort } from "./native-app";

export type NativeNotificationPermission = "granted" | "denied" | "prompt";

export type NativeNotificationStatus = {
  permission: NativeNotificationPermission;
  backgroundSync: boolean;
};

export type NativeNotification = {
  title: string;
  body: string;
  tag: string;
  url: string;
};

export type NativeNotifyBridge = {
  status(): Promise<NativeNotificationStatus>;
  requestPermission(): Promise<NativeNotificationPermission>;
  post(notification: NativeNotification): Promise<void>;
  cancel(tag: string): Promise<void>;
  cancelAll(): Promise<void>;
  setBackgroundSync(on: boolean): Promise<boolean>;
  ready(): Promise<{ url: string | null }>;
  onTap(listener: (url: string) => void): () => void;
};

type NativeNotifyWindow = Window & { PairfobNotify?: NativeMessagePort };

const INVALID = "invalid native notification response";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function permission(value: unknown): NativeNotificationPermission {
  if (value === "granted" || value === "denied" || value === "prompt") return value;
  throw new Error(INVALID);
}

/** Correlate replies and bound failed requests, including a missing native reply. */
export function createNativeNotify(
  port: NativeMessagePort,
  timeoutMs = 25_000,
  permissionTimeoutMs = 90_000,
): NativeNotifyBridge {
  let counter = 0;
  const taps = new Set<(url: string) => void>();
  const pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  port.onmessage = (event) => {
    let message: unknown;
    try { message = JSON.parse(event.data); } catch { return; }
    if (!isObject(message)) return;
    if (message.event === "tap") {
      // A tap URL outside /pair# cannot address a pane; drop it instead of
      // handing the link parser a target it would reject anyway.
      if (typeof message.url === "string" && message.url.startsWith("/pair#")) {
        for (const listener of [...taps]) listener(message.url);
      }
      return;
    }
    if (typeof message.id !== "string") return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.ok === true) waiter.resolve(message.value);
    else waiter.reject(new Error("native notification request failed"));
  };
  function request(method: string, payload: Record<string, unknown> = {}, timeout = timeoutMs): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = String(++counter);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("native notification request timed out"));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      try {
        port.postMessage(JSON.stringify({ id, method, ...payload }));
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("native notification request failed"));
      }
    });
  }
  return {
    status: async () => {
      const value = await request("status");
      if (!isObject(value) || typeof value.backgroundSync !== "boolean") throw new Error(INVALID);
      return { permission: permission(value.permission), backgroundSync: value.backgroundSync };
    },
    // The OS permission dialog can stay up for the better part of a minute.
    requestPermission: async () => {
      const value = await request("requestPermission", {}, permissionTimeoutMs);
      return permission(isObject(value) ? value.permission : undefined);
    },
    post: async (notification) => {
      const value = await request("post", { ...notification });
      if (!isObject(value) || value.posted !== true) throw new Error(INVALID);
    },
    cancel: async (tag) => {
      const value = await request("cancel", { tag });
      if (!isObject(value) || value.cancelled !== true) throw new Error(INVALID);
    },
    cancelAll: async () => {
      const value = await request("cancelAll");
      if (!isObject(value)) throw new Error(INVALID);
    },
    setBackgroundSync: async (on) => {
      const value = await request("setBackgroundSync", { on });
      if (!isObject(value) || typeof value.backgroundSync !== "boolean") throw new Error(INVALID);
      return value.backgroundSync;
    },
    ready: async () => {
      const value = await request("ready");
      if (!isObject(value)) throw new Error(INVALID);
      const tap = value.tap;
      if (tap === null || tap === undefined) return { url: null };
      if (!isObject(tap) || typeof tap.url !== "string") throw new Error(INVALID);
      return { url: tap.url };
    },
    onTap: (listener) => {
      taps.add(listener);
      return () => { taps.delete(listener); };
    },
  };
}

let cachedPort: NativeMessagePort | undefined;
let cachedBridge: NativeNotifyBridge | null = null;

/** The native notification bridge, or null in the hosted web build. */
export function nativeNotify(): NativeNotifyBridge | null {
  if (typeof window === "undefined") return null;
  const port = (window as NativeNotifyWindow).PairfobNotify;
  if (!port || typeof port.postMessage !== "function") return null;
  if (port !== cachedPort) {
    cachedPort = port;
    cachedBridge = createNativeNotify(port);
  }
  return cachedBridge;
}
