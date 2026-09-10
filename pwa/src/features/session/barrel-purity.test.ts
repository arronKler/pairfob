import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pwaRoot = fileURLToPath(new URL("../../..", import.meta.url));
const barrel = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

type ProbeResult = { module: string; ok: boolean; error?: string };
type ProbeReport = {
  ok: boolean;
  publicEntry: string;
  checked: number;
  results: ProbeResult[];
  adapters: ProbeResult[];
  canary: ProbeResult;
  canaryPresent: ProbeResult;
};

describe("public session owner/model barrel", () => {
  test("does not re-export imperative DOM adapters from 4a81 or swipe colocation", () => {
    expect(barrel).not.toContain('from "./term-mode"');
    expect(barrel).not.toContain('from "./guided/pane-swipe"');
    expect(barrel).not.toContain("resolvedPaneTermMode");
    expect(barrel).not.toContain("selectPaneTermMode");
    expect(barrel).not.toContain("armSwipeHint");
    expect(barrel).not.toContain("initSwipeBack");
    expect(barrel).not.toContain("pane-swipe");
    expect(barrel).not.toContain("term-mode");
  });

  // Combined-suite load can exceed Bun's 5s default; isolated run is ~2.6s.
  test("a fresh process with no browser globals can import the entire public barrel", () => {
    const run = Bun.spawnSync({
      cmd: [process.execPath, "scripts/session-barrel-purity-probe.ts"],
      cwd: pwaRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new TextDecoder().decode(run.stdout);
    const report = JSON.parse(stdout) as ProbeReport;
    expect(report.publicEntry).toBe("../src/features/session/index.ts");
    expect(report.results[0]).toEqual({ module: "../src/features/session/index.ts", ok: true });
    expect(report.results.filter((entry) => !entry.ok)).toEqual([]);
    expect(report.adapters.map((entry) => entry.module)).toEqual([
      "../src/features/session/term-mode.ts",
      "../src/features/session/guided/pane-swipe.ts",
    ]);
    // The two former barrel adapters now cold-import pure; the isolated
    // DOM-access detection is proven by the canary instead.
    expect(report.adapters.every((entry) => entry.ok)).toBeTrue();
    expect(report.canary.ok).toBeFalse();
    expect(/document/i.test(report.canary.error ?? "")).toBeTrue();
    expect(report.canaryPresent.ok).toBeTrue();
    expect(report.ok).toBeTrue();
    expect(report.checked).toBe(8);
    expect(run.exitCode).toBe(0);
  }, 15_000);
});
