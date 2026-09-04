import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const root = resolve(import.meta.dir, "../..");
const pairfobScript = join(import.meta.dir, "pairfob.sh");
const openPaneScript = join(import.meta.dir, "open-pane.sh");

type RunResult = { exit: number; stdout: string; stderr: string };

function run(script: string, args: string[], env: Record<string, string>): RunResult {
  const proc = Bun.spawnSync(["/bin/sh", script, ...args], {
    env: { HOME: env.HOME, PATH: "/usr/bin:/bin", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exit: proc.exitCode ?? 1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function fixture(): { dir: string; bin: string; log: string; live: string } {
  const dir = mkdtempSync(join(tmpdir(), "pairfob-plugin-"));
  const bin = join(dir, "pairfob");
  const log = join(dir, "calls.log");
  const live = join(dir, "live");
  writeFileSync(
    bin,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >>"$PAIRFOB_TEST_LOG"
case "$*" in
  "pair status") [ -f "$PAIRFOB_TEST_LIVE" ] ;;
  "service start" | "service install") : >"$PAIRFOB_TEST_LIVE" ;;
  "doctor") echo "Pairfob test health" ;;
  "pair") echo "Pairfob test pairing" ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return { dir, bin, log, live };
}

function testEnv(f: ReturnType<typeof fixture>): Record<string, string> {
  return {
    HOME: f.dir,
    PATH: `${f.dir}:/usr/bin:/bin`,
    PAIRFOB_TEST_LOG: f.log,
    PAIRFOB_TEST_LIVE: f.live,
  };
}

describe("Herdr plugin manifest", () => {
  test("declares global actions backed by the two interactive panes", () => {
    const manifest = Bun.TOML.parse(readFileSync(join(root, "herdr-plugin.toml"), "utf8")) as {
      id: string;
      name: string;
      version: string;
      min_herdr_version: string;
      platforms: string[];
      actions: Array<{
        id: string;
        title: string;
        description: string;
        contexts: string[];
        command: string[];
      }>;
      panes: Array<{
        id: string;
        title: string;
        description: string;
        placement: string;
        command: string[];
      }>;
      startup?: unknown;
    };

    expect(manifest.id).toBe("pairfob");
    expect(manifest.name).toBe("Pairfob");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.min_herdr_version).toBe("0.8.2");
    expect(manifest.platforms).toEqual(["linux", "macos"]);
    expect(manifest.actions).toEqual([
      expect.objectContaining({
        id: "pair",
        contexts: ["global"],
        command: ["sh", "plugin/herdr/open-pane.sh", "pair"],
      }),
      expect.objectContaining({
        id: "doctor",
        contexts: ["global"],
        command: ["sh", "plugin/herdr/open-pane.sh", "doctor"],
      }),
      expect.objectContaining({
        id: "start",
        contexts: ["global"],
        command: ["sh", "plugin/herdr/pairfob.sh", "start"],
      }),
      expect.objectContaining({
        id: "stop",
        contexts: ["global"],
        command: ["sh", "plugin/herdr/pairfob.sh", "stop"],
      }),
      expect.objectContaining({
        id: "update",
        contexts: ["global"],
        command: ["sh", "plugin/herdr/pairfob.sh", "update"],
      }),
    ]);
    expect(manifest.panes).toEqual([
      expect.objectContaining({
        id: "pair",
        placement: "overlay",
        command: ["sh", "plugin/herdr/pairfob.sh", "pair"],
      }),
      expect.objectContaining({
        id: "doctor",
        placement: "overlay",
        command: ["sh", "plugin/herdr/pairfob.sh", "doctor"],
      }),
    ]);
    expect(manifest.startup).toBeUndefined();
  });
});

