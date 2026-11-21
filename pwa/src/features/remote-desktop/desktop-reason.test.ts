import { describe, expect, test } from "bun:test";
import { isAutoRetryableDesktopError, parseDesktopReason } from "./desktop-reason";

describe("parseDesktopReason", () => {
  test("recognizes kicked error code and strips optional [reason:...] prefix", () => {
    expect(parseDesktopReason("desktop session taken over by another window", "kicked")).toEqual({
      kind: "kicked",
      cleanMessage: "desktop session taken over by another window",
    });
    expect(parseDesktopReason("[reason:locked] desktop session taken over", "kicked")).toEqual({
      kind: "kicked",
      cleanMessage: "desktop session taken over",
    });
  });

  test("parses all structured [reason:...] prefixes case-insensitively and trims cleanMessage", () => {
    const cases = [
      ["locked", "[reason:locked] desktop session is closed", "desktop session is closed"],
      ["sleeping", "  [reason:sleeping] Mac is asleep  ", "Mac is asleep"],
      ["perm_screen", "[reason:perm_screen] Screen Recording not granted", "Screen Recording not granted"],
      ["perm_accessibility", "[reason:perm_accessibility] Accessibility not granted", "Accessibility not granted"],
      ["stopped_on_host", "[reason:stopped_on_host] user clicked stop", "user clicked stop"],
      ["display_unavailable", "[reason:display_unavailable] no active display", "no active display"],
      ["kicked", "[REASON:KICKED] replaced by newer session", "replaced by newer session"],
    ] as const;

    for (const [expectedKind, raw, expectedClean] of cases) {
      expect(parseDesktopReason(raw)).toEqual({
        kind: expectedKind,
        cleanMessage: expectedClean,
      });
    }
  });

  test("falls back to legacy English and Chinese messages when no structured prefix is present", () => {
    expect(parseDesktopReason("Mac screen locked")).toEqual({
      kind: "locked",
      cleanMessage: "Mac screen locked",
    });
    expect(parseDesktopReason("电脑已锁屏")).toEqual({
      kind: "locked",
      cleanMessage: "电脑已锁屏",
    });
    expect(parseDesktopReason("Host is sleeping")).toEqual({
      kind: "sleeping",
      cleanMessage: "Host is sleeping",
    });
    expect(parseDesktopReason("Screen Recording permission missing")).toEqual({
      kind: "perm_screen",
      cleanMessage: "Screen Recording permission missing",
    });
    expect(parseDesktopReason("Accessibility permission denied")).toEqual({
      kind: "perm_accessibility",
      cleanMessage: "Accessibility permission denied",
    });
    expect(parseDesktopReason("Display unavailable on host")).toEqual({
      kind: "display_unavailable",
      cleanMessage: "Display unavailable on host",
    });
    expect(parseDesktopReason("No active display found")).toEqual({
      kind: "display_unavailable",
      cleanMessage: "No active display found",
    });
    expect(parseDesktopReason("Desktop stopped on host")).toEqual({
      kind: "stopped_on_host",
      cleanMessage: "Desktop stopped on host",
    });
    expect(parseDesktopReason("Session taken over by another window")).toEqual({
      kind: "kicked",
      cleanMessage: "Session taken over by another window",
    });
  });

  test("returns kind null for unknown reason tags or generic transport errors", () => {
    expect(parseDesktopReason("[reason:unknown_tag] something happened")).toEqual({
      kind: null,
      cleanMessage: "something happened",
    });
    expect(parseDesktopReason("transient ICE timeout")).toEqual({
      kind: null,
      cleanMessage: "transient ICE timeout",
    });
  });
});

describe("isAutoRetryableDesktopError", () => {
  test("never auto-retries kicked, conflict, unsupported, invalid_argument, or structured reasons", () => {
    expect(isAutoRetryableDesktopError("desktop session taken over", "kicked")).toBeFalse();
    expect(isAutoRetryableDesktopError("the desktop is already in use", "conflict")).toBeFalse();
    expect(isAutoRetryableDesktopError("not supported", "unsupported")).toBeFalse();
    expect(isAutoRetryableDesktopError("bad params", "invalid_argument")).toBeFalse();

    const nonRetryableReasons = [
      "[reason:locked] desktop session is closed",
      "[reason:sleeping] Mac went to sleep",
      "[reason:perm_screen] Screen Recording missing",
      "[reason:perm_accessibility] Accessibility missing",
      "[reason:stopped_on_host] stopped",
      "[reason:display_unavailable] headless Mac",
    ];
    for (const msg of nonRetryableReasons) {
      expect(isAutoRetryableDesktopError(msg)).toBeFalse();
    }
  });

  test("blocks legacy non-retryable strings even without structured codes", () => {
    const legacy = [
      "Mac screen locked",
      "Host went to sleep",
      "permission denied",
      "Screen Recording disabled",
      "Accessibility revoked",
      "conflict with another client",
      "已被另一窗口接管",
      "缺少屏幕录制权限",
    ];
    for (const msg of legacy) {
      expect(isAutoRetryableDesktopError(msg)).toBeFalse();
    }
  });

  test("allows auto-retry for transient transport and ICE errors", () => {
    expect(isAutoRetryableDesktopError("Desktop disconnected. You can connect again.", "disconnected")).toBeTrue();
    expect(isAutoRetryableDesktopError("Desktop disconnected. You can connect again.", "failed")).toBeTrue();
    expect(isAutoRetryableDesktopError("transient timeout")).toBeTrue();
    expect(isAutoRetryableDesktopError("peer connection lost", "forbidden")).toBeTrue();
  });
});
