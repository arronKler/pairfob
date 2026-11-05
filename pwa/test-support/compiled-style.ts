import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "sass";

/**
 * Style tests read the compiled CSS of a `.scss` entry. Compiling is the
 * costliest thing they do — a couple of seconds alone, past the 30-second
 * timeout when the machine is loaded — and a few dozen files repeat it. The
 * output depends only on the stylesheet tree, so it is keyed by that tree and
 * kept on disk between files, runs and workers.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CACHE = join(ROOT, ".cache", "compiled-style");

function stylesheets(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) stylesheets(path, found);
    else if (entry.name.endsWith(".scss")) found.push(path);
  }
  return found;
}

let treeHash: string | undefined;

/** Every stylesheet's path and contents: any edit to one of them builds a new key. */
function stylesheetTreeHash(): string {
  if (treeHash) return treeHash;
  const hash = createHash("sha256");
  const files = [
    ...stylesheets(join(ROOT, "src")),
    ...readdirSync(ROOT).filter((name) => name.endsWith(".scss")).map((name) => join(ROOT, name)),
  ].sort();
  for (const file of files) {
    hash.update(relative(ROOT, file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return (treeHash = hash.digest("hex"));
}

export type CompiledStyle = { css: string };

/**
 * `compile(entry).css`, replaced by the cached result when this stylesheet
 * tree and these options have been compiled before. The entry is a `URL`
 * resolved against the calling test, as `new URL("./style.scss", import.meta.url)`
 * gives it.
 */
export function compileScss(entry: string | URL, options: { style?: "expanded" | "compressed" } = {}): CompiledStyle {
  const path = typeof entry === "string" ? entry : fileURLToPath(entry);
  const style = options.style ?? "expanded";
  const key = createHash("sha256")
    .update(relative(ROOT, path))
    .update("\0")
    .update(style)
    .update("\0")
    .update(stylesheetTreeHash())
    .digest("hex");
  const cached = join(CACHE, `${key}.css`);
  try {
    if (statSync(cached).size > 0) return { css: readFileSync(cached, "utf8") };
  } catch {
    // No result for this tree yet.
  }
  const css = compile(path, { style }).css;
  mkdirSync(CACHE, { recursive: true });
  // Two workers can compile the same tree at once; the rename keeps readers
  // from ever seeing a half-written file.
  const staging = `${cached}.${process.pid}.tmp`;
  writeFileSync(staging, css);
  renameSync(staging, cached);
  return { css };
}