describe("Herdr plugin entrypoints", () => {
  test("opens only a declared interactive pane with the injected Herdr binary", () => {
    const f = fixture();
    try {
      const herdr = join(f.dir, "herdr");
      writeFileSync(herdr, `#!/bin/sh\nprintf '%s\\n' "$*" >"$PAIRFOB_TEST_LOG"\n`);
      chmodSync(herdr, 0o755);
      const env = { ...testEnv(f), HERDR_BIN_PATH: herdr, HERDR_PLUGIN_ID: "pairfob" };

      expect(run(openPaneScript, ["pair"], env).exit).toBe(0);
      expect(readFileSync(f.log, "utf8").trim()).toBe(
        "plugin pane open --plugin pairfob --entrypoint pair --placement overlay --focus",
      );
      expect(run(openPaneScript, ["unknown"], env).exit).toBe(2);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("starts the user service before entering pairing", () => {
    const f = fixture();
    try {
      const got = run(pairfobScript, ["pair"], testEnv(f));
      expect(got.exit).toBe(0);
      expect(got.stdout).toContain("Pairfob is running.");
      expect(readFileSync(f.log, "utf8").trim().split("\n")).toEqual([
        "pair status",
        "service start",
        "pair status",
        "pair",
      ]);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("uses the repository installer on first pairing and then resolves its binary", () => {
    const f = fixture();
    try {
      const pluginRoot = join(f.dir, "plugin-root");
      const home = join(f.dir, "home");
      mkdirSync(join(pluginRoot, "scripts"), { recursive: true });
      mkdirSync(home, { recursive: true });
      const installer = join(pluginRoot, "scripts", "install.sh");
      writeFileSync(
        installer,
        `#!/bin/sh
set -eu
printf '%s\\n' install >>"$PAIRFOB_TEST_LOG"
mkdir -p "$HOME/.local/bin"
cp "$PAIRFOB_TEST_BINARY" "$HOME/.local/bin/pairfob"
chmod 0755 "$HOME/.local/bin/pairfob"
`,
      );
      const got = run(pairfobScript, ["pair"], {
        HOME: home,
        HERDR_PLUGIN_ROOT: pluginRoot,
        PAIRFOB_TEST_BINARY: f.bin,
        PAIRFOB_TEST_LOG: f.log,
        PAIRFOB_TEST_LIVE: f.live,
      });

      expect(got.exit).toBe(0);
      expect(got.stdout).toContain("Pairfob is not installed");
      expect(readFileSync(f.log, "utf8").trim().split("\n")).toEqual([
        "install",
        "pair status",
        "service start",
        "pair status",
        "pair",
      ]);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("doctor preserves an unhealthy exit while showing its output", () => {
    const f = fixture();
    try {
      writeFileSync(
        f.bin,
        `#!/bin/sh
printf '%s\\n' "$*" >>"$PAIRFOB_TEST_LOG"
echo "Pairfob unhealthy"
exit 1
`,
      );
      chmodSync(f.bin, 0o755);
      const got = run(pairfobScript, ["doctor"], testEnv(f));
      expect(got.exit).toBe(1);
      expect(got.stdout).toContain("Pairfob unhealthy");
      expect(readFileSync(f.log, "utf8").trim()).toBe("doctor");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("routes noninteractive controls to the installed CLI without bootstrapping", () => {
    for (const [entrypoint, commands] of [
      ["start", ["pair status", "service start", "pair status"]],
      ["stop", ["service stop"]],
      ["update", ["update"]],
    ]) {
      const f = fixture();
      try {
        const got = run(pairfobScript, [entrypoint], testEnv(f));
        expect(got.exit, entrypoint).toBe(0);
        expect(readFileSync(f.log, "utf8").trim().split("\n"), entrypoint).toEqual(commands);
      } finally {
        rmSync(f.dir, { recursive: true, force: true });
      }
    }
  });

  test("installs the user service when starting an unregistered service", () => {
    const f = fixture();
    try {
      writeFileSync(
        f.bin,
        `#!/bin/sh
set -eu
printf '%s\\n' "$*" >>"$PAIRFOB_TEST_LOG"
case "$*" in
  "pair status") [ -f "$PAIRFOB_TEST_LIVE" ] ;;
  "service start") exit 1 ;;
  "service install") : >"$PAIRFOB_TEST_LIVE" ;;
esac
`,
      );
      chmodSync(f.bin, 0o755);

      const got = run(pairfobScript, ["start"], testEnv(f));
      expect(got.exit).toBe(0);
      expect(readFileSync(f.log, "utf8").trim().split("\n")).toEqual([
        "pair status",
        "service start",
        "service install",
        "pair status",
      ]);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("fails closed when the service never becomes ready", () => {
    const f = fixture();
    try {
      writeFileSync(
        f.bin,
        `#!/bin/sh
printf '%s\\n' "$*" >>"$PAIRFOB_TEST_LOG"
case "$*" in
  "pair status") exit 1 ;;
  "service start") exit 0 ;;
esac
`,
      );
      chmodSync(f.bin, 0o755);
      const sleep = join(f.dir, "sleep");
      writeFileSync(sleep, "#!/bin/sh\nexit 0\n");
      chmodSync(sleep, 0o755);

      const got = run(pairfobScript, ["start"], testEnv(f));
      expect(got.exit).toBe(1);
      expect(got.stderr).toContain("the background service did not become ready");
      expect(readFileSync(f.log, "utf8").trim().split("\n")).toHaveLength(42);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  test("does not bootstrap Pairfob for a non-pairing action", () => {
    const f = fixture();
    try {
      rmSync(f.bin);
      const got = run(pairfobScript, ["stop"], testEnv(f));
      expect(got.exit).toBe(1);
      expect(got.stderr).toContain("Pairfob is not installed");
      expect(got.stdout).not.toContain("downloading");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});
