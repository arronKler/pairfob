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
const chatFiles = [
  "pairfob-chat-darwin-amd64",
  "pairfob-chat-darwin-arm64",
  "pairfob-chat-linux-amd64",
  "pairfob-chat-linux-arm64",
];
const desktopFiles = [
  "pairfob-desktop-darwin-amd64",
  "pairfob-desktop-darwin-arm64",
  "pairfob-desktop-linux-amd64",
  "pairfob-desktop-linux-arm64",
];

function run(body: string, env: Record<string, string> = {}): { exit: number; stderr: string } {
  const proc = Bun.spawnSync(["bash", "-c", `set -euo pipefail; . "$GUARD"; ${body}`], {
    env: { ...process.env, ...env, GUARD: guard },
    stderr: "pipe",
    stdout: "pipe",
  });
  return { exit: proc.exitCode ?? 1, stderr: proc.stderr.toString() };
}

function desktopFixture(names: string[] = desktopFiles): string {
  const dir = mkdtempSync(join(tmpdir(), "pairfob-desktop-"));
  for (const name of names) {
    writeFileSync(join(dir, name), `fixture ${name}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  writeFileSync(join(dir, "VERSION"), "1.0.0\n");
  const manifest = [...names, "VERSION"]
    .map((name) => `${createHash("sha256").update(readFileSync(join(dir, name))).digest("hex")}  ${name}`)
    .join("\n");
  writeFileSync(join(dir, "SHA256SUMS"), `${manifest}\n`);
  return dir;
}

function releaseFixture(extra: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "pairfob-release-"));
  const binaries = [...releaseFiles, ...extra];
  for (const name of binaries) {
    writeFileSync(join(dir, name), `fixture ${name}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  writeFileSync(join(dir, "VERSION"), "1.0.0\n");
  const manifest = [...binaries, "VERSION"]
    .map((name) => `${createHash("sha256").update(readFileSync(join(dir, name))).digest("hex")}  ${name}`)
    .join("\n");
  writeFileSync(join(dir, "SHA256SUMS"), `${manifest}\n`);
  return dir;
}

describe("ship-guard version", () => {
  test("accepts SemVer with or without a v prefix", () => {
    expect(run(`pairfob_require_shipable_version "1.0.0"`).exit).toBe(0);
    expect(run(`pairfob_require_shipable_version "v1.2.3"`).exit).toBe(0);
  });

  test("refuses hashes, date stamps, empty, dev, and dirty labels", () => {
    for (const v of ["", "dev", "578a90b", "578a90b-dirty", "2026-08-29.3", "v1.0.0-1-g578a90b"]) {
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
    writeFileSync(join(dir, "VERSION"), "ad27e83\n");
    expect(run(`pairfob_require_shipable_version_file "${dir}/VERSION"`).exit).not.toBe(0);
    writeFileSync(join(dir, "VERSION"), "1.0.0\n");
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

  test("accepts a complete pairfob-chat artifact set", () => {
    const dir = releaseFixture(chatFiles);
    expect(run(`pairfob_require_release_dir "$DIR"`, { DIR: dir }).exit).toBe(0);
  });

  test("rejects an incomplete pairfob-chat artifact set", () => {
    const dir = releaseFixture(chatFiles.slice(0, 3));
    const got = run(`pairfob_require_release_dir "$DIR"`, { DIR: dir });
    expect(got.exit).not.toBe(0);
    expect(got.stderr).toContain("incomplete pairfob-chat");
  });

  test("rejects chat binaries missing from SHA256SUMS", () => {
    const dir = releaseFixture();
    for (const name of chatFiles) {
      writeFileSync(join(dir, name), `fixture ${name}\n`);
      chmodSync(join(dir, name), 0o755);
    }
    expect(run(`pairfob_require_release_dir "$DIR"`, { DIR: dir }).exit).not.toBe(0);
  });

  test("rejects legacy pairfobd artifacts and any other extra file", () => {
    for (const extra of ["pairfobd-darwin-arm64", "notes.txt", "android"]) {
      const dir = releaseFixture();
      writeFileSync(join(dir, extra), "stale\n");
      expect(run(`pairfob_require_release_dir "$DIR"`, { DIR: dir }).exit, extra).not.toBe(0);
    }
  });

  test("accepts the Android publish staging directory beside the daemon artifacts", () => {
    // publish-android-beta.sh keeps the channel in dist/dl/android/beta; a pack
    // copies only the top-level files, so the directory is not shipped.
    const dir = releaseFixture();
    mkdirSync(join(dir, "android/beta"), { recursive: true });
    writeFileSync(join(dir, "android/beta/latest.json"), "{}\n");
    expect(run(`pairfob_require_release_dir "$DIR"`, { DIR: dir }).exit).toBe(0);
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

describe("ship-guard desktop directory", () => {
  test("accepts one or more complete platform builds", () => {
    expect(run(`pairfob_require_desktop_dir "$DIR"`, { DIR: desktopFixture() }).exit).toBe(0);
    expect(run(`pairfob_require_desktop_dir "$DIR"`, {
      DIR: desktopFixture(["pairfob-desktop-darwin-arm64"]),
    }).exit).toBe(0);
  });

  test("rejects an empty channel and any extra file", () => {
    expect(run(`pairfob_require_desktop_dir "$DIR"`, { DIR: desktopFixture([]) }).exit).not.toBe(0);
    for (const extra of ["release.json", "notes.txt", ".DS_Store", "pairfob-desktop-windows-amd64"]) {
      const dir = desktopFixture(["pairfob-desktop-darwin-arm64"]);
      writeFileSync(join(dir, extra), "stale\n");
      expect(run(`pairfob_require_desktop_dir "$DIR"`, { DIR: dir }).exit, extra).not.toBe(0);
    }
  });

  test("rejects missing, symlinked, or non-executable binaries", () => {
    const missing = desktopFixture();
    rmSync(join(missing, "pairfob-desktop-linux-arm64"));
    expect(run(`pairfob_require_desktop_dir "$DIR"`, { DIR: missing }).exit).not.toBe(0);

    const linked = desktopFixture();
    rmSync(join(linked, "pairfob-desktop-linux-arm64"));
    symlinkSync("pairfob-desktop-linux-amd64", join(linked, "pairfob-desktop-linux-arm64"));
    expect(run(`pairfob_require_desktop_dir "$DIR"`, { DIR: linked }).exit).not.toBe(0);

    const plain = desktopFixture();
    chmodSync(join(plain, "pairfob-desktop-darwin-arm64"), 0o644);
    expect(run(`pairfob_require_desktop_dir "$DIR"`, { DIR: plain }).exit).not.toBe(0);
  });

  test("rejects corrupt content and malformed manifests", () => {
    const corrupt = desktopFixture();
    writeFileSync(join(corrupt, "pairfob-desktop-darwin-arm64"), "changed after checksums\n");
    expect(run(`pairfob_require_desktop_dir "$DIR"`, { DIR: corrupt }).exit).not.toBe(0);

    const malformed = desktopFixture();
    writeFileSync(join(malformed, "SHA256SUMS"), `${"0".repeat(64)}  pairfob-desktop-windows-amd64\n`);
    expect(run(`pairfob_require_desktop_dir "$DIR"`, { DIR: malformed }).exit).not.toBe(0);
  });
});

describe("release and pack call the guard", () => {
  test("release.sh refuses a dirty tree before it compiles", () => {
    const release = readFileSync(new URL("./release.sh", import.meta.url), "utf8");
    expect(release).toContain('ship-guard.sh');
    expect(release).toContain("pairfob_require_clean_tree");
    expect(release).toContain("pairfob_require_shipable_version");
    expect(release).toContain("pairfob_require_release_dir");
    expect(release).toContain("describe --tags --exact-match");
    expect(release).toContain("requires semver");
  });

  test("pack with PAIRFOB_PACK_DL=1 requires a complete release directory", () => {
    const pack = readFileSync(new URL("./pack-origin-assets.sh", import.meta.url), "utf8");
    expect(pack).toContain("pairfob_require_release_dir");
    expect(pack).not.toMatch(/PAIRFOB_PACK_DL:-\}" == "1" && -d/);
  });

  test("desktop release and publisher require a valid desktop directory", () => {
    const release = readFileSync(new URL("./release-desktop.sh", import.meta.url), "utf8");
    expect(release).toContain("pairfob_require_clean_tree");
    expect(release).toContain("pairfob_require_desktop_dir");
    expect(release).toContain("pairfob_require_shipable_version");

    const publish = readFileSync(new URL("./publish-desktop.sh", import.meta.url), "utf8");
    expect(publish).toContain("pairfob_require_desktop_dir");
    const unset = publish.indexOf("unset PAIRFOB_ALLOW_DIRTY");
    expect(unset).toBeGreaterThan(-1);
    expect(unset).toBeLessThan(publish.indexOf("pairfob_require_clean_tree"));
  });
});
