/** Compare the actual working tree, including untracked files, to a verified release. */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const config = "workers/pairfob-origin/wrangler.jsonc";
// A product still or a README image is drawn from the PWA fixtures by
// scripts/site-shots.ts and packed with the app. It is the one kind of site
// file a UI release may carry: an image runs nothing, and the web gate packs
// and serves it through the same Worker checks as the rest of the tree.
const IMAGE = /\.(?:webp|png|jpe?g|gif|avif|svg)$/i;

export function isShippedImage(path: string): boolean {
  return path.startsWith("site/img/") && IMAGE.test(path) && !path.split("/").includes("..");
}

export function isPwaUi(path: string): boolean {
  return path.startsWith("pwa/") && !path.startsWith("pwa/src/lib/protocol/");
}


function withoutBuild(text: string): string {
  // Only one literal BUILD string may differ; every other byte must match.
  const matches = [...text.matchAll(/"BUILD"\s*:\s*"[^"\r\n]*"/g)];
  if (matches.length !== 1) throw new Error("Expected exactly one BUILD in origin config");
  return text.replace(/("BUILD"\s*:\s*)"[^"\r\n]*"/, '$1"<build>"');
}

export function checkPwaScope(root: string, baseline: string): string[] {
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (!baseline || baseline.startsWith("-")) throw new Error("A previously verified commit is required");
  const commit = git("rev-parse", "--verify", `${baseline}^{commit}`).trim();
  const changed = new Set([
    ...git("diff", "--name-only", "--no-renames", "-z", commit, "--").split("\0"),
    ...git("ls-files", "--others", "--exclude-standard", "-z").split("\0"),
  ].filter(Boolean));
  const blocked: string[] = [];
  // A path is refused when it is a symlink: the pack copies a link's target
  // contents into the shipped tree, so a link would smuggle in a file the
  // scope never saw.
  const notSymlink = (path: string): boolean => {
    try {
      return !lstatSync(join(root, path)).isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return true;
    }
  };
  for (const path of changed) {
    if ((isPwaUi(path) || isShippedImage(path)) && notSymlink(path)) continue;
    if (path === config) {
      try {
        if (withoutBuild(git("show", `${commit}:${config}`)) === withoutBuild(readFileSync(join(root, path), "utf8"))) continue;
      } catch { /* missing or malformed config requires the full gate */ }
    }
    blocked.push(path);
  }
  if (blocked.length) throw new Error(`Full verify required; changes outside PWA UI scope:\n${blocked.join("\n")}`);
  return [...changed];
}

if (import.meta.main) {
  try {
    const changed = checkPwaScope(process.cwd(), process.argv[2] ?? "");
    console.log(`PWA-only scope verified against ${process.argv[2]} (${changed.length} changed paths).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
