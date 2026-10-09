import { describe, expect, test } from "bun:test";
import { deviceKind } from "./this-device";

const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  androidPhone: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  androidTablet: "Mozilla/5.0 (Linux; Android 15; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
};

describe("the kind of device this browser runs on", () => {
  test("phones, tablets and computer browsers are told apart", () => {
    expect(deviceKind(UA.iphone, 5)).toBe("phone");
    expect(deviceKind(UA.androidPhone, 5)).toBe("phone");
    expect(deviceKind(UA.ipad, 5)).toBe("tablet");
    expect(deviceKind(UA.androidTablet, 5)).toBe("tablet");
    expect(deviceKind(UA.mac, 0)).toBe("computer");
    expect(deviceKind(UA.windows, 0)).toBe("computer");
    expect(deviceKind(UA.linux, 0)).toBe("computer");
  });

  test("an iPad that presents a Mac user agent is still a tablet", () => {
    expect(deviceKind(UA.mac, 5)).toBe("tablet");
  });

  test("a touch-screen Windows laptop stays a computer", () => {
    expect(deviceKind(UA.windows, 10)).toBe("computer");
  });
});
