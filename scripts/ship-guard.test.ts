import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const guard = new URL("./ship-guard.sh", import.meta.url).pathname;
const releaseFiles = [
  "pairfob-darwin-amd64",
  "pairfob-darwin-arm64",
  "pairfob-linux-amd64",
  "pairfob-linux-arm64",
];

function run(body: string, env: Record<string, string> = {}): { exit: number; stderr: string } {
  const proc = Bun.spawnSync(["bash", "-c", `set -euo pipefail; . "$GUARD"; ${body}`], {
    env: { ...process.env, ...env, GUARD: guard },
    stderr: "pipe",
    stdout: "pipe",
  });
  return { exit: proc.exitCode ?? 1, stderr: proc.stderr.toString() };
}

function releaseFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "pairfob-release-"));
  for (const name of releaseFiles) {
    writeFileSync(join(dir, name), `fixture ${name}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  writeFileSync(join(dir, "VERSION"), "2026-08-31.1\n");
  const manifest = [...releaseFiles, "VERSION"]
    .map((name) => `${createHash("sha256").update(readFileSync(join(dir, name))).digest("hex")}  ${name}`)
    .join("\n");
  writeFileSync(join(dir, "SHA256SUMS"), `${manifest}\n`);
  return dir;
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

describe("ship-guard release directory", () => {
  test("accepts only the complete pairfob artifact set", () => {
    const dir = releaseFixture();
    expect(run(`pairfob_require_release_dir "$DIR"`, { DIR: dir }).exit).toBe(0);
  });

  test("rejects legacy pairfobd artifacts and any other extra file", () => {
    for (const extra of ["pairfobd-darwin-arm64", "notes.txt"]) {
      const dir = releaseFixture();
      writeFileSync(join(dir, extra), "stale\n");
      expect(run(`pairfob_require_release_dir "$DIR"`, { DIR: dir }).exit, extra).not.toBe(0);
    }
  });

  test("rejects missing or symlinked binaries", () => {
    const missing = releaseFixture();
    rmSync(join(missing, releaseFiles[0]));
    expect(run(`pairfob_require_release_dir "$DIR"`, { DIR: missing }).exit).not.toBe(0);

    const linked = releaseFixture();
    rmSync(join(linked, releaseFiles[0]));
    symlinkSync(releaseFiles[1], join(linked, releaseFiles[0]));
    expect(run(`pairfob_require_release_dir "$DIR"`, { DIR: linked }).exit).not.toBe(0);
  });

  test("rejects corrupt content and malformed manifests", () => {
    const corrupt = releaseFixture();
    writeFileSync(join(corrupt, releaseFiles[0]), "changed after checksums\n");
    expect(run(`pairfob_require_release_dir "$DIR"`, { DIR: corrupt }).exit).not.toBe(0);

    const malformed = releaseFixture();
    writeFileSync(join(malformed, "SHA256SUMS"), `${"0".repeat(64)}  pairfobd-darwin-arm64\n`);
    expect(run(`pairfob_require_release_dir "$DIR"`, { DIR: malformed }).exit).not.toBe(0);
  });
});

describe("release and pack call the guard", () => {
  test("release.sh refuses a dirty tree before it compiles", () => {
    const release = readFileSync(new URL("./release.sh", import.meta.url), "utf8");
    expect(release).toContain('ship-guard.sh');
    expect(release).toContain("pairfob_require_clean_tree");
    expect(release).toContain("pairfob_require_shipable_version");
    expect(release).toContain("pairfob_require_release_dir");
  });

  test("pack with PAIRFOB_PACK_DL=1 requires a complete release directory", () => {
    const pack = readFileSync(new URL("./pack-origin-assets.sh", import.meta.url), "utf8");
    expect(pack).toContain("pairfob_require_release_dir");
    expect(pack).not.toMatch(/PAIRFOB_PACK_DL:-\}" == "1" && -d/);
  });
});
