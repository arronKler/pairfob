import { describe, expect, test } from "bun:test";
import { CROCKFORD, locShard, mintLoc, normalizeLoc } from "./crockford.ts";

describe("crockford loc", () => {
  test("alphabet has 32 symbols and omits I L O U", () => {
    expect(CROCKFORD).toBe("0123456789ABCDEFGHJKMNPQRSTVWXYZ");
    expect(CROCKFORD).toHaveLength(32);
    expect(CROCKFORD.includes("I")).toBe(false);
    expect(CROCKFORD.includes("L")).toBe(false);
    expect(CROCKFORD.includes("O")).toBe(false);
    expect(CROCKFORD.includes("U")).toBe(false);
  });

  test("normalizes I/L→1 O→0 U→V, case, and whitespace", () => {
    expect(normalizeLoc("wj3k9m")).toBe("WJ3K9M");
    expect(normalizeLoc("  ilouxx ")).toBe("110VXX");
    expect(normalizeLoc("WJ3K9")).toBeNull();
    expect(normalizeLoc("WJ3K9M!")).toBeNull();
  });

  test("shard is first two normalized chars", () => {
    expect(locShard("WJ3K9M")).toBe("WJ");
  });

  test("mintLoc draws from the alphabet", () => {
    const loc = mintLoc((n) => new Uint8Array(n).fill(7));
    expect(loc).toHaveLength(6);
    for (const c of loc) expect(CROCKFORD.includes(c)).toBe(true);
  });
});
