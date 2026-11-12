import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SCOPES, classifyPaths, type Scope } from "./ci-scope.ts";

const CLI = fileURLToPath(new URL("./ci-scope.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function runCli(...args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8" });
}

function enabled(paths: string[]): Scope[] {
  const result = classifyPaths(paths);
  return SCOPES.filter((scope) => result[scope]);
}

const cases: Array<[name: string, paths: string[], scopes: Scope[]]> = [
  [".github changes run every job", [".github/workflows/verify.yml"], ["go", "web", "docs", "desktop", "mobile"]],
  [".github itself runs every job", [".github"], ["go", "web", "docs", "desktop", "mobile"]],
  ["verify.sh runs every job", ["scripts/verify.sh"], ["go", "web", "docs", "desktop", "mobile"]],
  ["the scope classifier runs every job", ["scripts/ci-scope.ts"], ["go", "web", "docs", "desktop", "mobile"]],
  ["the scope baseline runs every job", ["scripts/ci-scope-baseline.sh"], ["go", "web", "docs", "desktop", "mobile"]],
  ["the scope tests run every job", ["scripts/ci-scope.test.ts"], ["go", "web", "docs", "desktop", "mobile"]],
  ["go.mod runs the Go job", ["go.mod"], ["go"]],
  ["go.sum runs the Go job", ["go.sum"], ["go"]],
  ["cmd changes run Go and desktop", ["cmd/pairfob/main.go"], ["go", "desktop"]],
  ["internal changes run Go", ["internal/daemon/upload.go"], ["go"]],
  ["proto changes run Go and web", ["proto/envelope.md"], ["go", "web"]],
  ["pwa changes run web", ["pwa/src/main.ts"], ["web"]],
  ["worker changes run web", ["workers/pairfob-origin/src/index.ts"], ["web"]],
  ["site docs run docs and web", ["site/doc/index.md"], ["web", "docs"]],
  ["the doc lang.js config runs docs and web", ["site/doc/.vitepress/config.ts"], ["web", "docs"]],
  ["site changes run web", ["site/index.html"], ["web"]],
  ["docs changes run docs", ["docs/develop.md"], ["docs"]],
  ["desktop changes run desktop", ["desktop/src/main.rs"], ["desktop"]],
  ["the Go gate runs Go", ["scripts/verify-go.sh"], ["go"]],
  ["the web gate runs web", ["scripts/verify-web.sh"], ["web"]],
  ["the origin pack runs web", ["scripts/pack-origin-assets.sh"], ["web"]],
  ["asset retention runs web", ["scripts/retain-pwa-assets.ts"], ["web"]],
  ["the self-host deployer runs web", ["scripts/selfhost-relay.ts"], ["web"]],
  ["the self-host config runs web", ["scripts/selfhost-config.ts"], ["web"]],
  ["the self-host packer runs web", ["scripts/selfhost-pack.ts"], ["web"]],
  ["the desktop gate runs desktop", ["scripts/verify-desktop.sh"], ["desktop"]],
  ["release tooling runs every job", ["scripts/release.sh"], ["go", "web", "docs", "desktop", "mobile"]],
  ["the release key tool runs every job", ["scripts/release-keygen.sh"], ["go", "web", "docs", "desktop", "mobile"]],
  ["the installer runs every job", ["scripts/install.sh"], ["go", "web", "docs", "desktop", "mobile"]],
  ["other scripts add no job scope", ["scripts/dev-up.sh"], []],
  ["plugin changes add no job scope", ["plugin/herdr/pairfob.sh"], []],
  ["the plugin manifest adds no job scope", ["herdr-plugin.toml"], []],
  ["mobile changes run web and the native build jobs", ["mobile/android/app/build.gradle"], ["web", "mobile"]],
  ["AGENTS.md runs docs", ["AGENTS.md"], ["docs"]],
  ["README.md runs docs", ["README.md"], ["docs"]],
  ["a localized README runs docs", ["README.zh.md"], ["docs"]],
  ["DESIGN.md runs docs", ["DESIGN.md"], ["docs"]],
  ["SECURITY.md runs docs", ["SECURITY.md"], ["docs"]],
  ["LICENSE runs docs", ["LICENSE"], ["docs"]],
  ["NOTICE runs docs", ["NOTICE"], ["docs"]],
  ["an unknown path runs every job", ["notes.txt"], ["go", "web", "docs", "desktop", "mobile"]],
  ["no paths run no jobs", [], []],
  ["scopes accumulate across paths", ["internal/a.go", "pwa/src/b.ts"], ["go", "web"]],
];

for (const [name, paths, scopes] of cases) {
  test(name, () => expect(enabled(paths)).toEqual(scopes));
}

// The workflow appends stdout straight to $GITHUB_OUTPUT, so the gate depends
// on every scope appearing exactly once, in a fixed order.
test("the CLI prints every scope exactly once", () => {
  expect(runCli("--all")).toBe("go=true\nweb=true\ndocs=true\ndesktop=true\nmobile=true\n");
});

test("the CLI prints an explicit false for an unchanged range", () => {
  const lines = runCli("HEAD").trimEnd().split("\n");
  expect(lines).toEqual(["go=false", "web=false", "docs=false", "desktop=false", "mobile=false"]);
});
