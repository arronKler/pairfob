import { describe, expect, test } from "bun:test";
import { truncateUTF8Bytes, utf8ByteLength } from "./text-budget";

describe("UTF-8 text budgets", () => {
  test("counts ASCII, CJK, emoji, and isolated surrogates like TextEncoder", () => {
    for (const value of ["plain", "会话", "a😀b", "\ud800"]) {
      expect(utf8ByteLength(value)).toBe(new TextEncoder().encode(value).length);
    }
  });

  test("truncates on code-point boundaries", () => {
    expect(truncateUTF8Bytes("a会😀b", 1)).toBe("a");
    expect(truncateUTF8Bytes("a会😀b", 4)).toBe("a会");
    expect(truncateUTF8Bytes("a会😀b", 8)).toBe("a会😀");
    expect(truncateUTF8Bytes("a会😀b", 9)).toBe("a会😀b");
    expect(utf8ByteLength(truncateUTF8Bytes("犬".repeat(20_000), 32_768))).toBeLessThanOrEqual(32_768);
  });
});
