import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preProcessFile } from "typescript";

const sourceRoot = fileURLToPath(new URL(".", import.meta.url));

function productionModules(): string[] {
  return [...new Bun.Glob("**/*.ts").scanSync({ cwd: sourceRoot, onlyFiles: true })]
    .filter((file) => !file.endsWith(".test.ts"))
    .map((file) => resolve(sourceRoot, file));
}

function localDependencies(file: string, modules: Set<string>): string[] {
  const imports = preProcessFile(readFileSync(file, "utf8")).importedFiles;
  return imports.flatMap(({ fileName }) => {
    if (!fileName.startsWith(".")) return [];
    const base = resolve(dirname(file), fileName);
    return [base, `${base}.ts`, join(base, "index.ts")].filter((candidate) => modules.has(candidate)).slice(0, 1);
  });
}

function importCycles(files: string[]): string[][] {
  const modules = new Set(files);
  const graph = new Map(files.map((file) => [file, localDependencies(file, modules)]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  function visit(file: string): void {
    if (visiting.has(file)) {
      const start = stack.indexOf(file);
      cycles.push([...stack.slice(start), file].map((item) => item.slice(sourceRoot.length)));
      return;
    }
    if (visited.has(file)) return;
    visiting.add(file);
    stack.push(file);
    for (const dependency of graph.get(file) ?? []) visit(dependency);
    stack.pop();
    visiting.delete(file);
    visited.add(file);
  }

  for (const file of files) visit(file);
  return cycles;
}

describe("PWA module boundaries", () => {
  test("production modules have no import cycles", () => {
    expect(importCycles(productionModules())).toEqual([]);
  });
});
