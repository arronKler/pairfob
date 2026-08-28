import { describe, expect, test } from "bun:test";
import { IndexCore } from "./pairing-index.ts";

describe("pairing index persist", () => {
  test("writes and deletes one locator at a time", () => {
    const ops: string[] = [];
    const index = new IndexCore(new Map(), () => 1_000, {
      load: () => new Map(),
      put: (row) => ops.push("put:" + row.pair_loc),
      delete: (loc) => ops.push("del:" + loc),
    });
    const owner = { daemon_id: "d_" + "11".repeat(10), pair_ref: "11".repeat(16) };
    expect(index.insert({ pair_loc: "ABCDEF", ...owner, exp: 2_000 })).toBe("ok");
    expect(index.insert({ pair_loc: "ABCDEG", daemon_id: "d_" + "22".repeat(10), pair_ref: "22".repeat(16), exp: 2_000 })).toBe("ok");
    expect(ops).toEqual(["put:ABCDEF", "put:ABCDEG"]);
    index.remove("ABCDEF", owner);
    expect(ops).toEqual(["put:ABCDEF", "put:ABCDEG", "del:ABCDEF"]);
    index.now = () => 3_000;
    expect(index.lookup("ABCDEG")).toBeNull();
    expect(ops.at(-1)).toBe("del:ABCDEG");
  });
});
