import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const CERT_SHA1 = "71410343DFD9A3EBE420FEEC337B3AA94AFE6729";

function fixture(pin = CERT_SHA1) {
  const root = mkdtempSync(join(tmpdir(), "pairfob-signing-"));
  roots.push(root);
  const bin = join(root, "bin");
  const scripts = join(root, "scripts");
  mkdirSync(bin);
  mkdirSync(scripts);
  for (const name of ["macos-signing.sh", "release.sh", "ship-guard.sh", "publish-daemon.sh"])
    copyFileSync(new URL(name, import.meta.url), join(scripts, name));
  const signingPath = join(scripts, "macos-signing.sh");
  writeFileSync(signingPath, readFileSync(signingPath, "utf8")
    .replace(/PAIRFOB_MACOS_SELF_SIGNED_SHA1=[0-9A-F]+/, `PAIRFOB_MACOS_SELF_SIGNED_SHA1=${pin}`));
  const command = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/usr/bin/env bash\nset -eu\n${body}\n`);
    chmodSync(path, 0o755);
  };
  command("uname", 'echo "${SIGN_HOST:-Darwin}"');
  command("security", 'if [[ "${1:-}" == find-identity && "${SECURITY_EMPTY:-0}" != 1 ]]; then printf "  1) %s \\"Pairfob Daemon Signing\\"\\n" "${FIXTURE_PIN:-${SIGN_CERT_SHA1:-71410343DFD9A3EBE420FEEC337B3AA94AFE6729}}"; fi');
  command("go", 'printf "%s %s %s\\n" "$GOOS" "$GOARCH" "$CGO_ENABLED" >> "$BUILD_CALLS"\nwhile [[ "$1" != -o ]]; do shift; done\nprintf "binary\\n" > "$2"\nchmod +x "$2"');
  command("codesign", `
printf '%s fail=%s\\n' "$*" "\${SIGN_FAIL:-}" >> "$SIGN_CALLS"
case "$1" in
  --force) if [[ "\${SIGN_FAIL:-}" == sign ]]; then exit 1; fi; printf 'signed\\n' >> "\${!#}" ;;
  --verify) if [[ "\${SIGN_FAIL:-}" == verify ]]; then exit 1; fi ;;
  --display)
    kind="\${SIGN_KIND:-}"
    if [[ -z "$kind" ]]; then
      if [[ "\${PAIRFOB_MACOS_SELF_SIGNED:-0}" == 1 ]]; then kind=certificate; else kind=adhoc; fi
    fi
    echo "Identifier=\${SIGN_IDENTIFIER:-com.pairfob.daemon}"
    if [[ "$kind" != certificate ]]; then echo "Signature=$kind"; fi
    echo 'TeamIdentifier=not set'
    if [[ "\${SIGN_FAIL:-}" != timestamp ]]; then echo 'Timestamp=Oct 28, 2026'; fi
    if [[ "\${SIGN_FAIL:-}" == hash ]]; then echo 'designated => cdhash H"123"';
    elif [[ "$kind" == certificate ]]; then
      echo "designated => identifier \\"com.pairfob.daemon\\" and certificate leaf = H\\"\${SIGN_CERT_SHA1:-71410343DFD9A3EBE420FEEC337B3AA94AFE6729}\\"";
    else echo 'designated => identifier "com.pairfob.daemon" and anchor apple generic'; fi ;;
