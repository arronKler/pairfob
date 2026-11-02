import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pwaTestFiles, shardTestFiles } from "./pwa-test-shard.ts";

const PWA = fileURLToPath(new URL("../pwa", import.meta.url));
const CLI = fileURLToPath(new URL("./pwa-test-shard.ts", import.meta.url));
const SHARDS = 8;

function weight(files: string[]): number {
  return files.reduce((total, file) => total + statSync(join(PWA, file)).size, 0);
}

describe("PWA test shards", () => {
  test("every test file lands in exactly one shard", () => {
    const all = pwaTestFiles(PWA);
    expect(all.length).toBeGreaterThan(500);
    const assigned = Array.from({ length: SHARDS }, (_, index) => shardTestFiles(PWA, index, SHARDS)).flat();
    expect(assigned).toHaveLength(all.length);
    expect(new Set(assigned).size).toBe(all.length);
    expect(assigned.slice().sort()).toEqual(all.slice());
  });

  test("the heaviest and lightest shards stay close by file size", () => {
    const loads = Array.from({ length: SHARDS }, (_, index) => weight(shardTestFiles(PWA, index, SHARDS)));
    const average = loads.reduce((total, load) => total + load, 0) / SHARDS;
    expect(Math.max(...loads)).toBeLessThanOrEqual(average * 1.5);
    expect(Math.min(...loads)).toBeGreaterThan(average * 0.5);
  });

  test("the same shard is stable across runs", () => {
    expect(shardTestFiles(PWA, 3, SHARDS)).toEqual(shardTestFiles(PWA, 3, SHARDS));
  });

  test("the CLI prints the files for one shard", () => {
    const output = execFileSync(process.execPath, [CLI, "0", String(SHARDS)], { cwd: PWA, encoding: "utf8" });
    const files = output.trimEnd().split("\n").filter(Boolean);
    expect(files).toEqual(shardTestFiles(PWA, 0, SHARDS));
  });

  test("a missing or out-of-range shard fails instead of printing every file", () => {
    expect(() => execFileSync(process.execPath, [CLI, String(SHARDS), String(SHARDS)], { cwd: PWA, stdio: "pipe" })).toThrow();
    expect(() => shardTestFiles(PWA, -1, SHARDS)).toThrow();
    expect(() => shardTestFiles(PWA, 0, 0)).toThrow();
  });
});
