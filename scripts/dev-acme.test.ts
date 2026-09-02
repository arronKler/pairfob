import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

const helper = new URL("./dev-acme.sh", import.meta.url).pathname;
const devUp = readFileSync(new URL("./dev-up.sh", import.meta.url), "utf8");
const fixtures: string[] = [];

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { force: true, recursive: true });
});

function fixture(): { dir: string; lego: string; log: string; store: string } {
  const dir = mkdtempSync(join(tmpdir(), "pairfob-acme-"));
  fixtures.push(dir);
  const lego = join(dir, "lego");
  const log = join(dir, "lego.log");
  const store = join(dir, "store");
  writeFileSync(lego, `#!/usr/bin/env bash
set -euo pipefail
store=""
domain=""
action=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --path) store="$2"; shift 2 ;;
    --domains) domain="$2"; shift 2 ;;
    run|renew) action="$1"; shift ;;
    *) shift ;;
  esac
done
echo "$action" >>"$FAKE_LEGO_LOG"
mkdir -p "$store/certificates" "$store/accounts/test"
cat >"$store/test.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = server
prompt = no
[dn]
CN = $domain
[server]
subjectAltName = DNS:$domain
EOF
openssl req -x509 -newkey rsa:1024 -sha256 -days "\${FAKE_CERT_DAYS:-90}" -nodes \\
  -keyout "$store/certificates/$domain.key" -out "$store/certificates/$domain.crt" \\
  -config "$store/test.cnf" >/dev/null 2>&1
echo '{}' >"$store/certificates/$domain.json"
`);
  chmodSync(lego, 0o755);
  return { dir, lego, log, store };
}

function run(
  f: ReturnType<typeof fixture>,
  env: Record<string, string> = {},
): { exit: number; stderr: string; stdout: string } {
  const proc = Bun.spawnSync(["bash", helper, "phone.dev.example.com", f.store], {
    env: {
      ...process.env,
      PAIRFOB_ACME_DNS: "cloudflare",
      PAIRFOB_ACME_EMAIL: "dev@example.com",
      PAIRFOB_ACME_LEGO: f.lego,
      FAKE_LEGO_LOG: f.log,
      ...env,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exit: proc.exitCode ?? 1,
    stderr: proc.stderr.toString(),
    stdout: proc.stdout.toString(),
  };
}

describe("dev ACME", () => {
  test("obtains once and reuses a certificate that is not near expiry", () => {
    const f = fixture();
    expect(run(f).exit).toBe(0);
    const reused = run(f);
    expect(reused.exit).toBe(0);
    expect(reused.stdout).toContain("reusing ACME certificate");
    expect(readFileSync(f.log, "utf8").trim().split("\n")).toEqual(["run"]);
    expect(readFileSync(join(f.store, "certificates/phone.dev.example.com.crt"), "utf8"))
      .toContain("BEGIN CERTIFICATE");
  });

  test("renews a certificate inside the renewal window", () => {
    const f = fixture();
    expect(run(f, { FAKE_CERT_DAYS: "1" }).exit).toBe(0);
    const renewed = run(f, { FAKE_CERT_DAYS: "90" });
    expect(renewed.exit).toBe(0);
    expect(renewed.stdout).toContain("renewing ACME certificate");
    expect(readFileSync(f.log, "utf8").trim().split("\n")).toEqual(["run", "run"]);
  });

  test("accepts the six supported DNS providers", () => {
    const f = fixture();
    expect(run(f).exit).toBe(0);
    for (const provider of ["cloudflare", "route53", "alidns", "tencentcloud", "huaweicloud", "digitalocean"]) {
      expect(run(f, { PAIRFOB_ACME_DNS: provider }).exit, provider).toBe(0);
    }
  });

  test("rejects an unknown provider and missing recovery email", () => {
    const f = fixture();
    const provider = run(f, { PAIRFOB_ACME_DNS: "unknown" });
    expect(provider.exit).not.toBe(0);
    expect(provider.stderr).toContain("unsupported PAIRFOB_ACME_DNS");

    const email = run(f, { PAIRFOB_ACME_EMAIL: "" });
    expect(email.exit).not.toBe(0);
    expect(email.stderr).toContain("PAIRFOB_ACME_EMAIL");
  });

  test("drops DNS credentials before starting long-lived development processes", () => {
    const start = devUp.indexOf('case "${PAIRFOB_ACME_DNS}"');
    const end = devUp.indexOf('acme_cert=', start);
    const clearBlock = devUp.slice(start, end);
    for (const secret of [
      "CF_DNS_API_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "ALICLOUD_SECRET_KEY",
      "TENCENTCLOUD_SECRET_KEY",
      "HUAWEICLOUD_SECRET_ACCESS_KEY",
      "DO_AUTH_TOKEN",
    ]) {
      expect(clearBlock).toContain(secret);
    }
    expect(devUp.indexOf("unset CF_API_EMAIL")).toBeLessThan(devUp.indexOf("bun run build"));
  });
});
