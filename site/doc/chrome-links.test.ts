import { describe, expect, test } from "bun:test";

const chrome = await Bun.file(new URL("./.vitepress/theme/ChromeLinks.vue", import.meta.url)).text();

describe("docs chrome leaves the VitePress SPA", () => {
  test("首页 and Open Pairfob are full-page exits, not in-app routes", () => {
    expect(chrome).toContain(`:href="zh ? '/zh/' : '/'"`);
    expect(chrome).toContain('href="/pair"');
    expect(chrome).toMatch(/class="pf-nav-link"[^>]*target="_self"/);
    expect(chrome).toMatch(/href="\/pair"[^>]*target="_self"/);
  });

  test("docs chrome links to the public GitHub issue form", () => {
    expect(chrome).toContain("https://github.com/arronKler/pairfob/issues/new");
    expect(chrome).toContain('target="_blank"');
    expect(chrome).toContain("Feedback");
    expect(chrome).toContain("反馈");
  });
});

const locales = await Bun.file(new URL("./.vitepress/locales.ts", import.meta.url)).text();

describe("docs theme GitHub social link", () => {
  test("points at the public repository, not the issue form", () => {
    expect(locales).toContain('icon: "github"');
    expect(locales).toContain('link: "https://github.com/arronKler/pairfob"');
  });
});
