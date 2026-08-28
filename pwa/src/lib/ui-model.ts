export type PairErrorField = "code" | null;

/** User-facing names for the three pane views. Internal ids stay guided / full / agent. */
export const TERM_MODE_LABEL = {
  guided: "控制",
  full: "终端",
  agent: "对话",
} as const;

/** Session-menu labels. 终端 is not “make this pane taller”. */
export const TERM_MODE_MENU = {
  guided: TERM_MODE_LABEL.guided,
  full: "终端（vim / TUI）",
  agent: TERM_MODE_LABEL.agent,
} as const;

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
    return { title: "正在重新连接", detail: "连接恢复后会自动更新会话列表。" };
  }
  if (runtimeKind === "offline") {
    return { title: "还没有读到会话", detail: "电脑上的 Herdr 没有运行，打开后会自动恢复。" };
  }
  return {
    title: "还没有会话",
    detail: canCreate ? "可以新建一个会话，或在电脑上打开终端。" : "请在电脑上打开一个 Herdr 会话。",
  };
}

export function notificationAction(
  pushEnabled: boolean | null,
  pushSubscribed: boolean | null,
  supported: boolean,
  loading: boolean,
): NotificationAction {
  if (loading) return { label: "正在读取状态…", disabled: true };
  if (!supported) return { label: "当前浏览器不支持", disabled: true };
  if (pushEnabled === false) return { label: "电脑端未开启", disabled: true };
  if (pushEnabled === null) return { label: "通知状态未知", disabled: true };
  if (pushSubscribed === true) return { label: "通知已开启", disabled: true };
  if (pushSubscribed === false) return { label: "打开通知", disabled: false };
  return { label: "重试开启通知", disabled: false };
}

export function friendlyDeviceLabel(userAgent: string): string {
  if (/iPad/i.test(userAgent)) return "iPad";
  if (/iPhone/i.test(userAgent)) return "iPhone";
  if (/Android/i.test(userAgent)) return "Android 手机";
  if (/Windows/i.test(userAgent)) return "Windows 设备";
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "Mac";
  if (/Linux/i.test(userAgent)) return "Linux 设备";
  return "浏览器设备";
}

export function shortDeviceId(deviceId: string): string {
  if (deviceId.length <= 16) return deviceId;
  return `${deviceId.slice(0, 8)}…${deviceId.slice(-4)}`;
}

export function formatDeviceAge(timestamp: number | undefined, now = Math.floor(Date.now() / 1000)): string {
  if (!Number.isFinite(timestamp) || !timestamp || timestamp <= 0) return "从未使用";
  const seconds = Math.max(0, now - timestamp);
  if (seconds < 60) return "刚刚";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)} 小时前`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)} 天前`;
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(timestamp * 1_000));
}
