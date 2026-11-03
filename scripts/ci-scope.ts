/** Classify changed paths into the verification jobs they affect. */
import { execFileSync } from "node:child_process";

export const SCOPES = ["go", "web", "docs", "desktop"] as const;
export type Scope = (typeof SCOPES)[number];

type Matcher = (path: string) => boolean;

const ALL: readonly Scope[] = SCOPES;
const NONE: readonly Scope[] = [];

const exact = (...paths: string[]): Matcher => (path) => paths.includes(path);
const under = (prefix: string): Matcher => (path) => path.startsWith(`${prefix}/`);
const rootName = (matches: Matcher): Matcher => (path) => !path.includes("/") && matches(path);

const RULES: ReadonlyArray<{ matches: Matcher; scopes: readonly Scope[] }> = [
  { matches: (path) => path === ".github" || under(".github")(path), scopes: ALL },
  { matches: exact("scripts/verify.sh", "scripts/ci-scope.ts", "scripts/ci-scope.test.ts"), scopes: ALL },
  {
    matches: exact(
      "scripts/release.sh",
      "scripts/release-keygen.sh",
      "scripts/release-desktop.sh",
      "scripts/publish-daemon.sh",
      "scripts/publish-desktop.sh",
      "scripts/publish-android-beta.sh",
      "scripts/build-android-release.sh",
      "scripts/ship-guard.sh",
      "scripts/download-channel.py",
      "scripts/macos-signing.sh",
      "scripts/install.sh",
      "scripts/pwa-release-scope.ts",
      "scripts/android-release-scope.ts",
    ),
    scopes: ALL,
  },
  { matches: exact("go.mod", "go.sum"), scopes: ["go"] },
  { matches: under("cmd"), scopes: ["go", "desktop"] },
  { matches: under("internal"), scopes: ["go"] },
  { matches: under("proto"), scopes: ["go", "web"] },
  { matches: under("pwa"), scopes: ["web"] },
  { matches: under("workers"), scopes: ["web"] },
  // site/doc is packed by scripts/pack-origin-assets.sh, which only the web
  // job runs: the doc config's lang.js version must match site/index.html.
  { matches: under("site/doc"), scopes: ["docs", "web"] },
  { matches: under("site"), scopes: ["web"] },
  { matches: under("docs"), scopes: ["docs"] },
  { matches: under("desktop"), scopes: ["desktop"] },
  { matches: exact("scripts/verify-go.sh"), scopes: ["go"] },
  { matches: exact("scripts/verify-web.sh", "scripts/pack-origin-assets.sh", "scripts/retain-pwa-assets.ts"), scopes: ["web"] },
  { matches: exact("scripts/verify-desktop.sh"), scopes: ["desktop"] },
  { matches: under("scripts"), scopes: NONE },
  { matches: (path) => under("plugin")(path) || path === "herdr-plugin.toml", scopes: NONE },
  { matches: under("mobile"), scopes: ["web"] },
  { matches: exact("AGENTS.md", "DESIGN.md", "SECURITY.md", "LICENSE", "NOTICE"), scopes: ["docs"] },
  { matches: rootName((path) => path.startsWith("README")), scopes: ["docs"] },
];

export function classifyPaths(paths: string[]): Record<Scope, boolean> {
  const result = Object.fromEntries(SCOPES.map((scope) => [scope, false])) as Record<Scope, boolean>;
  for (const path of paths) {
    if (path === "") continue;
    const rule = RULES.find((candidate) => candidate.matches(path));
    for (const scope of rule ? rule.scopes : ALL) result[scope] = true;
  }
  return result;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    let result: Record<Scope, boolean>;
    if (args.length === 1 && args[0] === "--all") {
      result = Object.fromEntries(SCOPES.map((scope) => [scope, true])) as Record<Scope, boolean>;
    } else if (args.length === 1 && args[0] !== "" && !args[0].startsWith("-")) {
      const changed = execFileSync("git", [
        "-C", process.cwd(), "diff", "--name-only", "--no-renames", "-z", `${args[0]}...HEAD`,
      ], { encoding: "utf8" });
      result = classifyPaths(changed.split("\0"));
    } else {
      throw new Error("usage: ci-scope.ts --all|<base-commit>");
    }
    for (const scope of SCOPES) console.log(`${scope}=${result[scope]}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}