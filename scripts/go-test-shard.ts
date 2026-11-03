/**
 * Split Go tests into balanced shards for parallel runs.
 *
 * Packages already run in parallel inside one `go test` invocation, but a
 * single large package (internal/daemon) still runs its tests one at a time.
 * This inventories the top-level tests, places them on the least loaded shard
 * by measured weight, and runs each shard as a sequence of `go test` calls.
 * Every test runs exactly once across the shards, under the race detector by
 * default; the ordinary build is added only for a package whose build-tagged
 * test files differ between the two builds.
 *
 * `--build` links the split packages' test binaries once per mode and
 * `--bindir` runs that shard from those binaries. The go tool loads and links
 * the same package in every shard that selects its tests; the direct binary
 * keeps that fixed cost out of the shard. Whole packages stay with `go test`,
 * because each appears in one shard only. Without `--bindir` every command is
 * a `go test` call, which lets Go's test-result cache replay unchanged work.
 */
import { execFileSync } from "node:child_process";
import { execFile as execFileCallback } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const DEFAULT_TEST_MS = 800;
const DEFAULT_FILE_MS = 1000;
const PACKAGE_OVERHEAD_MS = 150;
/** A package worth splitting must be able to fill roughly a quarter shard. */
const SPLIT_MIN_MS = 4000;
const SPLIT_MIN_FILES = 10;
/** Test binaries are linked once; shards then run them directly. */
const TEST_TIMEOUT = "20m";

export interface GoPackage {
  path: string;
  /** Source directory the test binary runs in, matching `go test`. */
  dir?: string;
  files: number;
  /** Top-level test names when the package is split; null keeps it whole. */
  tests: string[] | null;
  /**
   * Builds that contain test files for this package. The ordinary build is
   * listed only when its test files differ from the race build's: otherwise
   * the race run executes exactly the same tests with stricter instrumentation.
   */
  modes?: GoTestMode[];
}

export interface ListedPackage {
  path: string;
  dir: string;
  files: number;
  tests: string[];
  testFiles: string[];
  modes: GoTestMode[];
}

export interface GoInventory {
  version: 1;
  packages: GoPackage[];
}

export interface GoTestWeights {
  version: 1;
  tests?: Record<string, number>;
  packages?: Record<string, number>;
  /** Race-build measurements; the race detector changes the shape of the cost. */
  raceTests?: Record<string, number>;
  racePackages?: Record<string, number>;
  /**
   * Subtests of table tests whose cases are big enough to deserve their own
   * shard. The key is `pkg::Test`; the parent test's normal run would execute
   * every case, so listed cases replace it.
   */
  subtests?: Record<string, string[]>;
}

export type GoTestMode = "test" | "race";
/** One coverage plan: race-first units plus the builds that need ordinary mode. */
export type GoTestPlanMode = GoTestMode | "coverage";

export interface GoTestUnit {
  pkg: string;
  /** null runs the whole package; otherwise only these top-level tests. */
  tests: string[] | null;
  weight: number;
  /** Set when units from both modes are pooled for one plan. */
  mode?: GoTestMode;
  /** Cases this unit must not run, used by the parent test's remainder. */
  skip?: string[];
}

/** Every package under the module with a test file, and its test names. */
export function listTestPackages(root: string): ListedPackage[] {
  // `go test -race` sets the race build tag, so a race-tagged test file exists
  // only in that configuration. Both listings are merged for the test names,
  // while `modes` records which builds actually need a run.
  const ordinary = new Map(listPackages(root, []).map((entry) => [entry.path, entry]));
  const raced = new Map(listPackages(root, ["-tags", "race"]).map((entry) => [entry.path, entry]));
  const packages: ListedPackage[] = [];
  for (const path of new Set([...ordinary.keys(), ...raced.keys()])) {
    const plain = ordinary.get(path);
    const tagged = raced.get(path);
    const base = tagged ?? plain!;
    packages.push({
      path,
      dir: base.dir,
      files: Math.max(plain?.files ?? 0, tagged?.files ?? 0),
      tests: [...new Set([...(plain?.tests ?? []), ...(tagged?.tests ?? [])])],
      testFiles: [...new Set([...(plain?.testFiles ?? []), ...(tagged?.testFiles ?? [])])],
      modes: testFileModes(plain?.testFiles ?? null, tagged?.testFiles ?? null),
    });
  }
  return packages;
}

