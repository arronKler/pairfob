import { describe, expect, test } from "bun:test";
import { cloneData, freezeData } from "./immutable";

function withOwnKey(base: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  Object.defineProperty(base, key, { value, enumerable: true, configurable: true, writable: true });
  return base;
}

function ownValue(object: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(object, key)?.value;
}

describe("workspace freezeData", () => {
  test("preserves own __proto__, constructor, and prototype keys without changing Object.prototype", () => {
    const protoBefore = Object.getOwnPropertyNames(Object.prototype);
    const filesBefore = Object.hasOwn(Object.prototype, "files");
    const input = withOwnKey(
      withOwnKey(withOwnKey({ safe: 1 }, "__proto__", { files: true }), "constructor", { name: "x" }),
      "prototype",
      { y: 2 },
    );
    const frozen = freezeData(input);
    const compat = cloneData(frozen);

    for (const copy of [frozen, compat]) {
      expect(Object.getPrototypeOf(copy)).toBeNull();
      expect(Object.hasOwn(copy, "__proto__")).toBeTrue();
      expect(Object.hasOwn(copy, "constructor")).toBeTrue();
      expect(Object.hasOwn(copy, "prototype")).toBeTrue();
      expect(copy.safe).toBe(1);
      expect((ownValue(copy, "__proto__") as { files: boolean }).files).toBeTrue();
      expect((ownValue(copy, "constructor") as { name: string }).name).toBe("x");
      expect((ownValue(copy, "prototype") as { y: number }).y).toBe(2);
      expect((copy as { files?: boolean }).files).toBeUndefined();
    }

    expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(protoBefore);
    expect(Object.hasOwn(Object.prototype, "files")).toBe(filesBefore);
  });
});
