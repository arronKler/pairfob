import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkPwaScope } from "./pwa-release-scope";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pairfob-pwa-scope-"));
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
  put("internal/daemon/rpc.go", "backend\n");
  put("workers/pairfob-origin/wrangler.jsonc", '{"vars":{"BUILD":"old","P2P_OPEN":"1"}}\n');
  put("site/img/home/en/tablet.webp", "old still\n");
  git("add", "."); git("commit", "-qm", "verified baseline");
  return { root, git, put, base: git("rev-parse", "HEAD") };
}

test("accepts committed, staged, unstaged and untracked UI changes plus a BUILD-only bump", () => {
  const f = fixture();
  f.put("pwa/src/view.ts", "committed UI\n"); f.git("add", "."); f.git("commit", "-qm", "UI");
  f.put("pwa/src/style.css", "staged\n"); f.git("add", ".");
  f.put("pwa/src/view.ts", "latest UI\n"); f.put("pwa/src/new.ts", "untracked\n");
  f.put("workers/pairfob-origin/wrangler.jsonc", '{"vars":{"BUILD":"new","P2P_OPEN":"1"}}\n');
  expect(checkPwaScope(f.root, f.base)).toHaveLength(4);
});

test("UI deletions are allowed", () => {
  const f = fixture(); rmSync(join(f.root, "pwa/src/view.ts"));
  expect(checkPwaScope(f.root, f.base)).toEqual(["pwa/src/view.ts"]);
});

for (const path of ["internal/daemon/rpc.go", "proto/new.json", "workers/pairfob-origin/src/new.ts",
  "pwa/src/lib/protocol/client.ts", "scripts/verify.sh", "go.mod",
  "site/index.html", "site/site.js", "site/doc/faq.md", "site/img/home/en/notes.txt", "site/img/logo.ico"]) {
  test(`requires full verification for ${path}`, () => {
    const f = fixture(); f.put(path, "changed\n");
    expect(() => checkPwaScope(f.root, f.base)).toThrow("Full verify required");
  });
}

test("accepts the product stills a UI change renders, and the README images beside them", () => {
  const f = fixture();
  f.put("pwa/src/view.ts", "new UI\n");
  f.put("site/img/home/en/tablet.webp", "new still\n");
  f.put("site/img/readme/zh.webp", "new strip\n");
  expect(checkPwaScope(f.root, f.base).sort()).toEqual([
    "pwa/src/view.ts", "site/img/home/en/tablet.webp", "site/img/readme/zh.webp",
  ]);
});

test("rejects a still that is a symlink out of the site tree", () => {
  const f = fixture();
  symlinkSync("../../../internal/daemon/rpc.go", join(f.root, "site/img/home/en/link.webp"));
  expect(() => checkPwaScope(f.root, f.base)).toThrow("Full verify required");
});

test("does not hide a backend deletion behind a rename into PWA", () => {
  const f = fixture(); f.git("mv", "internal/daemon/rpc.go", "pwa/src/rpc.go");
  expect(() => checkPwaScope(f.root, f.base)).toThrow("internal/daemon/rpc.go");
});

test("rejects changes to other Worker settings even alongside BUILD", () => {
  const f = fixture();
  f.put("workers/pairfob-origin/wrangler.jsonc", '{"vars":{"BUILD":"new","P2P_OPEN":"0"}}\n');
  expect(() => checkPwaScope(f.root, f.base)).toThrow("Full verify required");
});

test("rejects missing or ambiguous BUILD and a deleted config", () => {
  const f = fixture();
  for (const text of ['{}', '{"BUILD":"a","BUILD":"b"}']) {
    f.put("workers/pairfob-origin/wrangler.jsonc", text);
    expect(() => checkPwaScope(f.root, f.base)).toThrow("Full verify required");
  }
  rmSync(join(f.root, "workers/pairfob-origin/wrangler.jsonc"));
  expect(() => checkPwaScope(f.root, f.base)).toThrow("Full verify required");
});

test("rejects symlinked UI input and invalid baselines", () => {
  const f = fixture(); symlinkSync("../../internal/daemon/rpc.go", join(f.root, "pwa/src/link.ts"));
  expect(() => checkPwaScope(f.root, f.base)).toThrow("Full verify required");
  expect(() => checkPwaScope(f.root, "")).toThrow();
  expect(() => checkPwaScope(f.root, "--all")).toThrow();
  expect(() => checkPwaScope(f.root, "nonexistent-verified-release")).toThrow();
});