/**
 * Which builds need a run for a package. Identical test files mean the race
 * run covers the ordinary run; only a build-tagged file (`//go:build race` or
 * `!race`) makes the two configurations differ and needs both.
 */
export function testFileModes(ordinary: string[] | null, race: string[] | null): GoTestMode[] {
  if (!race) return ordinary ? ["test"] : [];
  if (!ordinary) return ["race"];
  const left = [...ordinary].sort().join("\n");
  const right = [...race].sort().join("\n");
  return left === right ? ["race"] : ["test", "race"];
}

function listPackages(root: string, tags: string[]): ListedPackage[] {
  const output = execFileSync("go", [
    "list", ...tags, "-f",
    "{{.ImportPath}}\t{{.Dir}}\t{{len .TestGoFiles}}\t{{len .XTestGoFiles}}\t{{range .TestGoFiles}}{{.}} {{end}}\t{{range .XTestGoFiles}}{{.}} {{end}}",
    "./...",
  ], { cwd: root, encoding: "utf8" });
  const packages: ListedPackage[] = [];
  for (const line of output.split("\n")) {
    const [path, dir, internal, external, testFiles, xtestFiles] = line.split("\t");
    const files = Number(internal) + Number(external);
    if (!path || files === 0) continue;
    const names = `${testFiles ?? ""} ${xtestFiles ?? ""}`.split(" ").filter(Boolean);
    packages.push({ path, dir, files, tests: [...new Set(declaredTests(dir, names))], testFiles: [...new Set(names)], modes: [] });
  }
  return packages;
}

/**
 * Top-level test, example and fuzz names declared in the given files. Reading
 * the source avoids compiling a test binary just to learn the names; a name
 * hidden behind a build tag is harmless, since `-run` simply matches nothing.
 */
export function declaredTests(dir: string, files: string[]): string[] {
  const names: string[] = [];
  const declaration = /^func\s+(Test(?!Main\b)[A-Za-z0-9_]*|Example[A-Za-z0-9_]*|Fuzz[A-Za-z0-9_]*)\s*\(/gm;
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(join(dir, file), "utf8");
    } catch {
      continue;
    }
    for (const match of source.matchAll(declaration)) names.push(match[1]);
  }
  return names;
}

export function loadWeights(path: string): GoTestWeights {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as GoTestWeights;
    if (parsed?.version === 1) return parsed;
  } catch {
    // A missing manifest only changes balance, never which tests run.
  }
  return { version: 1 };
}

export function testWeight(weights: GoTestWeights, pkg: string, test: string, mode: GoTestMode = "test"): number {
  const key = `${pkg}::${test}`;
  const race = mode === "race" ? weights.raceTests?.[key] : undefined;
  return race ?? weights.tests?.[key] ?? DEFAULT_TEST_MS;
}

export function packageWeight(
  weights: GoTestWeights,
  pkg: string,
  files: number,
  tests: string[] | null,
  mode: GoTestMode = "test",
): number {
  const race = mode === "race" ? weights.racePackages?.[pkg] : undefined;
  const measured = race ?? weights.packages?.[pkg];
  if (measured !== undefined) return measured;
  if (tests) {
    return tests.reduce((sum, test) => sum + testWeight(weights, pkg, test, mode), 0) + PACKAGE_OVERHEAD_MS;
  }
  return files * DEFAULT_FILE_MS + PACKAGE_OVERHEAD_MS;
}

/** The slower of the two measured modes decides whether a package is worth splitting. */
function measuredPackage(weights: GoTestWeights, pkg: string): number | undefined {
  const test = weights.packages?.[pkg];
  const race = weights.racePackages?.[pkg];
  if (test === undefined) return race;
  if (race === undefined) return test;
  return Math.max(test, race);
}

