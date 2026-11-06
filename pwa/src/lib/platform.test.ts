import { expect, test } from "bun:test";
import { nativePlatform, nativePlatformKind, nativePushAvailable } from "./platform";

const bridge = { post: async () => undefined };

function withAgent<T>(agent: string, maxTouchPoints: number, run: () => T): T {
  const userAgent = Object.getOwnPropertyDescriptor(navigator, "userAgent");
  const touches = Object.getOwnPropertyDescriptor(navigator, "maxTouchPoints");
  Object.defineProperty(navigator, "userAgent", { configurable: true, get: () => agent });
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, get: () => maxTouchPoints });
  try {
    return run();
  } finally {
    if (userAgent) Object.defineProperty(navigator, "userAgent", userAgent);
    else delete (navigator as unknown as Record<string, unknown>).userAgent;
    if (touches) Object.defineProperty(navigator, "maxTouchPoints", touches);
    else delete (navigator as unknown as Record<string, unknown>).maxTouchPoints;
  }
}

test("an iPhone or a touch iPad reads as iOS and an Android agent does not", () => {
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  expect(withAgent(iphone, 5, nativePlatformKind)).toBe("ios");
  // An iPad can present the desktop Macintosh agent; the touch count is what
  // still marks it as iOS.
  const macLike = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
  expect(withAgent(macLike, 5, nativePlatformKind)).toBe("ios");
  expect(withAgent(macLike, 0, nativePlatformKind)).toBe("android");
  const android = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
  expect(withAgent(android, 5, nativePlatformKind)).toBe("android");
});

test("a native shell with the notification bridge advertises the local channel", () => {
  const platform = nativePlatform(true, bridge);
  expect(platform?.pushChannels).toEqual(["local"]);
  expect(nativePushAvailable(platform)).toBeTrue();
});

test("a native shell without the bridge keeps an honest empty channel list", () => {
  const platform = nativePlatform(true, null);
  expect(platform?.pushChannels).toEqual([]);
  expect(nativePushAvailable(platform)).toBeFalse();
});

test("the hosted web build never reports a native platform", () => {
  expect(nativePlatform(false, bridge)).toBeNull();
  expect(nativePushAvailable(nativePlatform(false, bridge))).toBeFalse();
});
