import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkAndroidScope } from "./android-release-scope";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const GRADLE = "mobile/android/app/build.gradle";
const gradleText = (code: number, name: string, extra = "") =>
  `android {\n    defaultConfig {\n        versionCode ${code}\n        versionName "${name}"\n${extra}    }\n}\n`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pairfob-android-scope-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" },
  }).trim();
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  git("init", "-q");
  put("pwa/src/view.ts", "old UI\n");
  put("pwa/src/lib/protocol/client.ts", "protocol\n");
  put(GRADLE, gradleText(1, "1.0.0-beta.1"));
  put("mobile/android/app/src/main/java/com/pairfob/app/UpdateBridge.java", "bridge\n");
  put("internal/daemon/rpc.go", "backend\n");
  put("proto/rpc.schema.json", "{}\n");
  put("scripts/verify.sh", "gate\n");
  put("docs/develop.md", "docs\n");
  git("add", "."); git("commit", "-qm", "verified baseline");
  return { root, git, put, base: git("rev-parse", "HEAD") };
}

test("accepts committed, staged, unstaged and untracked shell changes plus a version-only bump", () => {
  const f = fixture();
  f.put("pwa/src/view.ts", "committed UI\n"); f.git("add", "."); f.git("commit", "-qm", "UI");
  f.put("docs/develop.md", "new docs\n"); f.git("add", ".");
  f.put("mobile/android/app/src/main/java/com/pairfob/app/UpdateBridge.java", "new bridge\n");
  f.put("pwa/src/new.ts", "untracked\n");
  f.put(GRADLE, gradleText(2, "1.0.0-beta.2"));
  expect(checkAndroidScope(f.root, f.base)).toHaveLength(5);
});

test("deletions inside the shell are allowed", () => {
  const f = fixture(); rmSync(join(f.root, "pwa/src/view.ts"));
  expect(checkAndroidScope(f.root, f.base)).toEqual(["pwa/src/view.ts"]);
});

for (const path of ["internal/daemon/rpc.go", "proto/rpc.schema.json", "scripts/verify.sh", "go.mod",
  "pwa/src/lib/protocol/client.ts", "workers/pairfob-origin/wrangler.jsonc"]) {
  test(`requires full verification for ${path}`, () => {
    const f = fixture(); f.put(path, "changed\n");
    expect(() => checkAndroidScope(f.root, f.base)).toThrow("Full verify required");
  });
}

test("rejects any Gradle change beyond the two version literals", () => {
  const f = fixture();
  f.put(GRADLE, gradleText(2, "1.0.0-beta.2", '        minSdkVersion 24\n'));
  expect(() => checkAndroidScope(f.root, f.base)).toThrow("Full verify required");
});

test("rejects a deleted or ambiguous Gradle build", () => {
  const f = fixture();
  rmSync(join(f.root, GRADLE));
  expect(() => checkAndroidScope(f.root, f.base)).toThrow("Full verify required");
  f.put(GRADLE, `${gradleText(2, "1.0.0-beta.2")}versionCode 3\n`);
  expect(() => checkAndroidScope(f.root, f.base)).toThrow("Full verify required");
  f.put(GRADLE, gradleText(1, "1.0.0-beta.1"));
  expect(checkAndroidScope(f.root, f.base)).toEqual([]);
});

test("does not hide a backend deletion behind a rename into the shell", () => {
  const f = fixture(); f.git("mv", "internal/daemon/rpc.go", "mobile/android/app/src/rpc.go");
  expect(() => checkAndroidScope(f.root, f.base)).toThrow("internal/daemon/rpc.go");
});

test("rejects symlinked inputs and invalid baselines", () => {
  const f = fixture(); symlinkSync("../../internal/daemon/rpc.go", join(f.root, "pwa/src/link.ts"));
  expect(() => checkAndroidScope(f.root, f.base)).toThrow("Full verify required");
  expect(() => checkAndroidScope(f.root, "")).toThrow();
  expect(() => checkAndroidScope(f.root, "--all")).toThrow();
  expect(() => checkAndroidScope(f.root, "nonexistent-verified-release")).toThrow();
});
