import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RELAY_NAME,
  PLACEHOLDER_DATABASE_ID,
  buildWranglerConfig,
  databaseNameFor,
  findDatabase,
  normalizeDomain,
  normalizeOrigin,
  parseArgs,
  parseD1CreateId,
  parseD1List,
  parseDeployOrigin,
  parseEnvFile,
  renderEnvFile,
  renderRelayIndex,
  validateWorkerName,
} from "./selfhost-config.ts";

describe("validateWorkerName", () => {
  test("accepts a Worker name", () => {
    expect(validateWorkerName("pairfob-relay")).toBe("pairfob-relay");
    expect(validateWorkerName(" A1 ")).toBe("a1");
  });

  test("rejects names Workers will not accept", () => {
    expect(() => validateWorkerName("")).toThrow();
    expect(() => validateWorkerName("-relay")).toThrow();
    expect(() => validateWorkerName("relay_1")).toThrow();
    expect(() => validateWorkerName("relay.example.com")).toThrow();
  });
});

describe("databaseNameFor", () => {
  test("derives the database name from the Worker", () => {
    expect(databaseNameFor("pairfob-relay")).toBe("pairfob-relay-db");
  });

  test("refuses a name that overflows the D1 limit", () => {
    expect(() => databaseNameFor("a".repeat(61))).toThrow();
  });
});

describe("normalizeDomain", () => {
  test("normalizes case and a trailing dot", () => {
    expect(normalizeDomain("Relay.Example.COM.")).toBe("relay.example.com");
  });

  test("rejects a scheme, path or port", () => {
    expect(() => normalizeDomain("https://relay.example.com")).toThrow();
    expect(() => normalizeDomain("relay.example.com/pair")).toThrow();
    expect(() => normalizeDomain("relay.example.com:8443")).toThrow();
    expect(() => normalizeDomain("localhost")).toThrow();
  });
});

describe("normalizeOrigin", () => {
  test("keeps an https origin and drops a trailing slash", () => {
    expect(normalizeOrigin("https://relay.example.com/")).toBe("https://relay.example.com");
    expect(normalizeOrigin("https://relay.example.com:8443")).toBe("https://relay.example.com:8443");
  });

  test("allows plain http only for loopback", () => {
    expect(normalizeOrigin("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(normalizeOrigin("http://localhost:8787")).toBe("http://localhost:8787");
    expect(() => normalizeOrigin("http://relay.example.com")).toThrow();
  });

  test("rejects paths, credentials and other schemes", () => {
    expect(() => normalizeOrigin("https://relay.example.com/pair")).toThrow();
    expect(() => normalizeOrigin("https://user:pass@relay.example.com")).toThrow();
    expect(() => normalizeOrigin("wss://relay.example.com")).toThrow();
    expect(() => normalizeOrigin("not a url")).toThrow();
  });
});

describe("parseArgs", () => {
  test("uses defaults", () => {
    const options = parseArgs([]);
    if ("help" in options) throw new Error("expected options");
    expect(options).toEqual({
      name: DEFAULT_RELAY_NAME,
      skipBuild: false,
      dryRun: false,
      noSmoke: false,
      rotateSecrets: false,
    });
  });

  test("accepts space and inline values", () => {
    const options = parseArgs([
      "--name", "my-relay",
      "--domain=relay.example.com",
      "--database-id", "11111111-1111-1111-1111-111111111111",
      "--state-dir", "./state",
      "--skip-build",
      "--dry-run",
      "--no-smoke",
      "--rotate-secrets",
    ]);
    if ("help" in options) throw new Error("expected options");
    expect(options.name).toBe("my-relay");
    expect(options.domain).toBe("relay.example.com");
    expect(options.databaseId).toBe("11111111-1111-1111-1111-111111111111");
    expect(options.stateDir).toBe("./state");
    expect(options.skipBuild).toBe(true);
    expect(options.dryRun).toBe(true);
    expect(options.noSmoke).toBe(true);
    expect(options.rotateSecrets).toBe(true);
  });

  test("returns help", () => {
    expect(parseArgs(["--help"])).toEqual({ help: true });
  });

  test("rejects a mismatched domain and origin", () => {
    expect(() => parseArgs(["--domain", "relay.example.com", "--origin", "https://other.example.com"])).toThrow();
  });

  test("accepts a matching domain and origin", () => {
    const options = parseArgs(["--domain", "relay.example.com", "--origin", "https://relay.example.com/"]);
    if ("help" in options) throw new Error("expected options");
    expect(options.origin).toBe("https://relay.example.com");
  });

  test("accepts a workers.dev origin without a domain", () => {
    const options = parseArgs(["--origin", "https://my-relay.me.workers.dev"]);
    if ("help" in options) throw new Error("expected options");
    expect(options.origin).toBe("https://my-relay.me.workers.dev");
    expect(options.domain).toBeUndefined();
  });

  test("rejects a custom origin without a domain route", () => {
    expect(() => parseArgs(["--origin", "https://relay.example.com"])).toThrow();
  });

  test("rejects unknown arguments and a missing value", () => {
    expect(() => parseArgs(["--nope"])).toThrow();
    expect(() => parseArgs(["--name"])).toThrow();
    expect(() => parseArgs(["--dry-run=1"])).toThrow();
  });
});

describe("buildWranglerConfig", () => {
  test("enables workers.dev and binds the relay resources", () => {
    const config = buildWranglerConfig({
      name: "my-relay",
      databaseId: PLACEHOLDER_DATABASE_ID,
      databaseName: "my-relay-db",
      main: "/repo/workers/pairfob-origin/src/index.ts",
      migrationsDir: "/repo/workers/pairfob-origin/migrations",
      assetsDir: "/repo/.dev/selfhost/my-relay/public",
      build: "selfhost-2026-11-12",
    });
    expect(config.workers_dev).toBe(true);
    expect(config.routes).toBeUndefined();
    expect(config.main).toBe("/repo/workers/pairfob-origin/src/index.ts");
    expect(config.d1_databases[0]).toEqual({
      binding: "DB",
      database_name: "my-relay-db",
      database_id: PLACEHOLDER_DATABASE_ID,
      migrations_dir: "/repo/workers/pairfob-origin/migrations",
    });
    expect(config.durable_objects.bindings.map((binding) => binding.name)).toEqual([
      "DAEMON_ROOM",
      "PAIRING_INDEX",
    ]);
    expect(config.migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["DaemonRoom", "PairingIndex"] },
    ]);
    expect(config.assets).toEqual({
      directory: "/repo/.dev/selfhost/my-relay/public",
      binding: "ASSETS",
      html_handling: "auto-trailing-slash",
      run_worker_first: true,
    });
    expect(config.vars.P2P_OPEN).toBe("1");
    expect(config.vars.BUILD).toBe("selfhost-2026-11-12");
  });

  test("uses a custom domain with workers.dev off", () => {
    const config = buildWranglerConfig({
      name: "my-relay",
      databaseId: PLACEHOLDER_DATABASE_ID,
      databaseName: "my-relay-db",
      main: "/main.ts",
      migrationsDir: "/migrations",
      assetsDir: "/public",
      domain: "relay.example.com",
      build: "build",
    });
    expect(config.workers_dev).toBe(false);
    expect(config.routes).toEqual([{ pattern: "relay.example.com", custom_domain: true }]);
  });
});

