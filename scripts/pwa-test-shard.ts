/** Split the PWA test files into balanced shards for parallel CI jobs. */
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const TEST_FILE = /\.test\.tsx?$/;

function walk(directory: string, out: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (TEST_FILE.test(entry.name)) out.push(path);
  }
}

/** Every PWA test file under `<root>/src`, relative to the root and sorted. */
export function pwaTestFiles(root: string): string[] {
  const found: string[] = [];
  walk(join(root, "src"), found);
  return found.map((path) => relative(root, path).split(sep).join("/")).sort();
}

/**
 * The files for one shard. Largest first into the least-loaded shard, so a few
 * heavy files cannot all land together. File size decides the split; the
 * measured timings manifest only orders files inside a shard, so a stale
 * entry cannot unbalance it.
 */
export function shardTestFiles(root: string, index: number, total: number): string[] {
  if (!Number.isInteger(total) || total < 1) throw new Error("shard total must be a positive integer");
  if (!Number.isInteger(index) || index < 0 || index >= total) {
    throw new Error(`shard index must be between 0 and ${total - 1}`);
  }
  const files = pwaTestFiles(root);
  const sizes = new Map(files.map((file) => [file, statSync(join(root, file)).size]));
  const weight = (file: string): number => sizes.get(file) ?? 0;
  const buckets: string[][] = Array.from({ length: total }, () => []);
  const loads = new Array<number>(total).fill(0);
  for (const file of [...files].sort((left, right) => weight(right) - weight(left) || left.localeCompare(right))) {
    let target = 0;
    for (let candidate = 1; candidate < total; candidate++) {
      if (loads[candidate] < loads[target]) target = candidate;
    }
    buckets[target].push(file);
    loads[target] += weight(file);
  }
  return buckets[index];
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 4) throw new Error("usage: pwa-test-shard.ts <index> <total>");
    const [index, total] = process.argv.slice(2).map(Number);
    const root = join(import.meta.dir, "..", "pwa");
    for (const file of shardTestFiles(root, index, total)) console.log(file);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
