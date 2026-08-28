import { describe, expect, test } from "bun:test";

const chrome = await Bun.file(new URL("./.vitepress/theme/ChromeLinks.vue", import.meta.url)).text();

describe("docs chrome leaves the VitePress SPA", () => {
  test("首页 and Open Pairfob are full-page exits, not in-app routes", () => {
    expect(chrome).toContain(`:href="zh ? '/zh/' : '/'"`);
    expect(chrome).toContain('href="/pair"');
    expect(chrome).toMatch(/class="pf-nav-link"[^>]*target="_self"/);
    expect(chrome).toMatch(/href="\/pair"[^>]*target="_self"/);
  });
});
