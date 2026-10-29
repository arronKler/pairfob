import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pairfob-signing-"));
  roots.push(root);
  const bin = join(root, "bin");
  const scripts = join(root, "scripts");
  mkdirSync(bin);
  mkdirSync(scripts);
  for (const name of ["macos-signing.sh", "release.sh", "ship-guard.sh", "publish-daemon.sh"])
    copyFileSync(new URL(name, import.meta.url), join(scripts, name));
  const command = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/usr/bin/env bash\nset -eu\n${body}\n`);
    chmodSync(path, 0o755);
  };
  command("uname", 'echo "${SIGN_HOST:-Darwin}"');
  command("go", 'printf "%s %s %s\\n" "$GOOS" "$GOARCH" "$CGO_ENABLED" >> "$BUILD_CALLS"\nwhile [[ "$1" != -o ]]; do shift; done\nprintf "binary\\n" > "$2"\nchmod +x "$2"');
  command("codesign", `
printf '%s fail=%s\\n' "$*" "\${SIGN_FAIL:-}" >> "$SIGN_CALLS"
case "$1" in
  --force) if [[ "\${SIGN_FAIL:-}" == sign ]]; then exit 1; fi; printf 'signed\\n' >> "\${!#}" ;;
  --verify) if [[ "\${SIGN_FAIL:-}" == verify ]]; then exit 1; fi ;;
  --display)
    if [[ "\${SIGN_FAIL:-}" != timestamp ]]; then echo 'Timestamp=Oct 28, 2026'; fi
    if [[ "\${SIGN_FAIL:-}" == hash ]]; then echo 'designated => cdhash H"123"';
    else echo 'designated => identifier "com.pairfob.daemon" and anchor apple generic'; fi ;;
esac`);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    SIGN_CALLS: join(root, "calls"),
    BUILD_CALLS: join(root, "builds"),
    SIGN_HOST: "Darwin", SIGN_FAIL: "",
    PAIRFOB_MACOS_TEAM_ID: "ABCDE12345",
    PAIRFOB_MACOS_SIGN_IDENTITY: "Developer ID Application: Fixture",
    PAIRFOB_ALLOW_UNSIGNED_MACOS: "0",
    PAIRFOB_ALLOW_DIRTY: "1", VERSION: "v1.2.3", COMMIT: "fixture",
    OUT: join(root, "out"),
  };
  const run = (body: string, extra: Record<string, string> = {}) => Bun.spawnSync(
    ["bash", "-c", `set -euo pipefail; . "$SIGN_SCRIPT"; ${body}`],
    { cwd: root, env: { ...env, SIGN_SCRIPT: join(scripts, "macos-signing.sh"), ...extra }, stdout: "pipe", stderr: "pipe" },
  );
  return { root, env, run };
}

test("release requires a Mac, a team, and a non-ad-hoc identity", () => {
  const f = fixture();
  for (const env of [
    { SIGN_HOST: "Linux" }, { PAIRFOB_MACOS_TEAM_ID: "" },
    { PAIRFOB_MACOS_TEAM_ID: 'bad"team' },
    { PAIRFOB_MACOS_SIGN_IDENTITY: "" }, { PAIRFOB_MACOS_SIGN_IDENTITY: "-" },
  ]) expect(f.run("pairfob_prepare_macos_signing", env).exitCode).not.toBe(0);
  expect(f.run("pairfob_prepare_macos_signing").exitCode).toBe(0);
}, 60_000);

test("release hashes signed bytes and uses the same identity for both Mac architectures", () => {
  const f = fixture();
  const result = f.run('bash scripts/release.sh');
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const manifest = readFileSync(join(f.env.OUT, "SHA256SUMS"), "utf8");
  for (const os of ["darwin", "linux"]) for (const arch of ["amd64", "arm64"]) {
    const name = `pairfob-${os}-${arch}`;
    const data = readFileSync(join(f.env.OUT, name));
    expect(data.toString()).toBe(os === "darwin" ? "binary\nsigned\n" : "binary\n");
    expect(manifest).toContain(`${createHash("sha256").update(data).digest("hex")}  ${name}`);
  }
  const calls = readFileSync(f.env.SIGN_CALLS, "utf8");
  expect(readFileSync(f.env.BUILD_CALLS, "utf8")).toBe("darwin amd64 1\ndarwin arm64 1\nlinux amd64 0\nlinux arm64 0\n");
  expect(calls.match(/--identifier com\.pairfob\.daemon --options runtime --timestamp/g)?.length).toBe(2);
  expect(calls).toContain('certificate leaf[subject.OU] = "ABCDE12345"');
}, 60_000);

test("failed signing or verification never produces a release manifest", () => {
  for (const failure of ["sign", "verify", "hash", "timestamp"]) {
    const f = fixture();
    const result = f.run('bash scripts/release.sh', { SIGN_FAIL: failure });
    expect(result.exitCode, `${failure}: ${result.stderr.toString()} ${readFileSync(f.env.SIGN_CALLS, "utf8")}`).not.toBe(0);
    expect(() => readFileSync(join(f.env.OUT, "SHA256SUMS"))).toThrow();
  }
}, 60_000);

test("development bypass builds locally but cannot bypass publication verification", () => {
  const f = fixture();
  expect(f.run('bash scripts/release.sh', { PAIRFOB_ALLOW_UNSIGNED_MACOS: "1", SIGN_HOST: "Linux" }).exitCode).toBe(0);
  const result = f.run('bash scripts/publish-daemon.sh --source "$OUT"', {
    PAIRFOB_ALLOW_UNSIGNED_MACOS: "1", SIGN_FAIL: "verify",
  });
  expect(result.exitCode).not.toBe(0);
  expect(readFileSync(f.env.SIGN_CALLS, "utf8")).toContain("--verify");
  // It stops before attempting to fetch either live download channel.
  expect(result.stderr.toString()).not.toContain("download-channel.py");
}, 60_000);
