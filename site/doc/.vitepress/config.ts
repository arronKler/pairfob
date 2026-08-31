import { join } from "node:path";
import { defineConfig } from "vitepress";
import { extractInlineScripts, rewriteTree } from "./extract-inline";
import { enTheme, zhSearch, zhTheme, enSearch } from "./locales";

export default defineConfig({
  title: "Pairfob",
  description: "How to use Pairfob",
  base: "/doc/",
  cleanUrls: true,
  appearance: "force-dark",
  ignoreDeadLinks: true,
  lastUpdated: false,
  markdown: {
    headers: { level: [2, 3] },
    theme: { light: "github-light", dark: "github-dark" },
  },
  sitemap: {
    hostname: "https://pairfob.com/doc/",
  },
  themeConfig: {
    search: {
      provider: "local",
      options: {
        locales: {
          root: enSearch,
          zh: zhSearch,
        },
      },
    },
  },
  head: [
    ["link", { rel: "icon", href: "/doc/icon.svg", type: "image/svg+xml" }],
    ["meta", { name: "theme-color", content: "#07090d" }],
    ["meta", { name: "color-scheme", content: "dark" }],
    // Versioned so a locale-routing change is not masked by a cached copy.
    // Kept in step with index.html; scripts/pack-origin-assets.sh fails on drift.
    ["script", { src: "/lang.js?v=49" }],
  ],
  buildEnd() {
    // VitePress injects HASH_MAP after some Vite HTML transforms; run again here.
    rewriteTree(join(process.cwd(), ".vitepress/dist"));
  },
  vite: {
    plugins: [extractInlineScripts()],
  },
  locales: {
    root: {
      label: "English",
      lang: "en",
      description: "The Herdr session on your computer, continued on your phone or another device.",
      themeConfig: enTheme,
    },
    zh: {
      label: "中文",
      lang: "zh-CN",
      description: "电脑上的 Herdr 会话，接到手机或其他设备上接着操作。",
      themeConfig: zhTheme,
    },
  },
});