/** Decide which packages are worth splitting, then name their tests. */
export function buildInventory(root: string, weights: GoTestWeights): GoInventory {
  const packages: GoPackage[] = [];
  for (const entry of listTestPackages(root)) {
    const measured = measuredPackage(weights, entry.path);
    const heavy = (measured !== undefined && measured >= SPLIT_MIN_MS) || entry.files >= SPLIT_MIN_FILES;
    const tests = heavy ? entry.tests : [];
    packages.push({ path: entry.path, dir: entry.dir, files: entry.files, tests: tests.length > 1 ? tests : null, modes: entry.modes });
  }
  return { version: 1, packages };
}

/** Deduplicate cases and drop a nested case when its parent is already listed. */
export function subtestNames(names: string[]): string[] {
  const unique = [...new Set(names)];
  return unique.filter((name) => !unique.some((other) => other !== name && name.startsWith(`${other}/`)));
}

/** An inventory written before `modes` existed assumed both builds. */
function packageModes(pkg: GoPackage): GoTestMode[] {
  return pkg.modes ?? ["test", "race"];
}

/** One runnable unit per whole package or per test of a split package. */
export function inventoryUnits(inventory: GoInventory, weights: GoTestWeights, mode: GoTestMode = "test"): GoTestUnit[] {
  const units: GoTestUnit[] = [];
  for (const pkg of inventory.packages) {
    if (!packageModes(pkg).includes(mode)) continue;
    if (pkg.tests) {
      for (const test of pkg.tests) {
        const listed = subtestNames(weights.subtests?.[`${pkg.path}::${test}`] ?? []);
        if (listed.length === 0) {
          units.push({ pkg: pkg.path, tests: [test], weight: testWeight(weights, pkg.path, test, mode) + PACKAGE_OVERHEAD_MS, mode });
          continue;
        }
        let splitWeight = 0;
        for (const subtest of listed) {
          const weight = testWeight(weights, pkg.path, `${test}/${subtest}`, mode) + PACKAGE_OVERHEAD_MS;
          splitWeight += weight;
          units.push({ pkg: pkg.path, tests: [`${test}/${subtest}`], weight, mode });
        }
        // A table case added after the manifest was written is still covered:
        // the parent runs with the listed cases skipped and picks up the rest.
        units.push({
          pkg: pkg.path,
          tests: [test],
          skip: listed,
          weight: Math.max(0, testWeight(weights, pkg.path, test, mode) + PACKAGE_OVERHEAD_MS - splitWeight),
          mode,
        });
      }
    } else {
      units.push({
        pkg: pkg.path,
        tests: null,
        weight: packageWeight(weights, pkg.path, pkg.files, null, mode),
        mode,
      });
    }
  }
  return units;
}

/**
 * Race-first coverage: every test runs once under the detector. The ordinary
 * build adds units only for packages whose build-tagged test files differ,
 * because `inventoryUnits` filters by each package's `modes`. Tests that are
 * not build-tagged are not executed twice for no extra signal.
 */
export function coverageUnits(inventory: GoInventory, weights: GoTestWeights): GoTestUnit[] {
  return [...inventoryUnits(inventory, weights, "race"), ...inventoryUnits(inventory, weights, "test")];
}

/**
 * Assign the heaviest unit to the least loaded shard. Ties fall to the lower
 * index, so an even split also spreads equal-sized packages across shards.
 * Name ties compare byte-wise: locale collation must not change which shard a
 * test lands in, because CI computes the plan independently in every job.
 */
