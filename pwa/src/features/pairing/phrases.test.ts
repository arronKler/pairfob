import { describe, expect, test } from "bun:test";
import { en as enCopy } from "../../lib/i18n-en";
import { zh as zhCopy } from "../../lib/i18n-zh";
import { keepPhrases } from "./phrases";

const NBSP = " ";
/** Where a line may break once the sentence is drawn with `word-break: keep-all`: after a pause, or at a plain space. */
const runs = (text: string) => keepPhrases(text).split(/(?<=[，。：；！？、])| /).filter(Boolean);
/** A run's width in ems: a Chinese character is one, a Latin letter about half. */
const ems = (run: string) => [...run].reduce((sum, char) => sum + (/[⺀-￯]/.test(char) ? 1 : 0.55), 0);

describe("what a pairing sentence keeps on one line", () => {
  test("a command, the terminal's own line and a number with its unit stay whole in Chinese", () => {
    expect(keepPhrases("在电脑终端运行 pairfob pair，再扫出现的二维码。")).toBe(`在电脑终端运行 pairfob${NBSP}pair，再扫出现的二维码。`);
    expect(keepPhrases("终端里亮起 Press Enter to pair，按一下 ")).toBe(`终端里亮起 Press${NBSP}Enter${NBSP}to${NBSP}pair，按一下 `);
    expect(keepPhrases("配对码太长了：应该是 14 位，现在识别到 20 位。")).toBe(`配对码太长了：应该是 14${NBSP}位，现在识别到 20${NBSP}位。`);
    // The space before a name or a number is still a place to break.
    expect(runs("看电脑 pairfob 打印的当前码。")).toEqual(["看电脑", "pairfob", "打印的当前码。"]);
  });

  test("English keeps its word breaks, and only what is typed or read letter for letter stays whole", () => {
    expect(keepPhrases("Pairing timed out. Try again with the QR or code the computer shows now."))
      .toBe("Pairing timed out. Try again with the QR or code the computer shows now.");
    expect(keepPhrases("Run pairfob pair on the computer again, then type the new pairing code."))
      .toBe(`Run pairfob${NBSP}pair on the computer again, then type the new pairing code.`);
    expect(keepPhrases("The terminal now shows Press Enter to pair. Press ")).toBe(`The terminal now shows Press${NBSP}Enter${NBSP}to${NBSP}pair. Press `);
    // A count stays with what it counts.
    expect(keepPhrases("The pairing code is not complete: 14 characters needed, 4 recognized."))
      .toBe(`The pairing code is not complete: 14${NBSP}characters needed, 4${NBSP}recognized.`);
  });

  test("no Chinese pairing sentence has a run without a pause longer than the narrowest phone's line", () => {
    // 320px leaves the lede 288px: twenty characters at its size. A longer run
    // can only break where it overflows, which strands its last character or two.
    const shown = Object.entries(zhCopy as Record<string, string>).filter(([key]) =>
      /^connect\.(lede|failedLede|connectingLede|approveLede|phoneNote|pairHelp)/.test(key)
      || /^err\.(pair|unpaired|locator_required|invalid_pair|rate_limited|timeout$|generic$|noClipboardCode|clipboardDenied|scanFailed)/.test(key));
    expect(shown.length).toBeGreaterThan(15);
    for (const [key, text] of shown) {
      for (const run of runs(text.replace("{key}", "").replace("{n}", "20"))) {
        expect(`${key}: ${run} (${ems(run).toFixed(1)})`).toBe(ems(run) <= 19 ? `${key}: ${run} (${ems(run).toFixed(1)})` : `${key}: a run of at most 19 ems`);
      }
    }
  });

  test("a too-long code has words of its own in both languages, and nobody is told about glyphs", () => {
    for (const copy of [zhCopy, enCopy] as Array<Record<string, string>>) {
      expect(copy["err.pairTooLong"]).toContain("{n}");
      expect(copy["err.pairTooLong"]).not.toBe(copy["err.pairIncomplete"]);
    }
    expect(Object.values(enCopy as Record<string, string>).filter(text => /glyph/i.test(text))).toEqual([]);
  });
});
