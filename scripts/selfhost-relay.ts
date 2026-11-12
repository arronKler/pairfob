/**
 * Deploy the pairfob relay to the user's own Cloudflare account.
 *
 * One command builds the PWA, packs it as the relay's static assets, creates
 * the D1 database, applies migrations, generates the operator secrets and
 * deploys the Worker. The browser PWA always treats its own page origin as the
 * relay origin, so the relay must serve the app at `/pair`; loading the
 * pairfob.com PWA against another origin is not supported.
 *
 * The deploy is idempotent: the generated config and secrets live under
 * `.dev/selfhost/<name>` (ignored by git), the D1 database is found by name,
 * and running the command again redeploys with the same secrets.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import {
  DEFAULT_RELAY_NAME,
  PLACEHOLDER_DATABASE_ID,
  buildWranglerConfig,
  databaseNameFor,
  findDatabase,
  parseArgs,
  parseD1CreateId,
  parseD1List,
  parseDeployOrigin,
  parseEnvFile,
  renderEnvFile,
  type DatabaseRow,
  type SelfhostOptions,
} from "./selfhost-config.ts";
import { packSelfhostAssets } from "./selfhost-pack.ts";

const ROOT = resolve(import.meta.dir, "..");
const ORIGIN_DIR = join(ROOT, "workers", "pairfob-origin");
const PWA_DIR = join(ROOT, "pwa");
const PWA_DIST = join(PWA_DIR, "dist");
const MIGRATIONS_DIR = join(ORIGIN_DIR, "migrations");
const INSTALL_SCRIPT = join(ROOT, "scripts", "install.sh");
const SECRET_NAMES = ["OPERATOR_TOKEN", "IP_HASH_PEPPER"] as const;

const HELP = `usage: bun scripts/selfhost-relay.ts [options]

Deploy a Pairfob relay (Worker + Durable Objects + D1 + the web app) to the
Cloudflare account Wrangler is logged in to.

  --name NAME        Worker name (default ${DEFAULT_RELAY_NAME})
  --domain HOST      Serve on a custom domain such as relay.example.com
  --origin URL       Expected relay origin, or use when Wrangler prints none
                     (a custom host also needs --domain)
  --database-id ID   Reuse an existing D1 database instead of creating one
  --state-dir DIR    Where the generated config and secrets live
                     (default .dev/selfhost/<name>)
  --skip-build       Use the existing pwa/dist build
  --no-smoke         Skip the post-deploy health and app checks
  --rotate-secrets   Generate a new operator token and IP hash pepper
  --dry-run          Build, pack and validate the config without deploying
  -h, --help         Show this help

Environment:
  CLOUDFLARE_API_TOKEN   Deploy without an interactive login
  PAIRFOB_WRANGLER       Use a specific Wrangler binary

Examples:
  bun scripts/selfhost-relay.ts
  bun scripts/selfhost-relay.ts --name my-relay --domain relay.example.com
`;

type RunOptions = {
  cwd?: string;
  env?: Record<string, string>;
  capture?: boolean;
};

type CommandResult = { status: number; stdout: string; stderr: string };

function run(argv: string[], options: RunOptions = {}): CommandResult {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function tail(text: string, lines = 20): string {
  const kept = text.trim().split(/\r?\n/).slice(-lines).join("\n");
  return kept ? `\n${kept}` : "";
}

/** Run a command and return its output. Wrangler's logger writes to stdout. */
function runCapture(argv: string[], options: RunOptions = {}): string {
  const result = run(argv, { ...options, capture: true });
  if (result.status !== 0) {
    throw new Error(
      `${argv.slice(0, 3).join(" ")} failed (exit ${result.status})${tail(result.stderr || result.stdout)}`,
    );
  }
  return result.stdout;
}

