import { describe, expect, test } from "bun:test";

const CJK = /[\u4e00-\u9fff]/;
const source = await Bun.file(new URL("../home-i18n.js", import.meta.url)).text();
const html = await Bun.file(new URL("../index.html", import.meta.url)).text();

function table(name: "zh" | "en"): Record<string, string> {
  const start = source.indexOf(`const ${name} = {`);
  const end = source.indexOf("\n  };", start);
  if (start < 0 || end < 0) throw new Error(`missing ${name} table`);
  const objectLiteral = source.slice(source.indexOf("{", start), end + 4);
  return Function(`"use strict"; return (${objectLiteral})`)() as Record<string, string>;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

describe("homepage i18n", () => {
  const zh = table("zh");
  const en = table("en");

  test("zh and en share the same keys", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });

  test("English copy has no leftover Chinese", () => {
    const leftover: string[] = [];
    for (const [key, value] of Object.entries(en)) {
      if (CJK.test(value)) leftover.push(key);
    }
    expect(leftover).toEqual([]);
  });

  test("static HTML keeps Chinese only on the language switcher", () => {
    const withoutSwitcher = html.replace(/<button[^>]*data-lang="zh"[^>]*>中文<\/button>/, "");
    expect(CJK.test(withoutSwitcher)).toBe(false);
  });

  test("homepage copy does not mention Markdown rendering", () => {
    expect(source.toLowerCase()).not.toContain("markdown");
    expect(html.toLowerCase()).not.toContain("markdown");
  });

  test("computer visitors are not sent to /pair as the primary action", () => {
    expect(html).toContain('class="bar-cta cta-desk" href="#start"');
    expect(html).toContain('class="btn btn-primary cta-desk" href="#start"');
    expect(html).toContain('class="bar-cta cta-phone" href="/pair"');
    expect(html).not.toMatch(/class="bar-cta"(?! cta-phone)[^>]*href="\/pair"/);
    expect(html).toContain('class="copy cta-desk" data-copy="https://pairfob.com/pair"');
    expect(html).toContain("Don't open it on this computer.");
    expect(html).not.toMatch(/<a[^>]*href="\/pair"[^>]*>https:\/\/pairfob.com\/pair/);
    expect(zh["cta.phone.hint"]).toContain("不要在这台电脑");
    expect(en["cta.computer"]).toBe("Start on this computer");
    expect(zh["cta.computer"]).toBe("在这台电脑上开始");
  });

  test("phone visitors get a same-tab /pair button in the how-to and pair bands", () => {
    expect(html).toContain('class="step-open cta-phone"');
    expect(html).toMatch(/class="step-open cta-phone"[\s\S]*?href="\/pair"/);
    expect(html).toContain('class="pair-open cta-phone"');
    expect(html).toMatch(/class="pair-open cta-phone"[\s\S]*?href="\/pair"/);
    expect(html).toContain('class="step-host-note cta-phone"');
    expect(html).toContain('data-i18n="start.s3.phone"');
    expect(en["start.s3.phone"]).toContain("this phone");
    expect(zh["start.s3note.phone"]).toContain("点进去");
    expect(zh["start.hostnote"]).toContain("电脑终端");
  });

  test("homepage exposes a GitHub issue channel", () => {
    expect(html).toContain("https://github.com/arronKler/pairfob/issues/new");
    expect(html).toContain('data-i18n="nav.feedback"');
    expect(html).toContain('class="faq-feedback"');
    expect(html).toContain('data-i18n="faq.feedback"');
    expect(zh["nav.feedback"]).toBe("反馈");
    expect(en["nav.feedback"]).toBe("Feedback");
    expect(zh["faq.feedback"]).toContain("GitHub");
    expect(en["faq.feedback"]).toContain("GitHub");
    expect(en["faq.feedback.b"]).toBe("Report an issue");
  });

  test("homepage header links to the public GitHub repository", () => {
    expect(html).toMatch(/class="bar-github"[^>]*href="https:\/\/github.com\/arronKler\/pairfob"/);
    expect(html).toContain('data-i18n-aria="nav.github"');
    expect(html).toContain('"codeRepository": "https://github.com/arronKler/pairfob"');
    expect(en["nav.github"]).toBe("Source on GitHub");
    expect(zh["nav.github"]).toBe("GitHub 上的源码");
  });

  test("homepage paid FAQ is a short no, not a policy paragraph", () => {
    expect(en["faq.q6"]).toBe("Does it cost money?");
    expect(en["faq.a6"]).toBe("No.");
    expect(zh["faq.q6"]).toBe("收费吗？");
    expect(zh["faq.a6"]).toBe("不收费。");
    expect(en["faq.a6"]).not.toContain("official instance");
    expect(zh["faq.a6"]).not.toContain("官方实例");
    expect(en["foot.blurb"]).not.toContain("official instance");
    expect(zh["foot.blurb"]).not.toContain("官方实例");
    expect(en["hero.lede2"]).not.toContain("screenshot");
    expect(zh["hero.lede2"]).not.toContain("截图");
    expect(en.description).toContain("phone surface for Herdr");
    expect(zh.description).toContain("Herdr 的手机端");
    expect(html).toContain(en.description);
  });

  test("static HTML fallbacks match English copy", () => {
    const re = /data-i18n(?:-html)?="([^"]+)"(?:\s+data-i18n-html)?>([\s\S]*?)<\/[^>]+>/g;
    const drift: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = re.exec(html))) {
      const key = match[1];
      const expected = en[key];
      if (expected === undefined) {
        drift.push(`${key} missing from en`);
        continue;
      }
      if (normalize(match[2]) !== normalize(expected)) drift.push(key);
    }
    expect(drift).toEqual([]);
  });
});
