import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  binaryCommands,
  binaryPath,
  coverageUnits,
  declaredTests,
  inventoryUnits,
  planShard,
  runExpression,
  shardCommands,
  shardUnits,
  skipExpression,
  subtestNames,
  testFileModes,
  type GoInventory,
  type GoTestUnit,
  type GoTestWeights,
} from "./go-test-shard.ts";

const CLI = fileURLToPath(new URL("./go-test-shard.ts", import.meta.url));

function unit(pkg: string, tests: string[] | null, weight: number): GoTestUnit {
  return { pkg, tests, weight };
}

describe("Go test inventory", () => {
  test("reads test, example and fuzz declarations and skips TestMain", () => {
    const dir = mkdtempSync(join(tmpdir(), "pairfob-go-tests-"));
    try {
      writeFileSync(join(dir, "a_test.go"), [
        "package a",
        "func TestAlpha(t *testing.T) {}",
        "func TestMain(m *testing.M) {}",
        "func helper(t *testing.T) {}",
        "func ExampleBeta() {}",
        "func FuzzGamma(f *testing.F) {}",
      ].join("\n"));
      writeFileSync(join(dir, "b_test.go"), "package a_test\nfunc TestDelta(t *testing.T) {}\n");
      expect(declaredTests(dir, ["a_test.go", "b_test.go"])).toEqual([
        "TestAlpha", "ExampleBeta", "FuzzGamma", "TestDelta",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a package is split only when it is large enough", () => {
    const inventory: GoInventory = {
      version: 1,
      packages: [
        { path: "small", files: 2, tests: null },
        { path: "large", files: 20, tests: ["TestA", "TestB"] },
      ],
    };
    const units = inventoryUnits(inventory, { version: 1 });
    expect(units.filter((item) => item.pkg === "small")).toHaveLength(1);
    expect(units.filter((item) => item.pkg === "large").map((item) => item.tests)).toEqual([["TestA"], ["TestB"]]);
  });
});

describe("Go test shards", () => {
  const weights: GoTestWeights = {
    version: 1,
    tests: {
      "daemon::TestSlow": 9000,
      "daemon::TestFast": 100,
      "daemon::TestMedium": 2000,
    },
    packages: { "small": 500 },
  };
  const inventory: GoInventory = {
    version: 1,
    packages: [
      { path: "small", files: 1, tests: null },
      { path: "daemon", files: 10, tests: ["TestSlow", "TestFast", "TestMedium"] },
    ],
  };

  test("every test lands in exactly one shard", () => {
    const units = inventoryUnits(inventory, weights);
    const assigned = shardUnits(units, 3).flat();
    expect(assigned).toHaveLength(units.length);
    expect(new Set(assigned.map((item) => `${item.pkg}::${item.tests?.[0] ?? "whole"}`)).size).toBe(units.length);
  });

  test("the slowest test gets its own shard instead of trailing a fast package", () => {
    const buckets = shardUnits(inventoryUnits(inventory, weights), 3);
    const slow = buckets.find((bucket) => bucket.some((item) => item.tests?.[0] === "TestSlow"));
    expect(slow).toHaveLength(1);
    expect(slow?.[0].tests).toEqual(["TestSlow"]);
  });

  test("a listed table test is split into its named cases plus a remainder", () => {
    const weighted: GoTestWeights = {
      version: 1,
      subtests: { "daemon::TestBig": ["small", "large"] },
      tests: { "daemon::TestBig/large": 9000 },
    };
    const units = inventoryUnits({
      version: 1,
      packages: [{ path: "daemon", files: 10, tests: ["TestBig"] }],
    }, weighted);
    expect(units.map((item) => item.tests)).toEqual([["TestBig/small"], ["TestBig/large"], ["TestBig"]]);
    expect(units[1].weight).toBeGreaterThan(units[0].weight);
    expect(units[2].skip).toEqual(["small", "large"]);
    expect(units[2].weight).toBe(0);
  });

  test("subtest cases are deduplicated and nested cases fall under their parent", () => {
    expect(subtestNames(["a", "a", "a/b", "c"])).toEqual(["a", "c"]);
  });

  test("race measurements drive the race plan instead of the test measurements", () => {
    const weighted: GoTestWeights = {
      version: 1,
      tests: { "daemon::TestX": 100 },
      raceTests: { "daemon::TestX": 9000 },
      packages: { small: 500 },
      racePackages: { small: 8000 },
    };
    const inventory: GoInventory = {
      version: 1,
      packages: [
        { path: "small", files: 1, tests: null },
        { path: "daemon", files: 10, tests: ["TestX"] },
      ],
    };
    const testUnits = inventoryUnits(inventory, weighted);
    const raceUnits = inventoryUnits(inventory, weighted, "race");
    expect(testUnits[0].weight).toBe(500);
    expect(testUnits[1].weight).toBe(250);
    expect(raceUnits[0].weight).toBe(8000);
    expect(raceUnits[1].weight).toBe(9150);
  });

  test("a subtest gets its own anchored expression rather than a cross product", () => {
    expect(runExpression(["TestBig/large"])).toBe("^TestBig$/^large$");
    expect(runExpression(["TestA", "TestB"])).toBe("^(TestA|TestB)$");
    expect(runExpression(["TestA (v2)"])).toBe("^(TestA \\(v2\\))$");
    const commands = shardCommands([unit("daemon", ["TestBig/large"], 9000)], "test");
    expect(commands).toHaveLength(1);
    expect(commands[0].args.slice(-3)).toEqual(["-run", "^TestBig$/^large$", "daemon"]);
    const remainder = shardCommands([{ pkg: "daemon", tests: ["TestBig"], skip: ["small", "large"], weight: 0 }], "test");
    expect(remainder[0].args).toEqual(["-vet=off", "-timeout", "20m", "-p", "1", "-run", "^(TestBig)$", "-skip", "^TestBig$/^(small|large)$", "daemon"]);
    expect(skipExpression("TestBig", ["small", "large"])).toBe("^TestBig$/^(small|large)$");
  });

  test("commands coalesce a shard's tests per package and keep whole packages together", () => {
    const units = [
      unit("small", null, 500),
      unit("other", null, 500),
      unit("daemon", ["TestA"], 1000),
      unit("daemon", ["TestB"], 1000),
    ];
    const commands = shardCommands(units, "race");
    expect(commands).toHaveLength(2);
    expect(commands[0].args).toEqual(["-race", "-vet=off", "-timeout", "20m", "-p", "1", "small", "other"]);
    expect(commands[1].args.slice(-3)).toEqual(["-run", runExpression(["TestA", "TestB"]), "daemon"]);
  });

  test("prebuilt binary runs keep whole packages apart and group split tests", () => {
    const units: GoTestUnit[] = [
      { pkg: "small", tests: null, weight: 500, mode: "test" },
      { pkg: "other", tests: null, weight: 500, mode: "test" },
      { pkg: "daemon", tests: ["TestA"], weight: 1000, mode: "test" },
      { pkg: "daemon", tests: ["TestB"], weight: 1000, mode: "test" },
      { pkg: "daemon", tests: ["TestBig/large"], weight: 9000, mode: "race" },
    ];
    expect(binaryCommands(units, "test")).toEqual([
      { pkg: "daemon", tests: ["TestBig/large"], mode: "race" },
      { pkg: "small", tests: null, mode: "test" },
      { pkg: "other", tests: null, mode: "test" },
      { pkg: "daemon", tests: ["TestA", "TestB"], mode: "test" },
    ]);
  });

  test("binary paths mirror the import path so packages cannot collide", () => {
    expect(binaryPath("/bins", "pairfob/internal/daemon", "race")).toBe("/bins/pairfob/internal/daemon/race.test");
    expect(binaryPath("/bins", "pairfob/internal/daemon", "test")).not.toBe(binaryPath("/bins", "pairfob/internal/daemon", "race"));
  });

  test("a binary remainder carries its skipped cases", () => {
    const commands = binaryCommands([{ pkg: "daemon", tests: ["TestBig"], skip: ["small", "large"], weight: 0, mode: "race" }], "test");
    expect(commands).toEqual([{ pkg: "daemon", tests: ["TestBig"], skip: ["small", "large"], mode: "race" }]);
  });

  test("the same test files in both builds run once, under race", () => {
    expect(testFileModes(["a_test.go"], ["a_test.go"])).toEqual(["race"]);
    expect(testFileModes(["a_test.go"], ["a_test.go", "race_test.go"])).toEqual(["test", "race"]);
    expect(testFileModes(null, ["race_test.go"])).toEqual(["race"]);
    expect(testFileModes(["plain_test.go"], null)).toEqual(["test"]);
    expect(testFileModes(null, null)).toEqual([]);
  });

  test("a coverage plan keeps the ordinary build only where the test files differ", () => {
    const weighted: GoTestWeights = {
      version: 1,
      tests: { "daemon::TestA": 100, "daemon::TestB": 100 },
      raceTests: { "daemon::TestA": 900, "daemon::TestB": 900 },
      packages: { small: 100 },
      racePackages: { small: 900 },
    };
    const inventory: GoInventory = {
      version: 1,
      packages: [
        { path: "small", files: 1, tests: null, modes: ["race"] },
        { path: "daemon", files: 10, tests: ["TestA", "TestB"], modes: ["test", "race"] },
      ],
    };
    const units = planShard(inventory, weighted, 0, 1, "coverage");
    expect(units).toHaveLength(5);
    expect(units.filter((item) => item.mode === "race")).toHaveLength(3);
    expect(units.filter((item) => item.mode === "test")).toHaveLength(2);
    const commands = shardCommands(units, "race");
    expect(commands).toHaveLength(3);
    expect(commands[0].mode).toBe("race");
    expect(commands[0].args[0]).toBe("-race");
    expect(commands.at(-1)?.args[0]).toBe("-vet=off");
  });

  test("a plain package contributes no ordinary unit, so it is not run twice", () => {
    const inventory: GoInventory = {
      version: 1,
      packages: [{ path: "plain", files: 1, tests: null, modes: ["race"] }],
    };
    expect(inventoryUnits(inventory, weights, "test")).toHaveLength(0);
    expect(inventoryUnits(inventory, weights, "race")).toHaveLength(1);
    expect(coverageUnits(inventory, weights)).toHaveLength(1);
  });

  test("a shard index outside the plan fails instead of silently running everything", () => {
    expect(() => planShard(inventory, weights, 2, 2)).toThrow();
    expect(() => planShard(inventory, weights, -1, 2)).toThrow();
    expect(() => shardUnits([], 0)).toThrow();
  });

  test("an empty shard is reported without an error", () => {
    const dir = mkdtempSync(join(tmpdir(), "pairfob-go-shard-"));
    try {
      const inventoryPath = join(dir, "inventory.json");
      writeFileSync(inventoryPath, JSON.stringify({
        version: 1,
        packages: [{ path: "only", files: 1, tests: null }],
      }));
      const output = execFileSync(process.execPath, [
        CLI, "--shard", "1/2", "--mode", "test", "--inventory", inventoryPath,
      ], { encoding: "utf8", stdio: "pipe" }).trim();
      expect(output).toContain("is empty");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an inventory with no packages fails instead of passing every shard", () => {
    const dir = mkdtempSync(join(tmpdir(), "pairfob-go-shard-"));
    try {
      const inventoryPath = join(dir, "inventory.json");
      writeFileSync(inventoryPath, JSON.stringify({ version: 1, packages: [] }));
      const result = spawnSync(process.execPath, [
        CLI, "--plan", "0/1", "--mode", "test", "--inventory", inventoryPath,
      ], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("has no test packages");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});