export function shardUnits(units: GoTestUnit[], total: number): GoTestUnit[][] {
  if (!Number.isInteger(total) || total < 1) throw new Error("shard total must be a positive integer");
  const buckets: GoTestUnit[][] = Array.from({ length: total }, () => []);
  const loads = new Array<number>(total).fill(0);
  const ordered = [...units].sort((left, right) =>
    right.weight - left.weight || compareNames(left.pkg, right.pkg) || compareNames(left.tests?.[0] ?? "", right.tests?.[0] ?? ""));
  for (const unit of ordered) {
    let target = 0;
    for (let index = 1; index < total; index++) {
      if (loads[index] < loads[target]) target = index;
    }
    buckets[target].push(unit);
    loads[target] += unit.weight;
  }
  return buckets;
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Go matches each slash-separated part of `-run` against one name element. */
export function runExpression(tests: string[]): string {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (tests.length === 1 && tests[0].includes("/")) {
    return tests[0].split("/").map((part) => `^${escape(part)}$`).join("/");
  }
  return `^(${tests.map(escape).join("|")})$`;
}

/**
 * Skip the listed cases of one top-level test. The parent name is its own
 * slash-separated element; a top-level alternation would match the test name
 * itself and skip nothing, running every case again in the remainder.
 */
export function skipExpression(test: string, skip: string[]): string {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `^${escape(test)}$/^(${skip.map(escape).join("|")})$`;
}

interface Command {
  label: string;
  args: string[];
  mode: GoTestMode;
}

/**
 * One command for the shard's whole packages, then one per split package.
 * `go vet ./...` runs beside the shards, so the test tool does not repeat its
 * vet subset on every invocation.
 */
function commandsForMode(units: GoTestUnit[], mode: GoTestMode): Command[] {
  const flags = ["-vet=off", "-timeout", "20m", "-p", "1"];
  if (mode === "race") flags.unshift("-race");
  const commands: Command[] = [];
  const whole = units.filter((unit) => unit.tests === null).map((unit) => unit.pkg);
  if (whole.length > 0) commands.push({ label: `${whole.length} package(s)`, args: [...flags, ...whole], mode });

  const split = new Map<string, string[]>();
  for (const unit of units) {
    if (!unit.tests) continue;
    // A remainder and a subtest each need their own expression; combining
    // them with another test's `/` parts would select the cross product.
    if (unit.skip) {
      commands.push({
        label: `${unit.pkg} ${unit.tests[0]} (unlisted cases)`,
        args: [...flags, "-run", runExpression(unit.tests), "-skip", skipExpression(unit.tests[0], unit.skip), unit.pkg],
        mode,
      });
      continue;
    }
    if (unit.tests[0].includes("/")) {
      commands.push({ label: `${unit.pkg} ${unit.tests[0]}`, args: [...flags, "-run", runExpression(unit.tests), unit.pkg], mode });
      continue;
    }
    const tests = split.get(unit.pkg) ?? [];
    tests.push(...unit.tests);
    split.set(unit.pkg, tests);
  }
  const groups = [...split.entries()].sort((left, right) => right[1].length - left[1].length);
  for (const [pkg, tests] of groups) {
    commands.push({ label: `${pkg} (${tests.length} tests)`, args: [...flags, "-run", runExpression(tests), pkg], mode });
  }
  return commands;
}

/** Whole-command order is irrelevant, but race work starts first when pooled. */
export function shardCommands(units: GoTestUnit[], fallback: GoTestMode): Command[] {
  const modes = new Set(units.map((unit) => unit.mode ?? fallback));
  if (modes.size <= 1) return commandsForMode(units, modes.has("race") ? "race" : fallback);
  const commands: Command[] = [];
  for (const mode of ["race", "test"] as const) {
    const subset = units.filter((unit) => (unit.mode ?? fallback) === mode);
    if (subset.length > 0) commands.push(...commandsForMode(subset, mode));
  }
  return commands;
}

/**
 * The same grouping for prebuilt binaries: a whole package is one binary run,
 * and each split package keeps one run per mode with a `-test.run` selector.
 */
export function binaryCommands(units: GoTestUnit[], fallback: GoTestMode): { pkg: string; tests: string[] | null; mode: GoTestMode; skip?: string[] }[] {
  const commands: { pkg: string; tests: string[] | null; mode: GoTestMode; skip?: string[] }[] = [];
  for (const mode of ["race", "test"] as const) {
    const subset = units.filter((unit) => (unit.mode ?? fallback) === mode);
    const split = new Map<string, string[]>();
    for (const unit of subset) {
      if (!unit.tests) {
        commands.push({ pkg: unit.pkg, tests: null, mode });
      } else if (unit.skip) {
        commands.push({ pkg: unit.pkg, tests: unit.tests, mode, skip: unit.skip });
      } else if (unit.tests[0].includes("/")) {
        commands.push({ pkg: unit.pkg, tests: unit.tests, mode });
      } else {
        const tests = split.get(unit.pkg) ?? [];
        tests.push(...unit.tests);
        split.set(unit.pkg, tests);
      }
    }
    for (const [pkg, tests] of split) commands.push({ pkg, tests, mode });
  }
  return commands;
}

/** Binary files mirror the import path so package names cannot collide. */
export function binaryPath(binDir: string, pkg: string, mode: GoTestMode): string {
  return join(binDir, ...pkg.split("/"), `${mode}.test`);
}

interface BuildJob {
  pkg: string;
  mode: GoTestMode;
}

/**
 * Link every split package's test binary once per mode. A shard then starts a
 * small binary instead of asking the go tool to load packages and relink every
 * time, which is the dominant fixed cost of a test-level shard. Whole packages
 * keep the batched `go test` command: each runs in exactly one shard, so there
 * is no repeated link to avoid there.
 */
async function buildBinaries(root: string, inventory: GoInventory, binDir: string, jobs: number): Promise<number> {
  const packages = inventory.packages
    .filter((pkg) => pkg.tests !== null)
    .sort((left, right) => right.files - left.files);
  const work: BuildJob[] = [];
  for (const pkg of packages) {
    for (const mode of packageModes(pkg)) work.push({ pkg: pkg.path, mode });
  }
  let next = 0;
  let failures = 0;
  const run = async () => {
    for (;;) {
      const job = work[next++];
      if (!job) return;
      const output = binaryPath(binDir, job.pkg, job.mode);
      mkdirSync(dirname(output), { recursive: true });
      const args = ["test", "-c", "-vet=off", "-o", output];
      if (job.mode === "race") args.push("-race");
      args.push(job.pkg);
      try {
        await execFile("go", args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
      } catch (error) {
        failures++;
        const detail = error as { stderr?: string; message?: string };
        console.error(`verify: go test binary ${job.pkg} (${job.mode}) failed\n${detail.stderr ?? detail.message ?? error}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, work.length)) }, run));
  return failures;
}

export function planShard(
  inventory: GoInventory,
  weights: GoTestWeights,
  index: number,
  total: number,
  mode: GoTestPlanMode = "test",
): GoTestUnit[] {
  if (!Number.isInteger(index) || index < 0 || index >= total) {
    throw new Error(`shard index must be between 0 and ${total - 1}`);
  }
  const units = mode === "coverage" ? coverageUnits(inventory, weights) : inventoryUnits(inventory, weights, mode);
  return shardUnits(units, total)[index];
}

interface ShardRun {
  mode: GoTestMode;
  label: string;
  pkg: string;
  tests: string[] | null;
  skip?: string[];
  args?: string[];
}

function runShard(
  root: string,
  inventory: GoInventory,
  weights: GoTestWeights,
  mode: GoTestPlanMode,
  index: number,
  total: number,
  binDir?: string,
): number {
  const units = planShard(inventory, weights, index, total, mode);
  const fallback = mode === "coverage" ? "race" : mode;
  const dirs = new Map(inventory.packages.map((pkg) => [pkg.path, pkg.dir]));
  const runs: ShardRun[] = [];
  if (binDir) {
    const split = units.filter((unit) => unit.tests !== null);
    const whole = units.filter((unit) => unit.tests === null);
    runs.push(...binaryCommands(split, fallback).map((command) => ({
      mode: command.mode,
      label: command.skip ? `${command.pkg} ${command.tests?.[0] ?? ""} (unlisted cases)` : command.tests ? `${command.pkg} (${command.tests.length} tests)` : command.pkg,
      pkg: command.pkg,
      tests: command.tests,
      skip: command.skip,
    })));
    runs.push(...shardCommands(whole, fallback).map((command) => ({ mode: command.mode, label: command.label, pkg: "", tests: null, args: command.args })));
  } else {
    runs.push(...shardCommands(units, fallback).map((command) => ({ mode: command.mode, label: command.label, pkg: "", tests: null, args: command.args })));
  }
  if (runs.length === 0) {
    console.log(`verify: go ${mode} shard ${index}/${total} is empty`);
    return 0;
  }
  console.log(`verify: go ${mode} shard ${index}/${total}: ${units.length} unit(s)`);
  let status = 0;
  for (const run of runs) {
    const label = `verify: go ${mode} shard ${index}/${total}: ${run.mode} ${run.label}`;
    console.log(label);
    const started = performance.now();
    try {
      if (run.args) {
        // Whole packages still go through the go tool: each runs in exactly
        // one shard, so there is no repeated link to avoid.
        execFileSync("go", ["test", ...run.args], { cwd: root, stdio: "inherit" });
      } else {
        if (!binDir) throw new Error("binary test run without a binary directory");
        const dir = dirs.get(run.pkg);
        if (!dir) throw new Error(`inventory has no source directory for ${run.pkg}`);
        const args = ["-test.timeout", TEST_TIMEOUT, "-test.paniconexit0"];
        if (run.tests) args.unshift("-test.run", runExpression(run.tests));
        if (run.skip) args.push("-test.skip", skipExpression(run.tests![0], run.skip));
        execFileSync(binaryPath(binDir, run.pkg, run.mode), args, { cwd: dir, stdio: "inherit" });
      }
    } catch {
      status = 1;
    }
    console.log(`${label} finished in ${((performance.now() - started) / 1000).toFixed(1)}s`);
  }
  return status;
}

function usage(): never {
  console.error("usage: go-test-shard.ts --inventory | --build <dir> --inventory <file> | --shard <index>/<total> --mode test|race|coverage --inventory <file> [--bindir <dir>] | --plan <index>/<total> [--mode test|race|coverage] --inventory <file>");
  process.exit(2);
}

function planMode(value: string | undefined): GoTestPlanMode {
  const mode = value ?? "test";
  if (mode !== "test" && mode !== "race" && mode !== "coverage") usage();
  return mode;
}

function readInventory(path: string): GoInventory {
  const inventory = JSON.parse(readFileSync(path, "utf8")) as GoInventory;
  if (inventory?.version !== 1 || !Array.isArray(inventory.packages) || inventory.packages.length === 0) {
    throw new Error(`inventory ${path} has no test packages`);
  }
  return inventory;
}

if (import.meta.main) {
  try {
    const root = join(import.meta.dir, "..");
    const weights = loadWeights(join(import.meta.dir, "go-test-timings.json"));
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--inventory") {
      process.stdout.write(JSON.stringify(buildInventory(root, weights)) + "\n");
      process.exit(0);
    }
    const options = new Map<string, string>();
    for (let index = 0; index < args.length; index += 2) {
      if (index + 1 >= args.length || !args[index].startsWith("--")) usage();
      options.set(args[index], args[index + 1]);
    }
    if (options.size === 2 && options.has("--build") && options.has("--inventory")) {
      const inventory = readInventory(options.get("--inventory")!);
      const jobs = Number(process.env.PAIRFOB_VERIFY_JOBS ?? availableParallelism());
      if (!Number.isInteger(jobs) || jobs < 1) throw new Error("PAIRFOB_VERIFY_JOBS must be a positive integer");
      const split = inventory.packages.filter((pkg) => pkg.tests !== null).length;
      console.log(`verify: go test binaries: ${split} split package(s), both modes`);
      const failures = await buildBinaries(root, inventory, options.get("--build")!, jobs);
      if (failures > 0) throw new Error(`${failures} test binary build(s) failed`);
    } else if ((options.size === 2 || options.size === 3) && options.has("--plan") && options.has("--inventory")) {
      const [index, total] = options.get("--plan")!.split("/").map(Number);
      const mode = planMode(options.get("--mode"));
      const units = planShard(readInventory(options.get("--inventory")!), weights, index, total, mode);
      process.stdout.write(JSON.stringify(units, null, 2) + "\n");
    } else if ((options.size === 3 || options.size === 4) && options.has("--shard") && options.has("--mode") && options.has("--inventory")) {
      const [index, total] = options.get("--shard")!.split("/").map(Number);
      const mode = planMode(options.get("--mode"));
      process.exitCode = runShard(root, readInventory(options.get("--inventory")!), weights, mode, index, total, options.get("--bindir"));
    } else {
      usage();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}