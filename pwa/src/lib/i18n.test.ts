import { afterEach, describe, expect, test } from "bun:test";
import "../../test-support/boot-dom";
import { copy, resolveCopy, copyKeys, detectLang, lang, langPref, setLang, setLangPref, t } from "./i18n";
import { enSingular } from "./i18n-en-plurals";
import { en } from "./i18n-en";
import { zh } from "./i18n-zh";

afterEach(() => {
  setLang("zh");
  try {
    localStorage.removeItem("pairfob_lang");
  } catch {
    /* happy-dom may not have storage */
  }
});

describe("i18n catalogs", () => {
  test("english has every chinese key and no extras", () => {
    const zhKeys = copyKeys().sort();
    const enKeys = Object.keys(en).sort();
    expect(enKeys).toEqual(zhKeys);
    expect(zhKeys.length).toBeGreaterThan(200);
  });

  test("interpolation replaces named slots", () => {
    setLang("en");
    expect(t("boot.connecting", { name: "desk" })).toBe("Connecting back to desk…");
    setLang("zh");
    expect(t("boot.connecting", { name: "desk" })).toBe("正在连回desk…");
  });

  test("update and push catalogs cover the former hardcoded copy", () => {
    expect(t("update.check")).toBe("检查更新");
    expect(t("push.titleBlocked")).toBe("Pairfob · 等待确认");
    setLang("en");
    expect(t("update.check")).toBe("Check for updates");
    expect(t("push.titleDone")).toBe("Pairfob · Turn finished");
    expect(t("quota.window.premium")).toBe("Premium interactions");
    expect(t("ft.webglLost")).toContain("WebGL");
  });
});

describe("language preference", () => {
  test("detectLang prefers chinese then english then english default", () => {
    const nav = globalThis.navigator as { language?: string; languages?: string[] };
    const prevLang = nav.language;
    const prevList = nav.languages;
    Object.defineProperty(nav, "languages", { configurable: true, value: ["fr-FR", "zh-CN"] });
    expect(detectLang()).toBe("zh");
    Object.defineProperty(nav, "languages", { configurable: true, value: ["en-GB"] });
    expect(detectLang()).toBe("en");
    Object.defineProperty(nav, "languages", { configurable: true, value: ["de-DE"] });
    expect(detectLang()).toBe("en");
    Object.defineProperty(nav, "language", { configurable: true, value: prevLang });
    Object.defineProperty(nav, "languages", { configurable: true, value: prevList });
  });

  test("auto clears storage and follows the browser", () => {
    setLangPref("en");
    expect(lang()).toBe("en");
    expect(langPref()).toBe("en");
    expect(t("home.settings")).toBe(en["home.settings"]);
    setLangPref("auto");
    expect(langPref()).toBe("auto");
    expect(["en", "zh"]).toContain(lang());
  });

  test("explicit chinese and english persist", () => {
    setLangPref("zh");
    expect(lang()).toBe("zh");
    expect(t("home.settings")).toBe(zh["home.settings"]);
    setLangPref("en");
    expect(lang()).toBe("en");
    expect(t("home.settings")).toBe("Settings");
  });
});

test("stored nested copy resolves in the current language", () => {
  setLang("zh");
  const detail = copy("ft.loadFail", { error: copy("ft.webglLost") });
  const chinese = resolveCopy(detail);
  setLang("en");
  expect(resolveCopy(detail)).toBe(t("ft.loadFail", { error: t("ft.webglLost") }));
  expect(resolveCopy(detail)).not.toBe(chinese);
});

test("English count copy handles zero, one and many without changing Chinese", () => {
  setLang("en");
  expect(t("diffNotes.count", { count: 0 })).toBe("0 comments");
  expect(t("diffNotes.count", { count: 1 })).toBe("1 comment");
  expect(t("diffNotes.count", { count: 2 })).toBe("2 comments");
  expect(t("trace.runningSteps", { n: 1 })).toBe("Running · 1 step");
  expect(t("trace.nSteps", { n: 2 })).toBe("Run · 2 steps");
  expect(t("tabs.attentionAria", { count: "1" })).toBe("1 pane needs you");
  setLang("zh");
  expect(t("diffNotes.count", { count: 1 })).toBe("1 条批注");
});

test("singular alternatives preserve every interpolation slot", () => {
  const slots = (text: string) => [...text.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]).sort();
  for (const [key, value] of Object.entries(enSingular)) {
    expect(slots(value!)).toEqual(slots(en[key as keyof typeof en]));
  }
});
