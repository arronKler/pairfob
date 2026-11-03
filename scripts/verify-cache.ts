/**
 * Reuse a green verification part when every input that can change its result
 * is byte-identical. This is the same rule Go's test cache applies to packages:
 * a changed file, dependency or tool version misses, and a failure is never
 * stored. Only the caller decides a run passed.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

/** Generated trees and VCS data never change the outcome of a cached part. */
const SKIP = new Set(["node_modules", "dist", "coverage", ".git", ".cache", ".vite", "target", "public-dist"]);

/** The complete input set for each part a gate may reuse. */
const INPUTS: Record<string, string[]> = {
  "pwa-tests": ["pwa", "proto", "scripts/pwa-test-shard.ts", "scripts/pwa-test-timings.json", ".bun-version"],
};

/** Environment a test can observe; an export changes the key. */
const ENV = ["TZ", "LANG", "LC_ALL", "NODE_ENV", "CI"];

function cacheRoot(): string {
  if (process.env.PAIRFOB_VERIFY_CACHE === "0") return "";
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return process.env.PAIRFOB_VERIFY_CACHE_DIR || join(base, "pairfob-verify");
}

function walk(path: string, files: string[]): void {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIP.has(entry.name)) continue;
      walk(join(path, entry.name), files);
    }
  } else if (stat.isFile()) {
    files.push(path);
  }
}

function git(root: string, args: string[]): string | null {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

/**
 * Git already stores every tracked file by content, so the scope resolves to
 * the committed tree, the working-tree diff and any untracked input. This
 * avoids reading ~1.6k files per invocation; a checkout without git falls back
 * to hashing the files themselves.
 */
function gitDigest(hash: ReturnType<typeof createHash>, scope: string, identity: string, inputs: string[], root: string): boolean {
  if (git(root, ["rev-parse", "HEAD"]) === null) return false;
  const paths = ["--", ...inputs];
  const diff = git(root, ["diff", "HEAD", "--binary", ...paths]);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z", ...paths]);
  if (diff === null || untracked === null) return false;
  hash.update(`scope ${scope}\n`);
  hash.update(`identity ${identity}\n`);
  for (const input of inputs) {
    const tree = git(root, ["rev-parse", `HEAD:${input}`]);
    hash.update(`tree ${input} ${tree === null ? "absent" : tree.trim()}\n`);
  }
  hash.update(`diff ${diff.length}\n`);
  hash.update(diff);
  for (const file of untracked.split("\0").filter(Boolean).sort()) {
    hash.update(`untracked ${file}\n`);
    hash.update(readFileSync(join(root, file)));
  }
  return true;
}

/** A digest of the scope's tracked and untracked inputs plus the environment. */
export function cacheKey(scope: string, identity: string, root = ROOT): string {
  const inputs = INPUTS[scope];
  if (!inputs) throw new Error(`unknown scope: ${scope}`);
  const hash = createHash("sha256");
  hash.update(`bun ${process.versions.bun ?? ""}\n`);
  hash.update(`platform ${process.platform} ${process.arch}\n`);
  for (const name of ENV) hash.update(`env ${name}=${process.env[name] ?? ""}\n`);
  if (gitDigest(hash, scope, identity, inputs, root)) return hash.digest("hex");
  const files: string[] = [];
  for (const input of inputs) {
    try {
      walk(join(root, input), files);
    } catch {
      // An absent optional input stays part of the key as absent.
    }
  }
  files.sort();
  hash.update(`scope ${scope}\n`);
  hash.update(`identity ${identity}\n`);
  for (const file of files) {
    hash.update(`file ${relative(root, file)} ${statSync(file).size}\n`);
    hash.update(readFileSync(file));
  }
  return hash.digest("hex");
}

function markerPath(scope: string, identity: string): string {
  const root = cacheRoot();
  if (!root) return "";
  const safe = identity.replace(/[^A-Za-z0-9._-]/g, "-");
  return join(root, `${scope}-${safe}.key`);
}

function usage(): never {
  console.error("usage: verify-cache.ts key|hit|store <scope> [identity] [key]");
  process.exit(2);
}

if (import.meta.main) {
  const [command, scope, identity = "", key = ""] = process.argv.slice(2);
  if (!command || !scope || !(scope in INPUTS)) usage();
  if (command === "key") {
    console.log(cacheKey(scope, identity));
  } else if (command === "hit" || command === "store") {
    const marker = markerPath(scope, identity);
    if (!marker) process.exit(command === "hit" ? 1 : 0);
    if (command === "hit") {
      try {
        process.exit(readFileSync(marker, "utf8").trim() === key ? 0 : 1);
      } catch {
        process.exit(1);
      }
    }
    mkdirSync(cacheRoot(), { recursive: true });
    const temp = `${marker}.${process.pid}.tmp`;
    writeFileSync(temp, `${key}\n`);
    renameSync(temp, marker);
  } else {
    usage();
  }
}