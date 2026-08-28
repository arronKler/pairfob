import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { rewriteHtml, rewriteTree } from "./.vitepress/extract-inline.ts";

describe("rewriteHtml", () => {
  test("moves executable inline scripts to hashed files and leaves src scripts", () => {
    const written = new Map<string, string>();
    const html = `<html>
<script src="/lang.js"></script>
<script id="check-dark-mode">document.documentElement.classList.add("dark");</script>
<script type="application/ld+json">{"@type":"WebSite"}</script>
<script>window.__VP_HASH_MAP__={};</script>
</html>`;
    const out = rewriteHtml(html, (name, source) => written.set(name, source), "/doc/assets/");
    expect(out).toContain('<script src="/lang.js"></script>');
    expect(out).toContain('type="application/ld+json"');
    expect(out).not.toContain("classList.add");
    expect(out).not.toContain("__VP_HASH_MAP__={}");
    expect([...written.values()].some((s) => s.includes("classList.add"))).toBe(true);
    expect([...written.values()].some((s) => s.includes("__VP_HASH_MAP__"))).toBe(true);
    for (const name of written.keys()) {
      expect(out).toContain(`src="/doc/assets/${name}"`);
    }
  });

  test("identical bodies share one filename", () => {
    const written = new Map<string, string>();
    rewriteHtml(
      "<script>a=1</script><script>a=1</script>",
      (name, source) => written.set(name, source),
      "/doc/assets/",
    );
    expect(written.size).toBe(1);
  });
});

describe("rewriteTree", () => {
  test("rewrites nested html after VitePress writes dist", () => {
    const root = mkdtempSync(join(tmpdir(), "pf-inline-"));
    mkdirSync(join(root, "zh"), { recursive: true });
    writeFileSync(join(root, "index.html"), "<script>window.X=1</script>");
    writeFileSync(join(root, "zh", "index.html"), "<script>window.X=1</script>");
    expect(rewriteTree(root)).toBe(2);
    const index = readFileSync(join(root, "index.html"), "utf8");
    expect(index).toMatch(/src="\/doc\/assets\/inline-[A-Za-z0-9_-]+\.js"/);
    expect(index).not.toContain("window.X=1");
  });
});
