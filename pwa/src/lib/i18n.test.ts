import { afterEach, describe, expect, test } from "bun:test";
import { copyKeys, detectLang, lang, langPref, setLang, setLangPref, t } from "./i18n";
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
