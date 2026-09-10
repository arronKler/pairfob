import type { DeviceSummary } from "../../lib/protocol/client";
import { createDomain, detach } from "../../shared/model/domain-store";

/**
 * Runtime domain: what the connected daemon reported about itself — the Herdr
 * host, runtime kind, push configuration and the paired-device list shown in
 * settings, plus the request flags that gate that panel.
 *
 * Device-local choices live in `preferences.ts`; mutation capabilities in
 * `capabilities.ts`.
 */
export type RuntimeRecord = {
  herdHost: string;
  runtimeKind: string;
  deviceList: DeviceSummary[];
  pushEnabled: boolean | null;
  pushSubscribed: boolean | null;
  settingsLoading: boolean;
  devicesError: string;
  pushConfigError: string;
  /** Bumped so an in-flight settings read for a dead session is dropped. */
  settingsRequest: number;
};

const runtimeDomain = createDomain<RuntimeRecord>("runtime", {
  herdHost: "",
  runtimeKind: "",
  deviceList: [],
  pushEnabled: null,
  pushSubscribed: null,
  settingsLoading: false,
  devicesError: "",
  pushConfigError: "",
  settingsRequest: 0,
});
export const runtimeStore = runtimeDomain.store;
const { read, write } = runtimeDomain.controller;


/**
 * A settings read is starting: take a request token and clear the panel's
 * previous errors. A response whose token is no longer current is dropped, so a
 * dead session can never write into a live panel.
 */
export function beginSettingsRead(): number {
  // Allocate the token before publishing: a subscriber that starts the next read
  // must never receive the same token as this call.
  const request = read().settingsRequest + 1;
  write((record) => {
    record.settingsRequest = request;
    record.settingsLoading = true;
    record.devicesError = "";
    record.pushConfigError = "";
  });
  return request;
}

export function settingsRequestIsCurrent(request: number): boolean {
  return request === read().settingsRequest;
}

export function endSettingsRead(request?: number): void {
  if (request !== undefined && !settingsRequestIsCurrent(request)) return;
  write((record) => {
    record.settingsLoading = false;
  });
}

/** Invalidate in-flight settings reads (the session they belong to is gone). */
export function bumpSettingsRequest(): void {
  write((record) => {
    record.settingsRequest += 1;
    record.settingsLoading = false;
  });
}

export function applyDeviceList(devices: readonly DeviceSummary[], error = ""): void {
  write((record) => {
    record.deviceList = detach([...devices]);
    record.devicesError = error;
  });
}

export function setDevicesError(error: string): void {
  if (read().devicesError === error) return;
  write((record) => {
    record.devicesError = error;
  });
}

export function setPushConfigError(error: string): void {
  if (read().pushConfigError === error) return;
  write((record) => {
    record.pushConfigError = error;
  });
}

/** Push availability from GetConfig; `null` means the daemon did not say. */
export function setPushEnabled(enabled: boolean | null): void {
  if (read().pushEnabled === enabled) return;
  write((record) => {
    record.pushEnabled = enabled;
  });
}

export function setPushSubscribed(subscribed: boolean | null): void {
  if (read().pushSubscribed === subscribed) return;
  write((record) => {
    record.pushSubscribed = subscribed;
  });
}

/** Push availability from GetConfig, read at action time. */
export function pushEnabled(): boolean | null {
  return read().pushEnabled;
}

/** The push config error the panel shows, read at action time. */
export function pushConfigError(): string {
  return read().pushConfigError;
}

/**
 * The identity the connected daemon reported, read at action time.
 *
 * A frozen pair of strings: a caller gets the current values without a writable
 * alias of the record, and without waiting for a commit to publish them. Each
 * call allocates a fresh pair, so this is not a `useSyncExternalStore`
 * getSnapshot.
 */
export function runtimeIdentity(): Readonly<{ herdHost: string; runtimeKind: string }> {
  const { herdHost, runtimeKind } = read();
  return Object.freeze({ herdHost, runtimeKind });
}

/** Identity of the runtime the daemon reported for the connected computer. */
export function applyRuntimeIdentity(identity: { herdHost: string; runtimeKind: string }): void {
  write((record) => {
    record.herdHost = identity.herdHost;
    record.runtimeKind = identity.runtimeKind;
  });
}

/** Drop everything the dead session reported. */
export function resetRuntime(): void {
  write((record) => {
    record.herdHost = "";
    record.runtimeKind = "";
    record.deviceList = [];
    record.pushEnabled = null;
    record.pushSubscribed = null;
    record.settingsLoading = false;
    record.devicesError = "";
    record.pushConfigError = "";
    record.settingsRequest += 1;
  });
}
