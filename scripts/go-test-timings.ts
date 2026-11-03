/**
 * Build the Go test weight manifest from `go test -json` output.
 *
 *   go test -json -count=1 ./... | bun scripts/go-test-timings.ts --mode test
 *   go test -json -race -count=1 ./... | bun scripts/go-test-timings.ts --mode race --merge scripts/go-test-timings.json
 *
 * Shards use the manifest only to balance work; a missing entry falls back to
 * a default weight and still runs the test. The longest observed duration
 * wins, so a slow machine that once ran a test does not make it disappear
 * from later plans. Rebuild one mode at a time so a race run cannot overwrite
 * the ordinary measurements, and pass `--merge` to keep the other mode's
 * entries and the hand-maintained `subtests` list.
 */
import { readFileSync } from "node:fs";

interface TestEvent {
  Action?: string;
  Package?: string;
  Test?: string;
  Elapsed?: number;
}

export type GoTestMode = "test" | "race";

export interface GoTestTimings {
  version: 1;
  tests: Record<string, number>;
  packages: Record<string, number>;
}

export function collectTimings(events: TestEvent[], minMs = 0): GoTestTimings {
  const tests: Record<string, number> = {};
  const packages: Record<string, number> = {};
  for (const event of events) {
    if (event.Action !== "pass" || !event.Package) continue;
    const elapsed = Math.round((event.Elapsed ?? 0) * 1000);
    if (elapsed < minMs) continue;
    if (event.Test) {
      // Subtests are kept because the manifest can list a table test's cases
      // as separate shard units; a parent that is not split still uses its own
      // entry, so the extra rows cost nothing.
      const key = `${event.Package}::${event.Test}`;
      tests[key] = Math.max(tests[key] ?? 0, elapsed);
    } else {
      packages[event.Package] = Math.max(packages[event.Package] ?? 0, elapsed);
    }
  }
  return { version: 1, tests: sorted(tests), packages: sorted(packages) };
}

/** Put one mode's measurements into an existing manifest without dropping the other. */
export function mergeTimings(
  base: Record<string, unknown>,
  mode: GoTestMode,
  timings: GoTestTimings,
): Record<string, unknown> {
  const testsKey = mode === "race" ? "raceTests" : "tests";
  const packagesKey = mode === "race" ? "racePackages" : "packages";
  return {
    ...base,
    version: 1,
    [testsKey]: keepSlowest(base[testsKey] as Record<string, number> | undefined, timings.tests),
    [packagesKey]: keepSlowest(base[packagesKey] as Record<string, number> | undefined, timings.packages),
  };
}

/**
 * A partial or interrupted run must not erase measurements it did not cover,
 * and a slow machine that once ran a test must not lose that weight later.
 */
function keepSlowest(base: Record<string, number> | undefined, next: Record<string, number>): Record<string, number> {
  const merged: Record<string, number> = { ...base };
  for (const [key, value] of Object.entries(next)) merged[key] = Math.max(merged[key] ?? 0, value);
  return sorted(merged);
}

function sorted(values: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(values).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
}

function usage(): never {
  console.error("usage: go-test-timings.ts [--mode test|race] [--min-ms <n>] [--merge <manifest>] < events.ndjson");
  process.exit(2);
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const options = new Map<string, string>();
    for (let index = 0; index < args.length; index += 2) {
      if (index + 1 >= args.length || !args[index].startsWith("--")) usage();
      options.set(args[index], args[index + 1]);
    }
    const mode = options.get("--mode") ?? "test";
    if (mode !== "test" && mode !== "race") usage();
    const minMs = Number(options.get("--min-ms") ?? 0);
    if (!Number.isFinite(minMs) || minMs < 0) usage();
    const mergePath = options.get("--merge");
    const base = mergePath
      ? (JSON.parse(readFileSync(mergePath, "utf8")) as Record<string, unknown>)
      : { version: 1 };

    const input = await Bun.stdin.text();
    const events: TestEvent[] = [];
    for (const line of input.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as TestEvent);
      } catch {
        // A package that prints plain text in JSON mode still leaves the
        // other events usable; only its weights are missing.
      }
    }
    const timings = collectTimings(events, minMs);
    process.stdout.write(JSON.stringify(mergeTimings(base, mode, timings), null, 2) + "\n");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}