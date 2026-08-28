import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const guard = new URL("./ship-guard.sh", import.meta.url).pathname;

function run(body: string, env: Record<string, string> = {}): { exit: number; stderr: string } {
  const proc = Bun.spawnSync(["bash", "-c", `set -euo pipefail; . "$GUARD"; ${body}`], {
    env: { ...process.env, ...env, GUARD: guard },
    stderr: "pipe",
    stdout: "pipe",
  });
  return { exit: proc.exitCode ?? 1, stderr: proc.stderr.toString() };
}

describe("ship-guard version", () => {
  test("accepts a dated stamp and a clean git describe", () => {
    expect(run(`pairfob_require_shipable_version "2026-08-29.3"`).exit).toBe(0);
    expect(run(`pairfob_require_shipable_version "578a90b"`).exit).toBe(0);
  });

  test("refuses empty, dev, and dirty labels", () => {
    for (const v of ["", "dev", "578a90b-dirty"]) {
      const got = run(`pairfob_require_shipable_version "${v}" "VERSION"`);
      expect(got.exit, v).not.toBe(0);
      expect(got.stderr).toContain("not shippable");
    }
  });

  test("PAIRFOB_ALLOW_DIRTY is local-only bypass", () => {
    expect(run(`pairfob_require_shipable_version "dev"`, { PAIRFOB_ALLOW_DIRTY: "1" }).exit).toBe(0);
  });

  test("a VERSION file is required when packing /dl", () => {
    const dir = mkdtempSync(join(tmpdir(), "pairfob-dl-"));
    expect(run(`pairfob_require_shipable_version_file "${dir}/VERSION"`).exit).not.toBe(0);
    writeFileSync(join(dir, "VERSION"), "dev\n");
    expect(run(`pairfob_require_shipable_version_file "${dir}/VERSION"`).exit).not.toBe(0);
    writeFileSync(join(dir, "VERSION"), "2026-08-29.3\n");
    expect(run(`pairfob_require_shipable_version_file "${dir}/VERSION"`).exit).toBe(0);
  });
});

describe("ship-guard clean tree", () => {
  test("refuses a dirty repo and accepts a clean one", () => {
    const dir = mkdtempSync(join(tmpdir(), "pairfob-tree-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.txt"), "a\n");
    const git = (args: string) =>
      Bun.spawnSync(["bash", "-c", `git -C "$DIR" ${args}`], {
        env: { ...process.env, DIR: dir, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
      });
    git("init -q");
    git("add src/a.txt");
    git('commit -qm init');
    expect(run(`pairfob_require_clean_tree "${dir}"`).exit).toBe(0);
    writeFileSync(join(dir, "src/a.txt"), "b\n");
    const dirty = run(`pairfob_require_clean_tree "${dir}"`);
    expect(dirty.exit).not.toBe(0);
    expect(dirty.stderr).toContain("working tree is dirty");
    expect(run(`pairfob_require_clean_tree "${dir}"`, { PAIRFOB_ALLOW_DIRTY: "1" }).exit).toBe(0);
  });
});

describe("release and pack call the guard", () => {
  test("release.sh refuses a dirty tree before it compiles", () => {
    const release = readFileSync(new URL("./release.sh", import.meta.url), "utf8");
    expect(release).toContain('ship-guard.sh');
    expect(release).toContain("pairfob_require_clean_tree");
    expect(release).toContain("pairfob_require_shipable_version");
  });

  test("pack with PAIRFOB_PACK_DL=1 requires a shippable VERSION file", () => {
    const pack = readFileSync(new URL("./pack-origin-assets.sh", import.meta.url), "utf8");
    expect(pack).toContain("pairfob_require_shipable_version_file");
    expect(pack).not.toMatch(/PAIRFOB_PACK_DL:-\}" == "1" && -d/);
  });
});
