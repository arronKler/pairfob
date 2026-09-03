import { describe, expect, test } from "bun:test";
import {
  emptySessionCopy,
  formatDeviceAge,
  friendlyDeviceLabel,
  notificationAction,
  pairErrorField,
  shortDeviceId,
  shouldForgetPairFragment,
  visiblePairedDevices,
} from "./ui-model";

describe("UI model", () => {
  test("maps pairing failures to the field that needs attention", () => {
    expect(pairErrorField("invalid_pair_code")).toBe("code");
    expect(pairErrorField("unpaired")).toBe("code");
    expect(pairErrorField("bad_pair_code")).toBe("code");
    expect(pairErrorField("locator_required")).toBe("code");
    expect(pairErrorField("timeout")).toBeNull();
  });

  test("forgets terminal QR credentials but keeps retryable transport failures", () => {
    expect(shouldForgetPairFragment("bad_pair_code")).toBeTrue();
    expect(shouldForgetPairFragment("pairing_replaced")).toBeTrue();
    expect(shouldForgetPairFragment("pairing_expired")).toBeTrue();
    expect(shouldForgetPairFragment("sas_required")).toBeTrue();
    expect(shouldForgetPairFragment("pairing_cancelled")).toBeTrue();
    expect(shouldForgetPairFragment("timeout")).toBeFalse();
  });

  test("uses coarse recognizable device labels instead of a full user agent", () => {
    expect(friendlyDeviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("iPhone");
    expect(friendlyDeviceLabel("Mozilla/5.0 (Linux; Android 15; Pixel 9)")).toBe("Android 手机");
    expect(friendlyDeviceLabel("unknown-client")).toBe("浏览器设备");
  });

  test("formats compact device ids and relative activity", () => {
    expect(shortDeviceId("dev_0123456789abcdef")).toBe("dev_0123…cdef");
    expect(formatDeviceAge(1_000, 1_020)).toBe("刚刚");
    expect(formatDeviceAge(1_000, 1_180)).toBe("3 分钟前");
    expect(formatDeviceAge(undefined, 1_180)).toBe("从未使用");
  });

  test("paired device list hides revoked rows and keeps this phone first", () => {
    const rows = visiblePairedDevices([
      { device_id: "dev_old", label: "Old", last_seen: 90, connected: false, revoked_at: 80 },
      { device_id: "dev_stale", label: "Stale", last_seen: 40, connected: false },
      { device_id: "dev_live", label: "Live", last_seen: 20, connected: true },
      { device_id: "dev_self", label: "Phone", self: true, last_seen: 10, connected: true },
    ]);
    expect(rows.map((device) => device.device_id)).toEqual(["dev_self", "dev_live", "dev_stale"]);
  });

  test("distinguishes an empty session list from an offline Herdr", () => {
    expect(emptySessionCopy("herdr", true, true)).toEqual({
      title: "还没有会话",
      detail: "可以新建一个会话，或在电脑上打开终端。",
    });
    expect(emptySessionCopy("offline", true, false)).toEqual({
      title: "还没有读到会话",
      detail: "电脑上的 Herdr 没有运行，打开后会自动恢复。",
    });
    expect(emptySessionCopy("herdr", false, true).title).toBe("正在重新连接");
  });

  test("empty copy never claims there are no sessions while unverifiable", () => {
    expect(emptySessionCopy("herdr", false, true)).toEqual({
      title: "正在重新连接",
      detail: "连接恢复后会自动更新会话列表。",
    });
    expect(emptySessionCopy("herdr", true, true, false).title).toBe("正在重新连接");
    expect(emptySessionCopy("offline", false, true).title).toBe("正在重新连接");
    expect(emptySessionCopy("", true, true)).toEqual({
      title: "无法确认会话",
      detail: "Herdr 暂未响应，恢复后会自动更新列表。",
    });
    expect(emptySessionCopy("something-new", true, false).title).toBe("无法确认会话");
  });

  test("notification action reflects this phone's subscription", () => {
    expect(notificationAction(true, false, true, false)).toEqual({ label: "打开通知", disabled: false });
    expect(notificationAction(true, true, true, false)).toEqual({ label: "通知已开启", disabled: true });
    expect(notificationAction(true, null, true, false)).toEqual({ label: "重试开启通知", disabled: false });
    expect(notificationAction(false, false, true, false)).toEqual({ label: "电脑端未开启", disabled: true });
    expect(notificationAction(true, false, false, false)).toEqual({ label: "当前浏览器不支持", disabled: true });
    expect(notificationAction(true, true, true, true)).toEqual({ label: "正在读取状态…", disabled: true });
  });
});