function findOnPath(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Prefer the Wrangler pinned by workers/pairfob-origin, then PATH. */
function wranglerBinary(): string {
  const override = process.env.PAIRFOB_WRANGLER;
  if (override) return override;
  const executable = process.platform === "win32" ? "wrangler.cmd" : "wrangler";
  const local = join(ORIGIN_DIR, "node_modules", ".bin", executable);
  if (existsSync(local)) return local;
  const onPath = findOnPath(executable);
  if (onPath) return onPath;
  throw new Error(
    "Wrangler is not installed. Run (cd workers/pairfob-origin && bun install --frozen-lockfile), " +
      "or set PAIRFOB_WRANGLER.",
  );
}

function stateDirectory(options: SelfhostOptions): string {
  return options.stateDir ? resolve(options.stateDir) : join(ROOT, ".dev", "selfhost", options.name);
}

function buildVersion(): string {
  return `selfhost-${new Date().toISOString().slice(0, 10)}`;
}

function generateSecret(): string {
  return randomBytes(32).toString("base64url");
}

function loadSecrets(path: string, rotate: boolean): Record<string, string> {
  const existing = existsSync(path) ? parseEnvFile(readFileSync(path, "utf8")) : new Map<string, string>();
  const values: Record<string, string> = {};
  for (const name of SECRET_NAMES) {
    const current = existing.get(name);
    values[name] = !rotate && current ? current : generateSecret();
  }
  return values;
}

function writeSecrets(path: string, values: Record<string, string>): void {
  writeFileSync(path, renderEnvFile(values), { mode: 0o600 });
  chmodSync(path, 0o600);
}

function buildPwa(skipBuild: boolean): void {
  if (skipBuild) {
    if (!existsSync(join(PWA_DIST, "index.html"))) {
      throw new Error("--skip-build needs an existing pwa/dist; run (cd pwa && bun run build) first.");
    }
    console.log("selfhost: using the existing PWA build");
    return;
  }
  if (!existsSync(join(PWA_DIR, "node_modules"))) {
    throw new Error("pwa/node_modules is missing. Run (cd pwa && bun install --frozen-lockfile) first.");
  }
  console.log("selfhost: building the PWA");
  // Use the Bun running this script, not whichever `bun` PATH resolves to.
  const result = run([process.execPath, "run", "build"], { cwd: PWA_DIR });
  if (result.status !== 0) throw new Error("PWA build failed");
}

function listDatabases(wrangler: string, configPath: string): DatabaseRow[] {
  // Always name the generated config: without it Wrangler discovers the
  // production wrangler.jsonc in this checkout.
  return parseD1List(
    runCapture([wrangler, "d1", "list", "--json", "--config", configPath], { cwd: ORIGIN_DIR }),
  );
}

function ensureDatabase(
  wrangler: string,
  databaseName: string,
  options: SelfhostOptions,
  dryRun: boolean,
  configPath: string,
): string {
  if (options.databaseId) return options.databaseId;
  if (dryRun) return PLACEHOLDER_DATABASE_ID;
  const existing = findDatabase(listDatabases(wrangler, configPath), databaseName);
  if (existing) {
    console.log(`selfhost: reusing D1 database ${databaseName}`);
    return existing.id;
  }
  console.log(`selfhost: creating D1 database ${databaseName}`);
  // Point Wrangler at the generated config so it never discovers (and, outside
  // CI, patches) the production wrangler.jsonc in this checkout.
  const output = runCapture(
    [wrangler, "d1", "create", databaseName, "--config", configPath],
    { cwd: ORIGIN_DIR, env: { CI: "1" } },
  );
  const created =
    parseD1CreateId(output) ?? findDatabase(listDatabases(wrangler, configPath), databaseName)?.id;
  if (!created) {
    throw new Error(
      `D1 database ${databaseName} was created but its id could not be read. ` +
        "Find it in the Cloudflare dashboard and rerun with --database-id.",
    );
  }
  return created;
}

function applyMigrations(wrangler: string, configPath: string): void {
  console.log("selfhost: applying D1 migrations");
  const result = run(
    [wrangler, "d1", "migrations", "apply", "DB", "--remote", "--config", configPath],
    { cwd: ORIGIN_DIR, env: { CI: "1" } },
  );
  if (result.status !== 0) throw new Error("D1 migrations failed");
}

function deployWorker(wrangler: string, configPath: string, secretsPath: string): string {
  console.log("selfhost: deploying the Worker");
  const result = run(
    [wrangler, "deploy", "--config", configPath, "--secrets-file", secretsPath],
    { cwd: ORIGIN_DIR, capture: true },
  );
  if (result.status !== 0) {
    throw new Error(`Worker deploy failed (exit ${result.status})${tail(result.stderr || result.stdout)}`);
  }
  // Wrangler's logger writes to stdout, but keep stderr in the parse input so
  // a different build layout cannot hide the trigger URLs.
  return `${result.stdout}\n${result.stderr}`;
}

async function fetchOk(url: string): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(15_000) });
}

