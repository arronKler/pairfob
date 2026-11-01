import { afterEach, describe, expect, test } from "bun:test";
import { newUUID } from "./ids";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const original = crypto.randomUUID;
afterEach(() => { (crypto as { randomUUID?: unknown }).randomUUID = original; });

describe("newUUID", () => {
  test("returns a lowercase v4 UUID without crypto.randomUUID", () => {
    (crypto as { randomUUID?: unknown }).randomUUID = undefined;
    const a = newUUID();
    expect(a).toMatch(V4);
    expect(newUUID()).not.toBe(a);
  });

  test("returns a lowercase v4 UUID with crypto.randomUUID", () => {
    expect(newUUID()).toMatch(V4);
  });
});
