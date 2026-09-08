import { locale, t } from "./i18n.ts";
import { type DeviceSummary } from "./protocol/session-types.ts";
import { runtimeLiveness } from "./runtime-liveness.ts";

export type PairErrorField = "code" | null;

/** User-facing names for pane preferences. Auto resolves to one concrete view when a pane opens. */
export const TERM_MODE_LABEL = {
  get auto(): string {
    return t("mode.auto");
  },
  get guided(): string {
    return t("mode.guided");
  },
  get full(): string {
    return t("mode.full");
  },
  get agent(): string {
    return t("mode.agent");
  },
};

/** Session-menu labels. Terminal is not “make this pane taller”. */
export const TERM_MODE_MENU = {
  get auto(): string {
    return t("mode.autoMenu");
  },
  get guided(): string {
    return TERM_MODE_LABEL.guided;
  },
  get full(): string {
    return t("mode.fullMenu");
  },
  get agent(): string {
    return TERM_MODE_LABEL.agent;
  },
};

/**
 * `action` names the one thing worth doing from this empty state; the caller
 * owns the handler so this stays free of DOM and live-session imports. `create`
 * is only ever offered when GetConfig reported create_conversation.
 */
export type EmptySessionAction = "create" | "retry" | "settings";
export type EmptySessionCopy = { title: string; detail: string; action?: EmptySessionAction };
export type NotificationAction = { label: string; disabled: boolean };

/**
 * Pairing is three real protocol steps, so the wait screen shows three. The
 * states are derived from the pairing state machine only: there is no synthetic
 * progress, and a step is never marked done before its step actually finished.
 */
export const PAIR_STEPS = ["code", "channel", "verify"] as const;
export type PairStepKey = (typeof PAIR_STEPS)[number];
export type PairStepState = "todo" | "active" | "done" | "failed";
export type PairStep = { key: PairStepKey; state: PairStepState };

export function pairProgress(opts: { pairing: boolean; awaitingApproval: boolean; failedStep: PairStepKey | null }): PairStep[] {
  // A failure freezes the rail on the step that failed, so the error has a place
  // to land instead of only appearing as a notice at the bottom of the form.
  const at = opts.pairing
    ? PAIR_STEPS.indexOf(opts.awaitingApproval ? "verify" : "channel")
    : PAIR_STEPS.indexOf(opts.failedStep ?? "code");
  const here: PairStepState = opts.pairing ? "active" : "failed";
  return PAIR_STEPS.map((key, index) => ({ key, state: index < at ? "done" : index === at ? here : "todo" }));
}

export function pairErrorField(code: string): PairErrorField {
  if (["locator_required", "invalid_pair_code", "bad_pair_code", "unpaired"].includes(code)) return "code";
  return null;
}

export function shouldForgetPairFragment(code: string): boolean {
  return ["unpaired", "bad_pair_code", "pairing_replaced", "pairing_expired", "fp_mismatch", "bad_relay", "sas_required", "pairing_cancelled", "revoked"].includes(code);
}

export function emptySessionCopy(runtimeKind: string, connected: boolean, canCreate: boolean, networkOnline = true): EmptySessionCopy {
  const verdict = runtimeLiveness({ connected, networkOnline, runtimeKind });
  if (verdict === "unverifiable") {
    if (!connected || !networkOnline) {
      return { title: t("empty.reconnectingTitle"), detail: t("empty.reconnectingDetail"), action: "retry" };
    }
    return { title: t("empty.unverifiableTitle"), detail: t("empty.unverifiableDetail"), action: "settings" };
  }
  if (verdict === "exited") {
    return { title: t("empty.offlineTitle"), detail: t("empty.offlineDetail"), action: "retry" };
  }
  return {
    title: t("empty.noneTitle"),
    detail: canCreate ? t("empty.noneCreate") : t("empty.noneOpen"),
    action: canCreate ? "create" : undefined,
  };
}

export function notificationAction(
  pushEnabled: boolean | null,
  pushSubscribed: boolean | null,
  supported: boolean,
  loading: boolean,
): NotificationAction {
  if (loading) return { label: t("push.loading"), disabled: true };
  if (!supported) return { label: t("push.unsupported"), disabled: true };
  if (pushEnabled === false) return { label: t("push.computerOff"), disabled: true };
  if (pushEnabled === null) return { label: t("push.unknown"), disabled: true };
  if (pushSubscribed === true) return { label: t("push.on"), disabled: true };
  if (pushSubscribed === false) return { label: t("push.turnOn"), disabled: false };
  return { label: t("push.retry"), disabled: false };
}

export function displayDeviceLabel(label: string): string {
  if (label === "Existing browser") return t("device.existingBrowser");
  return label;
}

export function friendlyDeviceLabel(userAgent: string): string {
  if (/iPad/i.test(userAgent)) return "iPad";
  if (/iPhone/i.test(userAgent)) return "iPhone";
  if (/Android/i.test(userAgent)) return t("device.android");
  if (/Windows/i.test(userAgent)) return t("device.windows");
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "Mac";
  if (/Linux/i.test(userAgent)) return t("device.linux");
  return t("device.browser");
}

export function shortDeviceId(deviceId: string): string {
  if (deviceId.length <= 16) return deviceId;
  return `${deviceId.slice(0, 8)}…${deviceId.slice(-4)}`;
}

export function visiblePairedDevices(devices: DeviceSummary[]): DeviceSummary[] {
  return devices
    .filter((device) => !device.revoked_at)
    .sort((left, right) => {
      if (!!left.self !== !!right.self) return left.self ? -1 : 1;
      if (!!left.connected !== !!right.connected) return left.connected ? -1 : 1;
      return (right.last_seen || 0) - (left.last_seen || 0);
    });
}

export function formatDeviceAge(timestamp: number | undefined, now = Math.floor(Date.now() / 1000)): string {
  if (!Number.isFinite(timestamp) || !timestamp || timestamp <= 0) return t("device.never");
  const seconds = Math.max(0, now - timestamp);
  if (seconds < 60) return t("device.justNow");
  if (seconds < 3_600) return t("device.minutesAgo", { n: Math.floor(seconds / 60) });
  if (seconds < 86_400) return t("device.hoursAgo", { n: Math.floor(seconds / 3_600) });
  if (seconds < 604_800) return t("device.daysAgo", { n: Math.floor(seconds / 86_400) });
  return new Intl.DateTimeFormat(locale(), { dateStyle: "medium" }).format(new Date(timestamp * 1_000));
}
