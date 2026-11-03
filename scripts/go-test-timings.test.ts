import { describe, expect, test } from "bun:test";
import { collectTimings, mergeTimings } from "./go-test-timings.ts";

describe("Go test timing manifest", () => {
  test("keeps top-level tests, named cases and package totals", () => {
    const timings = collectTimings([
      { Action: "run", Package: "p", Test: "TestSlow" },
      { Action: "pass", Package: "p", Test: "TestSlow", Elapsed: 1.25 },
      { Action: "pass", Package: "p", Test: "TestSlow/case", Elapsed: 1.2 },
      { Action: "pass", Package: "p", Test: "TestFast", Elapsed: 0.01 },
      { Action: "pass", Package: "p", Elapsed: 2.5 },
      { Action: "fail", Package: "p", Test: "TestBroken", Elapsed: 0.9 },
    ]);
    expect(timings.tests).toEqual({
      "p::TestFast": 10,
      "p::TestSlow": 1250,
      "p::TestSlow/case": 1200,
    });
    expect(timings.packages).toEqual({ p: 2500 });
  });

  test("a later longer run replaces a shorter measurement", () => {
    const timings = collectTimings([
      { Action: "pass", Package: "p", Test: "TestA", Elapsed: 0.1 },
      { Action: "pass", Package: "p", Test: "TestA", Elapsed: 0.4 },
    ]);
    expect(timings.tests["p::TestA"]).toBe(400);
  });

  test("the minimum keeps only entries worth balancing around", () => {
    const timings = collectTimings([
      { Action: "pass", Package: "p", Test: "TestSlow", Elapsed: 1.25 },
      { Action: "pass", Package: "p", Test: "TestFast", Elapsed: 0.01 },
      { Action: "pass", Package: "p", Elapsed: 0.2 },
      { Action: "pass", Package: "q", Elapsed: 2.5 },
    ], 500);
    expect(timings.tests).toEqual({ "p::TestSlow": 1250 });
    expect(timings.packages).toEqual({ q: 2500 });
  });

  test("merging one mode preserves the other mode and the subtest list", () => {
    const base = {
      version: 1,
      tests: { "p::TestA": 100 },
      packages: { p: 200 },
      subtests: { "p::TestBig": ["small", "large"] },
    };
    const merged = mergeTimings(base, "race", { version: 1, tests: { "p::TestA": 900 }, packages: { p: 1000 } });
    expect(merged).toEqual({
      version: 1,
      tests: { "p::TestA": 100 },
      packages: { p: 200 },
      subtests: { "p::TestBig": ["small", "large"] },
      raceTests: { "p::TestA": 900 },
      racePackages: { p: 1000 },
    });
  });

  test("a partial run keeps measurements it did not cover", () => {
    const base = { version: 1, tests: { "p::Old": 700, "p::Shrunk": 900 }, packages: { p: 1200 } };
    const merged = mergeTimings(base, "test", { version: 1, tests: { "p::New": 500, "p::Shrunk": 400 }, packages: {} });
    expect(merged.tests).toEqual({ "p::New": 500, "p::Old": 700, "p::Shrunk": 900 });
    expect(merged.packages).toEqual({ p: 1200 });
  });
});