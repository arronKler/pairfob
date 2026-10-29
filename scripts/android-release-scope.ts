/** Compare the actual working tree, including untracked files, to a verified release. */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const gradle = "mobile/android/app/build.gradle";

/** Only the version literals may differ; every other byte must match. */
function withoutVersion(text: string): string {
  const codes = [...text.matchAll(/versionCode\s+\d+/g)];
  const names = [...text.matchAll(/versionName\s+"[^"\r\n]*"/g)];
  if (codes.length !== 1 || names.length !== 1) {
    throw new Error("Expected exactly one versionCode and one versionName in the Android build");
  }
  return text
    .replace(/versionCode\s+\d+/, "versionCode <code>")
    .replace(/versionName\s+"[^"\r\n]*"/, 'versionName "<name>"');
}

function symlinked(root: string, path: string): boolean {
  try {
    return lstatSync(join(root, path)).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}

/**
 * What an APK release may change without the full gate: the page it bundles
 * (`pwa/`, except the protocol contract), the Android shell itself, developer
 * docs, and the two version literals in the Gradle build. Everything else —
 * daemon, relay, protocol, release scripts — needs the full gate.
 */
export function checkAndroidScope(root: string, baseline: string): string[] {
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (!baseline || baseline.startsWith("-")) throw new Error("A previously verified commit is required");
  const commit = git("rev-parse", "--verify", `${baseline}^{commit}`).trim();
  const changed = new Set([
    ...git("diff", "--name-only", "--no-renames", "-z", commit, "--").split("\0"),
    ...git("ls-files", "--others", "--exclude-standard", "-z").split("\0"),
  ].filter(Boolean));
  const blocked: string[] = [];
  for (const path of changed) {
    if (path.startsWith("pwa/") && !path.startsWith("pwa/src/lib/protocol/")) {
      if (symlinked(root, path)) blocked.push(path);
      continue;
    }
    if (path.startsWith("mobile/") && path !== gradle) {
      if (symlinked(root, path)) blocked.push(path);
      continue;
    }
    if (path === gradle) {
      try {
        if (!symlinked(root, path)
          && withoutVersion(git("show", `${commit}:${gradle}`)) === withoutVersion(readFileSync(join(root, gradle), "utf8"))) continue;
      } catch { /* missing or malformed build requires the full gate */ }
    }
    if (path.startsWith("docs/")) continue;
    blocked.push(path);
  }
  if (blocked.length) throw new Error(`Full verify required; changes outside Android release scope:\n${blocked.join("\n")}`);
  return [...changed];
}

if (import.meta.main) {
  try {
    const changed = checkAndroidScope(process.cwd(), process.argv[2] ?? "");
    console.log(`Android-only scope verified against ${process.argv[2]} (${changed.length} changed paths).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