async function waitForHealth(origin: string): Promise<void> {
  // A workers.dev route answers immediately; a new custom domain may still be
  // provisioning its certificate, so allow about half a minute.
  const attempts = 10;
  let last = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchOk(`${origin}/v2/health`);
      const body = (await response.json()) as { ok?: boolean; protocol?: number };
      if (response.ok && body.ok === true && body.protocol === 2) return;
      last = `health returned ${response.status} ${JSON.stringify(body)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts) await new Promise((done) => setTimeout(done, 3_000));
  }
  throw new Error(`relay did not become healthy at ${origin}: ${last}`);
}

async function smoke(origin: string): Promise<void> {
  await waitForHealth(origin);
  const config = await fetchOk(`${origin}/api/config`);
  const configBody = (await config.json()) as { protocol?: number };
  if (!config.ok || configBody.protocol !== 2) {
    throw new Error(`/api/config is not a pairfob.v2 relay (status ${config.status})`);
  }
  const app = await fetchOk(`${origin}/pair`);
  const html = await app.text();
  if (!app.ok || !html.includes('name="pairfob-assets"')) {
    throw new Error(`/pair did not serve the Pairfob web app (status ${app.status})`);
  }
  console.log("selfhost: health, config and app checks passed");
}

function printSummary(origin: string, stateDir: string, secretsPath: string): void {
  console.log("");
  console.log(`Relay:    ${origin}`);
  console.log(`Web app:  ${origin}/pair`);
  console.log(`State:    ${stateDir}`);
  console.log("");
  console.log("Pair this computer:");
  console.log(`  pairfob enroll --origin ${origin}`);
  console.log("");
  console.log("Install on another computer:");
  console.log(`  curl -fsSL ${origin}/install.sh | sh -s -- --origin ${origin}`);
  console.log("");
  console.log(`Operator secrets: ${secretsPath} (keep this file private)`);
  console.log(
    "Daemon downloads and auto-updates still come from https://dl.pairfob.com; " +
      "set PAIRFOB_DOWNLOAD_BASE to use another download channel.",
  );
}

export async function deploySelfhost(options: SelfhostOptions): Promise<void> {
  const stateDir = stateDirectory(options);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const configPath = join(stateDir, "wrangler.json");
  const secretsPath = join(stateDir, "secrets.env");
  const assetsDir = join(stateDir, "public");
  const databaseName = databaseNameFor(options.name);

  buildPwa(options.skipBuild);
  console.log(`selfhost: packing relay assets into ${assetsDir}`);
  await packSelfhostAssets({
    pwaDist: PWA_DIST,
    dest: assetsDir,
    installScript: INSTALL_SCRIPT,
    previousPublic: existsSync(assetsDir) ? assetsDir : undefined,
  });

  const secrets = loadSecrets(secretsPath, options.rotateSecrets);
  writeSecrets(secretsPath, secrets);

  const wrangler = wranglerBinary();
  const writeConfig = (databaseId: string): void => {
    const config = buildWranglerConfig({
      name: options.name,
      databaseId,
      databaseName,
      main: join(ORIGIN_DIR, "src", "index.ts"),
      migrationsDir: MIGRATIONS_DIR,
      assetsDir,
      domain: options.domain,
      build: buildVersion(),
    });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  };
  // `wrangler d1 create --config` needs the file to exist, so write the
  // placeholder version first and replace the id once the database exists.
  writeConfig(PLACEHOLDER_DATABASE_ID);
  const databaseId = ensureDatabase(wrangler, databaseName, options, options.dryRun, configPath);
  writeConfig(databaseId);

  if (options.dryRun) {
    console.log(`selfhost: wrote ${configPath}`);
    console.log(`selfhost: wrote ${secretsPath}`);
    const result = run(
      [wrangler, "deploy", "--config", configPath, "--dry-run", "--secrets-file", secretsPath],
      { cwd: ORIGIN_DIR },
    );
    if (result.status !== 0) throw new Error("Wrangler rejected the generated config");
    console.log("selfhost: dry run passed; run without --dry-run to deploy");
    return;
  }

  // No separate login probe: every step below fails loudly with Wrangler's own
  // auth message, and `whoami` can sit on an interactive token lookup.
  applyMigrations(wrangler, configPath);
  const deployOutput = deployWorker(wrangler, configPath, secretsPath);
  // Wrangler prints the trigger URLs on success; keep the tail visible so the
  // operator sees the deployment summary.
  console.log(tail(deployOutput, 6).trim());

  const origin = options.origin
    ?? (options.domain ? `https://${options.domain}` : undefined)
    ?? parseDeployOrigin(deployOutput, options.name);
  if (!origin) {
    throw new Error(
      "The relay deployed, but its origin could not be read from Wrangler's output. " +
        "Copy the URL from the Cloudflare dashboard and rerun with --origin <URL>.",
    );
  }
  if (!options.noSmoke) {
    try {
      await smoke(origin);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `The relay is deployed at ${origin}; use --no-smoke to skip this check.`,
      );
    }
  }
  printSummary(origin, stateDir, secretsPath);
}

if (import.meta.main) {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if ("help" in parsed) {
      console.log(HELP);
    } else {
      await deploySelfhost(parsed);
    }
  } catch (error) {
    console.error(`selfhost: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
