// Shared locale preference for the marketing page and /doc.
// Cookie + localStorage: pairfob_lang=zh|en
//
// English is the default locale and owns the bare paths (`/`, `/doc/`), because
// that is what crawlers and link unfurlers read. Chinese lives under `/zh`.
// First visit: a /zh or /doc/zh URL is explicit Chinese; otherwise use the
// browser language list (zh* → Chinese, en* → English, default English).
(function (global) {
  const KEY = "pairfob_lang";
  const YEAR = 31536000;
  const ALT = "zh";
  const ALT_PREFIX = "/" + ALT;

  function readSaved() {
    try {
      const stored = localStorage.getItem(KEY);
      if (stored === "en" || stored === "zh") return stored;
    } catch {
      /* private mode */
    }
    const match = document.cookie.match(/(?:^|; )pairfob_lang=(en|zh)(?:;|$)/);
    return match ? match[1] : null;
  }

  function set(lang) {
    const value = lang === "en" ? "en" : "zh";
    try {
      localStorage.setItem(KEY, value);
    } catch {
      /* private mode */
    }
    document.cookie = KEY + "=" + value + ";path=/;max-age=" + YEAR + ";SameSite=Lax";
    return value;
  }

  function detect() {
    const list =
      global.navigator && navigator.languages && navigator.languages.length
        ? navigator.languages
        : [navigator.language || navigator.userLanguage];
    for (let i = 0; i < list.length; i++) {
      const tag = String(list[i] || "").toLowerCase();
      if (tag.startsWith("zh")) return "zh";
      if (tag.startsWith("en")) return "en";
    }
    return "en";
  }

  function queryLang() {
    try {
      const value = new URLSearchParams(location.search).get("lang");
      if (value === "en" || value === "zh") return value;
    } catch {
      /* ignore */
    }
    return null;
  }

  function isExplicitAlt(path) {
    return (
      path === ALT_PREFIX ||
      path.startsWith(ALT_PREFIX + "/") ||
      path === "/doc" + ALT_PREFIX ||
      path.startsWith("/doc" + ALT_PREFIX + "/")
    );
  }

  /**
   * An explicit locale URL outranks a stored preference: /zh is the only way to
   * hand someone the Chinese page, and it would be useless if anyone who once
   * clicked EN got bounced back. The stored preference still decides unqualified
   * entry (`/`, `/doc/`), and an explicit visit does not overwrite it.
   */
  function prefer(path) {
    const forced = queryLang();
    if (forced) return set(forced);
    if (isExplicitAlt(path || location.pathname)) return ALT;
    const saved = readSaved();
    if (saved) return saved;
    return detect();
  }

  function get() {
    return prefer(location.pathname);
  }

  function stripSlash(path) {
    if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
    return path || "/";
  }

  function marketingPath(lang) {
    return lang === ALT ? ALT_PREFIX + "/" : "/";
  }

  function docPath(path, lang) {
    let rest = path.startsWith("/doc") ? path.slice(4) : path;
    if (!rest) rest = "/";
    if (rest === ALT_PREFIX || rest.startsWith(ALT_PREFIX + "/")) {
      rest = rest.slice(ALT_PREFIX.length) || "/";
    }
    if (lang === ALT) return rest === "/" ? "/doc" + ALT_PREFIX + "/" : "/doc" + ALT_PREFIX + rest;
    return rest === "/" ? "/doc/" : "/doc" + rest;
  }

  function samePath(a, b) {
    return stripSlash(a) === stripSlash(b);
  }

  function bootDocs() {
    const path = location.pathname;
    if (!path.startsWith("/doc")) return;
    const lang = prefer(path);
    if (!readSaved()) set(lang);
    document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
    const next = docPath(path, lang);
    if (!samePath(next, path)) {
      location.replace(next + location.search + location.hash);
    }
  }

  function prepareMarketing() {
    const path = location.pathname;
    const lang = prefer(path);
    document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
    document.documentElement.dataset.lang = lang;
  }

  function notify(lang) {
    document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
    document.documentElement.dataset.lang = lang;
    document.documentElement.setAttribute("data-i18n-ready", "1");
    try {
      global.dispatchEvent(new CustomEvent("pairfob-lang", { detail: { lang } }));
    } catch {
      /* ignore */
    }
  }

  global.PairfobLang = {
    KEY,
    get,
    set,
    detect,
    prefer,
    readSaved,
    isExplicitAlt,
    marketingPath,
    docPath,
    samePath,
    bootDocs,
    prepareMarketing,
    notify,
  };

  if (typeof location !== "undefined") {
    if (location.pathname.indexOf("/doc") === 0) bootDocs();
    else prepareMarketing();
  }
})(typeof window !== "undefined" ? window : globalThis);