describe("Wrangler output parsers", () => {
  test("parseD1List reads uuid and name", () => {
    const output = `[
      { "uuid": "11111111-1111-1111-1111-111111111111", "name": "relay-db", "version": "production" },
      { "id": "22222222-2222-2222-2222-222222222222", "name": "other" },
      { "uuid": "bad" }
    ]`;
    expect(parseD1List(output)).toEqual([
      { id: "11111111-1111-1111-1111-111111111111", name: "relay-db" },
      { id: "22222222-2222-2222-2222-222222222222", name: "other" },
    ]);
    expect(findDatabase(parseD1List(output), "relay-db")?.id).toBe(
      "11111111-1111-1111-1111-111111111111",
    );
  });

  test("parseD1List tolerates Wrangler's preamble", () => {
    const output = `⛅️ wrangler 4.126.0
[
  { "uuid": "11111111-1111-1111-1111-111111111111", "name": "relay-db" }
]`;
    expect(parseD1List(output)).toHaveLength(1);
  });

  test("parseD1List rejects non-JSON output", () => {
    expect(() => parseD1List("no json here")).toThrow();
  });

  test("parseD1CreateId reads the TOML snippet", () => {
    const output = `[[d1_databases]]
binding = "DB"
database_name = "relay-db"
database_id = "33333333-3333-3333-3333-333333333333"`;
    expect(parseD1CreateId(output)).toBe("33333333-3333-3333-3333-333333333333");
    expect(parseD1CreateId("nothing")).toBeUndefined();
  });

  test("parseDeployOrigin prefers this Worker's URL", () => {
    const output = `Deployed my-relay triggers
  https://my-relay.example-account.workers.dev
  https://some-other.workers.dev
`;
    expect(parseDeployOrigin(output, "my-relay")).toBe("https://my-relay.example-account.workers.dev");
    // Without a name match, the first trigger URL is the best guess.
    expect(parseDeployOrigin(output, "unknown")).toBe("https://my-relay.example-account.workers.dev");
    expect(parseDeployOrigin("no url", "my-relay")).toBeUndefined();
  });
});

describe("secrets file", () => {
  test("parses and renders the Wrangler env format", () => {
    const values = { OPERATOR_TOKEN: "abc", IP_HASH_PEPPER: "def" };
    expect(renderEnvFile(values)).toBe("OPERATOR_TOKEN=abc\nIP_HASH_PEPPER=def\n");
    expect([...parseEnvFile(renderEnvFile(values))]).toEqual(Object.entries(values));
  });

  test("ignores comments and blank lines", () => {
    expect(parseEnvFile("# secrets\n\nOPERATOR_TOKEN=abc\n").get("OPERATOR_TOKEN")).toBe("abc");
  });
});

describe("renderRelayIndex", () => {
  test("links to the app without scripts", () => {
    const html = renderRelayIndex();
    expect(html).toContain('href="/pair"');
    expect(html).toContain('content="noindex"');
    expect(html).not.toContain("<script");
  });
});
