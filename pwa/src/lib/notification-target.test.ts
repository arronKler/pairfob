import { describe, expect, test } from "bun:test";
import { parseNotificationTarget, resolveNotificationTarget } from "./notification-target.ts";

describe("notification deep links", () => {
  test("accepts one exact daemon and pane target", () => {
    expect(parseNotificationTarget("#d=d_0123456789abcdefabcd&notify=1&pane=w0%3Ap1")).toEqual({
      daemonId: "d_0123456789abcdefabcd",
      paneId: "w0:p1",
    });
  });

  test("rejects malformed, duplicated, and extra fields", () => {
    expect(parseNotificationTarget("#notify=1&d=bad&pane=w0:p1")).toBeNull();
    expect(parseNotificationTarget("#notify=1&d=d_0123456789abcdefabcd&pane=/private/path")).toBeNull();
    expect(parseNotificationTarget("#notify=1&notify=1&d=d_0123456789abcdefabcd&pane=w0:p1")).toBeNull();
    expect(parseNotificationTarget("#notify=1&d=d_0123456789abcdefabcd&pane=w0:p1&url=https://evil.example")).toBeNull();
  });

  test("does not confuse pairing fragments with notification targets", () => {
    expect(parseNotificationTarget("#v=2&d=d_0123456789abcdefabcd&r=4f7a2c9e1b0d88aa55cc3311abde7001&c=7K3M9H2P")).toBeNull();
  });

  test("waits for the right computer and opens only a live pane", () => {
    const target = { daemonId: "d_0123456789abcdefabcd", paneId: "w0:p1" };
    expect(resolveNotificationTarget(target, "d_aaaaaaaaaaaaaaaaaaaa", ["w0:p1"])).toEqual({ kind: "wait" });
    expect(resolveNotificationTarget(target, target.daemonId, ["w0:p2"])).toEqual({ kind: "missing" });
    expect(resolveNotificationTarget(target, target.daemonId, ["w0:p1"])).toEqual({ kind: "open", paneId: "w0:p1" });
  });
});
