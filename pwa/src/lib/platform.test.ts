import { expect, test } from "bun:test";
import { nativePlatform, nativePushAvailable } from "./platform";

const bridge = { post: async () => undefined };

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
