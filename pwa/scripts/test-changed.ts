#!/usr/bin/env bun
/**
 * The fast layer: run the PWA tests a change touches, not the whole suite.
 *
 * `bun run test` is the full layer — every file under `src` — and the gate for
 * a release. While iterating that costs minutes and flakes on a loaded machine
 * for modules the edit never reaches. This reads the working tree (or the
 * paths given on the command line), walks the import graph the other way, and
 * runs the test files that reach the changed modules: usually a handful, a few
 * seconds.
 *
 *   bun run test:changed                     # what `git status` shows
 *   bun run test:changed src/features/board  # a file or a directory
 *   bun run test:changed --all               # forget it, run everything
 *
 * Depth is two import hops: a changed store reaches the tests of the
 * components that use it, without pulling in the whole application.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const PWA = resolve(import.meta.dir, "..");
const REPO = resolve(PWA, "..");
const SOURCE = /\.(?:ts|tsx)$/;
const TEST = /\.(?:test|spec)\.(?:ts|tsx)$/;
const HOPS = 2;
const CAP = 300;

/**
 * The runner the gate uses. `.bun-version` pins it: an older Bun on PATH is a
 * different runner (1.3.x ignores `--parallel`), so resolve the pinned binary
 * rather than trusting whichever `bun` started this script.
 */
function bunBinary(): string {
  const pinned = readFileSync(join(REPO, ".bun-version"), "utf8").trim();
  for (const candidate of [process.env.PAIRFOB_BUN, join(homedir(), ".bun", "bin", "bun"), process.execPath]) {
    if (!candidate) continue;
    try {
      if (execFileSync(candidate, ["--version"], { encoding: "utf8" }).trim() === pinned) return candidate;
    } catch {
      // Not a Bun that can answer; try the next one.
    }
  }
  console.error(`test:changed: Bun ${pinned} is required, found ${process.versions.bun}`);
  console.error(`test:changed: install it with: curl -fsSL https://bun.sh/install | bash -s bun-v${pinned}`);
  process.exit(1);
}

function walk(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".cache") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, found);
    else if (SOURCE.test(entry.name)) found.push(path);
  }
  return found;
}

/** The module a relative specifier points at, with the extension Bun would add. */
function resolveImport(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next spelling
    }
  }
  return undefined;
}

function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const found: string[] = [];
  for (const match of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']*)["']/g)) {
    const target = resolveImport(file, match[1]);
    if (target) found.push(target);
  }
  return found;
}

function changedFromGit(): string[] {
  const root = execFileSync("git", ["-C", PWA, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const out = execFileSync("git", ["-C", PWA, "status", "--porcelain=v1", "-z"], { encoding: "utf8" });
  return out.split("\0").filter(Boolean).flatMap((entry) => {
    const path = entry.slice(3).trim();
    if (!path) return [];
    const absolute = resolve(root, path);
    if (path.endsWith("/")) return [];
    try {
      return statSync(absolute).isFile() ? [absolute] : walk(absolute);
    } catch {
      return [absolute]; // deleted: its tests still deserve to run
    }
  });
}

function changedFromArgs(args: string[]): string[] {
  return args.flatMap((arg) => {
    const absolute = resolve(PWA, arg);
    try {
      return statSync(absolute).isDirectory() ? walk(absolute) : [absolute];
    } catch {
      return [absolute];
    }
  });
}

const argv = process.argv.slice(2);
const everything = argv.includes("--all");
const files = walk(PWA); // includes every ROOT below
const all = [...new Set(files)].filter((file) => SOURCE.test(file));
const tests = new Set(all.filter((file) => TEST.test(file)));

if (everything) {
  console.log(`test:changed --all: ${tests.size} test files`);
  const code = Bun.spawnSync([bunBinary(), "test", ...tests, "--isolate", "--parallel", "--timeout", "30000"], { cwd: PWA, stdio: ["inherit", "inherit", "inherit"] }).exitCode;
  process.exit(code ?? 1);
}

const explicit = argv.filter((arg) => !arg.startsWith("--"));
const seeds = (explicit.length ? changedFromArgs(explicit) : changedFromGit())
  .filter((file) => file.startsWith(PWA) && SOURCE.test(file) && !file.includes("/node_modules/") && !file.includes("/dist"));

if (seeds.length === 0) {
  console.log("test:changed: nothing changed under pwa/");
  process.exit(0);
}

// Reverse edges: module -> files that import it.
const importers = new Map<string, string[]>();
for (const file of all) {
  for (const target of importsOf(file)) {
    const list = importers.get(target) ?? [];
    list.push(file);
    importers.set(target, list);
  }
}

const selected = new Set<string>();
const seen = new Set<string>(seeds);
let frontier = seeds;
for (let hop = 0; hop < HOPS && frontier.length; hop++) {
  const next: string[] = [];
  for (const file of frontier) {
    for (const importer of importers.get(file) ?? []) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      if (TEST.test(importer)) selected.add(importer);
      else next.push(importer);
    }
  }
  frontier = next;
}
for (const seed of seeds) if (TEST.test(seed)) selected.add(seed);

if (selected.size === 0) {
  console.log(`test:changed: ${seeds.length} changed file(s), no test reaches them within ${HOPS} hops`);
  process.exit(0);
}

const existing = [...selected]
  .sort()
  .filter((file) => {
    try {
      return statSync(file).isFile(); // a deleted test has nothing to run
    } catch {
      return false;
    }
  });
const run = existing.slice(0, CAP);
const skipped = existing.length - run.length;
console.log(`test:changed: ${seeds.length} changed file(s) → ${run.length} test file(s)${skipped > 0 ? ` (${skipped} over the ${CAP} cap)` : ""}`);
for (const file of run) console.log(`  ${relative(PWA, file)}`);

const code = Bun.spawnSync([bunBinary(), "test", ...run, "--isolate", "--parallel", "--timeout", "30000"], { cwd: PWA, stdio: ["inherit", "inherit", "inherit"] }).exitCode;
process.exit(code ?? 1);
