import { locale, t } from "./i18n.ts";

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

export type EmptySessionCopy = { title: string; detail: string };
export type NotificationAction = { label: string; disabled: boolean };

export function pairErrorField(code: string): PairErrorField {
  if (["locator_required", "invalid_pair_code", "bad_pair_code", "unpaired"].includes(code)) return "code";
  return null;
}

export function shouldForgetPairFragment(code: string): boolean {
  return ["unpaired", "bad_pair_code", "pairing_replaced", "pairing_expired", "fp_mismatch", "bad_relay", "sas_required", "pairing_cancelled", "revoked"].includes(code);
}

export function emptySessionCopy(runtimeKind: string, connected: boolean, canCreate: boolean): EmptySessionCopy {
  if (!connected) {
    return { title: t("empty.reconnectingTitle"), detail: t("empty.reconnectingDetail") };
  }
  if (runtimeKind === "offline") {
    return { title: t("empty.offlineTitle"), detail: t("empty.offlineDetail") };
  }
  return {
    title: t("empty.noneTitle"),
    detail: canCreate ? t("empty.noneCreate") : t("empty.noneOpen"),
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

export function formatDeviceAge(timestamp: number | undefined, now = Math.floor(Date.now() / 1000)): string {
  if (!Number.isFinite(timestamp) || !timestamp || timestamp <= 0) return t("device.never");
  const seconds = Math.max(0, now - timestamp);
  if (seconds < 60) return t("device.justNow");
  if (seconds < 3_600) return t("device.minutesAgo", { n: Math.floor(seconds / 60) });
  if (seconds < 86_400) return t("device.hoursAgo", { n: Math.floor(seconds / 3_600) });
  if (seconds < 604_800) return t("device.daysAgo", { n: Math.floor(seconds / 86_400) });
  return new Intl.DateTimeFormat(locale(), { dateStyle: "medium" }).format(new Date(timestamp * 1_000));
}