esac`);
  const env = {
    ...process.env,
    HOME: root,
    PAIRFOB_RELEASE_PUBKEY: "4a".repeat(32),
    PATH: `${bin}:${process.env.PATH}`,
    SIGN_CALLS: join(root, "calls"),
    BUILD_CALLS: join(root, "builds"),
    SIGN_HOST: "Darwin", SIGN_FAIL: "",
    SIGN_CERT_SHA1: CERT_SHA1,
    FIXTURE_PIN: pin,
    PAIRFOB_MACOS_TEAM_ID: "ABCDE12345",
    PAIRFOB_MACOS_SIGN_IDENTITY: "Developer ID Application: Fixture",
    PAIRFOB_ALLOW_UNSIGNED_MACOS: "0",
    PAIRFOB_MACOS_SELF_SIGNED: "0",
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
  // Two products per target: the daemon and its pairfob-chat host.
  expect(readFileSync(f.env.BUILD_CALLS, "utf8")).toBe(
    "darwin amd64 1\ndarwin amd64 1\ndarwin arm64 1\ndarwin arm64 1\nlinux amd64 0\nlinux amd64 0\nlinux arm64 0\nlinux arm64 0\n",
  );
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

test("explicit no-certificate release verifies both architectures and hashes signed bytes", () => {
  const f = fixture();
  const env = { PAIRFOB_ALLOW_UNSIGNED_MACOS: "1", PAIRFOB_MACOS_TEAM_ID: "", PAIRFOB_MACOS_SIGN_IDENTITY: "" };
  const result = f.run('bash scripts/release.sh; pairfob_verify_macos_release "$OUT"', env);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const manifest = readFileSync(join(f.env.OUT, "SHA256SUMS"), "utf8");
  for (const arch of ["amd64", "arm64"]) {
    const name = `pairfob-darwin-${arch}`;
    const data = readFileSync(join(f.env.OUT, name));
    expect(data.toString()).toBe("binary\nsigned\n");
    expect(manifest).toContain(`${createHash("sha256").update(data).digest("hex")}  ${name}`);
  }
  const calls = readFileSync(f.env.SIGN_CALLS, "utf8");
  expect(calls.match(/--sign - --identifier com\.pairfob\.daemon/g)?.length).toBe(2);
  expect(calls).not.toContain("--timestamp");
  expect(f.run('pairfob_prepare_macos_signing', { ...env, SIGN_HOST: "Linux" }).exitCode).not.toBe(0);
}, 60_000);

test("no-certificate mode rejects invalid signatures and misleading identifiers", () => {
  for (const extra of [{ SIGN_FAIL: "verify" }, { SIGN_IDENTIFIER: "com.pairfob.daemon.other" }, { SIGN_KIND: "invalid" }]) {
    const f = fixture();
    const result = f.run('bash scripts/release.sh', { PAIRFOB_ALLOW_UNSIGNED_MACOS: "1", ...extra });
    expect(result.exitCode).not.toBe(0);
    expect(() => readFileSync(join(f.env.OUT, "SHA256SUMS"))).toThrow();
  }
}, 60_000);

test("no-certificate publication still verifies before touching download channels", () => {
  const f = fixture();
  expect(f.run('bash scripts/release.sh', { PAIRFOB_ALLOW_UNSIGNED_MACOS: "1" }).exitCode).toBe(0);
  const result = f.run('bash scripts/publish-daemon.sh --source "$OUT"', {
    PAIRFOB_ALLOW_UNSIGNED_MACOS: "1", SIGN_FAIL: "verify",
  });
  expect(result.exitCode).not.toBe(0);
  expect(readFileSync(f.env.SIGN_CALLS, "utf8")).toContain("--verify");
  // It stops before attempting to fetch either live download channel.
  expect(result.stderr.toString()).not.toContain("download-channel.py");
}, 60_000);

test("self-signed release signs both Mac architectures with the pinned certificate", () => {
  const f = fixture();
  const selfSigned = { PAIRFOB_MACOS_SELF_SIGNED: "1", PAIRFOB_MACOS_TEAM_ID: "", PAIRFOB_MACOS_SIGN_IDENTITY: "" };
  const result = f.run('bash scripts/release.sh; pairfob_verify_macos_release "$OUT"', selfSigned);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const calls = readFileSync(f.env.SIGN_CALLS, "utf8");
  expect(calls.match(new RegExp(`--sign ${CERT_SHA1} --identifier com\\.pairfob\\.daemon --options runtime --timestamp`, "g"))?.length).toBe(2);
  expect(calls).not.toContain("Signature=adhoc");
  const manifest = readFileSync(join(f.env.OUT, "SHA256SUMS"), "utf8");
  for (const arch of ["amd64", "arm64"]) {
    const name = `pairfob-darwin-${arch}`;
    const data = readFileSync(join(f.env.OUT, name));
    expect(data.toString()).toBe("binary\nsigned\n");
    expect(manifest).toContain(`${createHash("sha256").update(data).digest("hex")}  ${name}`);
  }
}, 60_000);

test("self-signed mode fails closed on ad-hoc output, another certificate and hash-pinned requirements", () => {
  const cases: { pin?: string; extra?: Record<string, string> }[] = [
    { extra: { SIGN_KIND: "adhoc" } },
    { pin: "a".repeat(40), extra: { SIGN_CERT_SHA1: "b".repeat(40) } },
    { extra: { SIGN_FAIL: "hash" } },
    { extra: { SIGN_FAIL: "timestamp" } },
    { extra: { SIGN_FAIL: "verify" } },
    { extra: { SIGN_FAIL: "sign" } },
    { extra: { SECURITY_EMPTY: "1" } },
    { pin: "xyz" },
    { extra: { PAIRFOB_ALLOW_UNSIGNED_MACOS: "1" } },
  ];
  for (const tc of cases) {
    const f = fixture(tc.pin);
    const result = f.run('bash scripts/release.sh', { PAIRFOB_MACOS_SELF_SIGNED: "1", ...tc.extra });
    expect(result.exitCode, `${JSON.stringify(tc)}: ${result.stderr.toString()}`).not.toBe(0);
    expect(() => readFileSync(join(f.env.OUT, "SHA256SUMS"))).toThrow();
  }
}, 60_000);

test("self-signed publication verifies the pinned identity before touching download channels", () => {
  const f = fixture();
  expect(f.run('bash scripts/release.sh', { PAIRFOB_MACOS_SELF_SIGNED: "1" }).exitCode).toBe(0);
  const result = f.run('bash scripts/publish-daemon.sh --source "$OUT"', {
    PAIRFOB_MACOS_SELF_SIGNED: "1", SIGN_FAIL: "verify",
  });
  expect(result.exitCode).not.toBe(0);
  expect(readFileSync(f.env.SIGN_CALLS, "utf8")).toContain("--verify");
  expect(result.stderr.toString()).not.toContain("download-channel.py");
}, 60_000);
