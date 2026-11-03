import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cacheKey } from "./verify-cache.ts";

const CLI = join(import.meta.dir, "verify-cache.ts");

function write(root: string, path: string, body: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "pairfob-verify-cache-"));
  write(root, "pwa/src/a.test.ts", "test('a', () => {});");
  write(root, "pwa/bun.lock", "lock");
  write(root, "proto/pairfob-vectors.json", "{}");
  write(root, "scripts/pwa-test-shard.ts", "// shard");
  write(root, "scripts/pwa-test-timings.json", "{}");
  write(root, ".bun-version", "1.4.3");
  return root;
}

function gitFixture(): string {
  const root = fixture();
  const run = (...args: string[]): void => {
    execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  };
  run("init", "-q");
  run("add", "-A");
  run("-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-qm", "init");
  return root;
}

function cli(cache: string, args: string[]): number | null {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, PAIRFOB_VERIFY_CACHE_DIR: cache },
  }).status;
}

describe("verification cache key", () => {
  test("an unchanged tree hashes the same on every run", () => {
    const root = fixture();
    try {
      expect(cacheKey("pwa-tests", "0/1", root)).toBe(cacheKey("pwa-tests", "0/1", root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a changed test file misses", () => {
    const root = fixture();
    try {
      const before = cacheKey("pwa-tests", "0/1", root);
      write(root, "pwa/src/a.test.ts", "test('a', () => { throw new Error('changed'); });");
      expect(cacheKey("pwa-tests", "0/1", root)).not.toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a changed dependency lock misses", () => {
    const root = fixture();
    try {
      const before = cacheKey("pwa-tests", "0/1", root);
      write(root, "pwa/bun.lock", "lock with another dependency");
      expect(cacheKey("pwa-tests", "0/1", root)).not.toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a different shard identity misses", () => {
    const root = fixture();
    try {
      expect(cacheKey("pwa-tests", "0/2", root)).not.toBe(cacheKey("pwa-tests", "1/2", root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an uncommitted edit and an untracked file both miss", () => {
    const root = gitFixture();
    try {
      const before = cacheKey("pwa-tests", "0/1", root);
      write(root, "pwa/src/a.test.ts", "test('a', () => { throw new Error('changed'); });");
      const edited = cacheKey("pwa-tests", "0/1", root);
      expect(edited).not.toBe(before);
      write(root, "pwa/src/b.test.ts", "test('b', () => {});");
      expect(cacheKey("pwa-tests", "0/1", root)).not.toBe(edited);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  test("a commit that changes nothing keeps the key", () => {
    const root = gitFixture();
    try {
      const before = cacheKey("pwa-tests", "0/1", root);
      execFileSync("git", [
        "-C", root, "-c", "user.email=test@example.com", "-c", "user.name=test",
        "commit", "--allow-empty", "-qm", "empty",
      ], { stdio: "ignore" });
      expect(cacheKey("pwa-tests", "0/1", root)).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  test("a changed locale environment misses", () => {
    const root = fixture();
    const before = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      const utc = cacheKey("pwa-tests", "0/1", root);
      process.env.TZ = "Asia/Shanghai";
      expect(cacheKey("pwa-tests", "0/1", root)).not.toBe(utc);
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("only a stored pass is reported as a hit", () => {
    const dir = mkdtempSync(join(tmpdir(), "pairfob-verify-cache-cli-"));
    try {
      const key = spawnSync(process.execPath, [CLI, "key", "pwa-tests", "0/1"], {
        encoding: "utf8",
        env: { ...process.env, PAIRFOB_VERIFY_CACHE_DIR: dir },
      }).stdout.trim();
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(cli(dir, ["hit", "pwa-tests", "0/1", key])).toBe(1);
      expect(cli(dir, ["store", "pwa-tests", "0/1", key])).toBe(0);
      expect(cli(dir, ["hit", "pwa-tests", "0/1", key])).toBe(0);
      expect(cli(dir, ["hit", "pwa-tests", "0/1", "0".repeat(64)])).toBe(1);
      expect(cli(dir, ["hit", "pwa-tests", "1/2", key])).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});