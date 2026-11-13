/**
 * Parsing and configuration for the Cloudflare self-host relay deployer.
 *
 * This module is pure: it never runs Wrangler, reads the network or writes a
 * file. `selfhost-relay.ts` owns the side effects.
 */

export const DEFAULT_RELAY_NAME = "pairfob-relay";
export const SELFHOST_COMPATIBILITY_DATE = "2026-08-22";
/** Only used by --dry-run; never deployed. */
export const PLACEHOLDER_DATABASE_ID = "00000000-0000-0000-0000-000000000001";

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export type SelfhostOptions = {
  name: string;
  domain?: string;
  origin?: string;
  databaseId?: string;
  stateDir?: string;
  skipBuild: boolean;
  dryRun: boolean;
  noSmoke: boolean;
  rotateSecrets: boolean;
};

export type ParseResult = SelfhostOptions | { help: true };

export type SelfhostWranglerConfig = {
  name: string;
  main: string;
  compatibility_date: string;
  compatibility_flags: string[];
  workers_dev: boolean;
  preview_urls: boolean;
  vars: Record<string, string>;
  d1_databases: Array<{
    binding: string;
    database_name: string;
    database_id: string;
    migrations_dir: string;
  }>;
  durable_objects: {
    bindings: Array<{ name: string; class_name: string }>;
  };
  migrations: Array<{ tag: string; new_sqlite_classes: string[] }>;
  assets: {
    directory: string;
    binding: string;
    html_handling: string;
    run_worker_first: boolean;
  };
  routes?: Array<{ pattern: string; custom_domain: boolean }>;
};

export type DatabaseRow = { id: string; name: string };

/** The D1 database that belongs to a relay Worker. */
export function databaseNameFor(workerName: string): string {
  const name = `${workerName}-db`;
  if (name.length > 63) {
    throw new Error(`--name ${workerName} is too long: ${name} exceeds the 63-character D1 limit`);
  }
  return name;
}

export function validateWorkerName(value: string): string {
  const name = value.trim().toLowerCase();
  if (!NAME_RE.test(name)) {
    throw new Error("--name must be 1-63 lowercase letters, digits or hyphens, and must start and end with a letter or digit");
  }
  return name;
}

export function normalizeDomain(value: string): string {
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  if (!DOMAIN_RE.test(domain)) {
    throw new Error("--domain must be a web hostname such as relay.example.com, without a scheme, path or port");
  }
  return domain;
}

/**
 * An absolute http(s) origin with no credentials, path, query or fragment.
 * Plain http is accepted only for loopback so a local Wrangler origin can be
 * checked; a deployed self-host relay must use https.
 */
export function normalizeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`Invalid relay origin: ${value}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Relay origin must be http(s): ${value}`);
  }
  if (!url.hostname || url.username || url.password) {
    throw new Error(`Invalid relay origin: ${value}`);
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error(`Relay origin must not contain a path, query or fragment: ${value}`);
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    throw new Error(`Non-loopback relay origin must use https: ${value}`);
  }
  return url.origin;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function takeValue(argv: string[], index: number, inline: string | undefined, flag: string): [string, number] {
  if (inline !== undefined) return [inline, index];
  const next = index + 1;
  if (next >= argv.length) throw new Error(`${flag} needs a value`);
  return [argv[next], next];
}

function rejectInline(inline: string | undefined, flag: string): void {
  if (inline !== undefined) throw new Error(`${flag} does not take a value`);
}

export function parseArgs(argv: string[]): ParseResult {
  const options: SelfhostOptions = {
    name: DEFAULT_RELAY_NAME,
    skipBuild: false,
    dryRun: false,
    noSmoke: false,
    rotateSecrets: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const equals = raw.indexOf("=");
    const flag = equals >= 0 ? raw.slice(0, equals) : raw;
    const inline = equals >= 0 ? raw.slice(equals + 1) : undefined;
    switch (flag) {
      case "--name": {
        const [value, next] = takeValue(argv, index, inline, flag);
        options.name = validateWorkerName(value);
        index = next;
        break;
      }
      case "--domain": {
        const [value, next] = takeValue(argv, index, inline, flag);
        options.domain = normalizeDomain(value);
        index = next;
        break;
      }
      case "--origin": {
        const [value, next] = takeValue(argv, index, inline, flag);
        options.origin = normalizeOrigin(value);
        index = next;
        break;
      }
      case "--database-id": {
        const [value, next] = takeValue(argv, index, inline, flag);
        if (!value.trim()) throw new Error("--database-id cannot be empty");
        options.databaseId = value.trim();
        index = next;
        break;
      }
      case "--state-dir": {
        const [value, next] = takeValue(argv, index, inline, flag);
        if (!value.trim()) throw new Error("--state-dir cannot be empty");
        options.stateDir = value;
        index = next;
        break;
      }
      case "--skip-build":
        rejectInline(inline, flag);
        options.skipBuild = true;
        break;
      case "--dry-run":
        rejectInline(inline, flag);
        options.dryRun = true;
        break;
      case "--no-smoke":
        rejectInline(inline, flag);
        options.noSmoke = true;
        break;
      case "--rotate-secrets":
        rejectInline(inline, flag);
        options.rotateSecrets = true;
        break;
      case "-h":
      case "--help":
        rejectInline(inline, flag);
        return { help: true };
      default:
        throw new Error(`unknown argument: ${raw}`);
    }
  }
  // A custom origin needs a route, and only --domain creates one. Failing here
  // beats deploying to workers.dev and then failing the smoke check on a host
  // the Worker never served.
  if (options.origin && !options.domain) {
    const url = new URL(options.origin);
    if (url.protocol === "https:" && !url.hostname.endsWith(".workers.dev")) {
      throw new Error(
        `--origin ${options.origin} is not a workers.dev URL; pass --domain ${url.hostname} to route it`,
      );
    }
  }
  if (options.domain && options.origin && options.origin !== `https://${options.domain}`) {
    throw new Error(`--origin ${options.origin} does not match --domain ${options.domain}`);
  }
  return options;
}

