<script setup lang="ts">
import { computed } from "vue";
import { useData } from "vitepress";

const { lang } = useData();
const zh = computed(() => lang.value.startsWith("zh"));

function go(next: "zh" | "en") {
  const api = (window as unknown as { PairfobLang?: {
    set: (lang: string) => string;
    docPath: (path: string, lang: string) => string;
    samePath: (a: string, b: string) => boolean;
  } }).PairfobLang;
  if (api) {
    api.set(next);
    const target = api.docPath(location.pathname, next);
    if (!api.samePath(target, location.pathname)) {
      location.assign(target + location.search + location.hash);
    }
    return;
  }
  // Fallback when lang.js has not loaded. English is the root locale.
  const path = location.pathname;
  const rest = path.startsWith("/doc") ? path.slice(4) || "/" : "/";
  const body = rest === "/zh" || rest.startsWith("/zh/") ? rest.slice(3) || "/" : rest;
  location.assign(next === "zh" ? (body === "/" ? "/doc/zh/" : "/doc/zh" + body) : body === "/" ? "/doc/" : "/doc" + body);
}
</script>

<template>
  <nav class="pf-lang" :aria-label="zh ? '语言' : 'Language'">
    <button type="button" class="pf-lang-btn" lang="zh-CN" :aria-current="zh ? 'page' : undefined" @click="go('zh')">
      中文
    </button>
    <button type="button" class="pf-lang-btn" lang="en" :aria-current="!zh ? 'page' : undefined" @click="go('en')">
      EN
    </button>
  </nav>
  <a class="pf-nav-link" :href="zh ? '/zh/' : '/'" target="_self">{{ zh ? "首页" : "Home" }}</a>
  <a
    class="pf-nav-link"
    href="https://github.com/arronKler/pairfob/issues/new"
    target="_blank"
    rel="noreferrer"
  >{{ zh ? "反馈" : "Feedback" }}</a>
  <a class="pf-nav-app" href="/pair" target="_self">{{ zh ? "打开 Pairfob" : "Open Pairfob" }}</a>
</template>
