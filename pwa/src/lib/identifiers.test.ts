import { describe, expect, test } from "bun:test";
import { validDaemonId, validDeviceId } from "./identifiers.ts";

describe("production identifiers", () => {
  test("accepts only the frozen daemon schema", () => {
    expect(validDaemonId("d_0123456789abcdefabcd")).toBe(true);
    expect(validDaemonId("d_0123456789ABCDEFabcd")).toBe(false);
    expect(validDaemonId("d_short")).toBe(false);
    expect(validDaemonId(`d_${"a".repeat(21)}`)).toBe(false);
  });

  test("accepts bounded URL-safe device ids", () => {
    expect(validDeviceId("dev_12345678")).toBe(true);
    expect(validDeviceId("dev_phone-A_1")).toBe(true);
    expect(validDeviceId("dev_short")).toBe(false);
    expect(validDeviceId(`dev_${"a".repeat(129)}`)).toBe(false);
    expect(validDeviceId("dev_bad/device")).toBe(false);
  });
});