export function buildWranglerConfig(input: {
  name: string;
  databaseId: string;
  databaseName: string;
  main: string;
  migrationsDir: string;
  assetsDir: string;
  domain?: string;
  build: string;
}): SelfhostWranglerConfig {
  const config: SelfhostWranglerConfig = {
    name: input.name,
    main: input.main,
    compatibility_date: SELFHOST_COMPATIBILITY_DATE,
    compatibility_flags: ["nodejs_compat", "enable_request_signal", "request_signal_passthrough"],
    workers_dev: !input.domain,
    preview_urls: false,
    vars: {
      BUILD: input.build,
      P2P_OPEN: "1",
      APP_ORIGINS: "https://localhost",
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: input.databaseName,
        database_id: input.databaseId,
        migrations_dir: input.migrationsDir,
      },
    ],
    durable_objects: {
      bindings: [
        { name: "DAEMON_ROOM", class_name: "DaemonRoom" },
        { name: "PAIRING_INDEX", class_name: "PairingIndex" },
      ],
    },
    migrations: [{ tag: "v1", new_sqlite_classes: ["DaemonRoom", "PairingIndex"] }],
    assets: {
      directory: input.assetsDir,
      binding: "ASSETS",
      html_handling: "auto-trailing-slash",
      run_worker_first: true,
    },
  };
  if (input.domain) config.routes = [{ pattern: input.domain, custom_domain: true }];
  return config;
}

function parseJsonArray(output: string): unknown[] {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("Wrangler returned no JSON array");
  const parsed: unknown = JSON.parse(output.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("Wrangler returned a non-array JSON value");
  return parsed;
}

export function parseD1List(output: string): DatabaseRow[] {
  const rows = parseJsonArray(output);
  const databases: DatabaseRow[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const id = typeof record.uuid === "string" ? record.uuid : typeof record.id === "string" ? record.id : "";
    const name = typeof record.name === "string" ? record.name : "";
    if (id && name) databases.push({ id, name });
  }
  return databases;
}

export function findDatabase(rows: DatabaseRow[], name: string): DatabaseRow | undefined {
  return rows.find((row) => row.name === name);
}

/** Read the database id out of `wrangler d1 create` output. */
export function parseD1CreateId(output: string): string | undefined {
  const match = output.match(
    /database_id["']?\s*[=:]\s*["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  return match?.[1];
}

/** Parse a Wrangler `.env`-style secrets file. */
export function parseEnvFile(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

/** Render a Wrangler `.env`-style secrets file; values must not need quoting. */
export function renderEnvFile(values: Record<string, string>): string {
  return `${Object.entries(values).map(([name, value]) => `${name}=${value}`).join("\n")}\n`;
}

/** Find the workers.dev URL Wrangler printed for this Worker. */
export function parseDeployOrigin(output: string, workerName: string): string | undefined {
  const matches = output.match(/https:\/\/[A-Za-z0-9][A-Za-z0-9.-]*\.workers\.dev(?::\d+)?/g);
  if (!matches) return undefined;
  const urls = [...new Set(matches.map((url) => url.replace(/[),.;]+$/, "")))];
  const preferred = urls.find((url) => {
    try {
      return new URL(url).hostname.split(".")[0] === workerName;
    } catch {
      return false;
    }
  }) ?? urls[0];
  return normalizeOrigin(preferred);
}

/** A minimal same-origin landing page for the self-hosted relay. */
export function renderRelayIndex(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Pairfob relay</title>
</head>
<body>
<main>
<h1>Pairfob relay</h1>
<p>This is a self-hosted Pairfob relay. Open the app to pair a computer.</p>
<p><a href="/pair">Open Pairfob</a></p>
</main>
</body>
</html>
`;
}
