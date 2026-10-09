import { afterAll, describe, expect, test } from "bun:test";
import { lang, setLang, t } from "../../lib/i18n";

/**
 * A compose field's placeholder is one line on a 320px phone. Left to wrap it
 * counts as a second line of draft and the empty field grows from 46 to 64px.
 *
 * The room is what a 320px screen leaves the text: 20px of dock padding, the
 * attach button and its gap, the field's own 30px of padding and border, and
 * the widest button a resting field stands beside. Measured in the 16px system
 * font the field uses: 126px beside 停止 / Stop, 134px beside an English Send,
 * 162px beside the live field's ⏎.
 *
 * A test DOM has no fonts, so widths here are an upper estimate per character
 * (a Latin letter of that font runs about 9px, a capital or an m 11.5, and a
 * CJK glyph is the 16px em). It is deliberately pessimistic: copy that passes fits on glass.
 */
function estimate(text: string): number {
  let width = 0;
  for (const char of text) {
    if (/[⺀-鿿＀-￯]/.test(char)) width += 16;
    else if (char === " ") width += 4;
    else if (/[·,.'’:;!|il]/.test(char)) width += 5;
    else if (/[A-Zmw]/.test(char)) width += 11.5;
    else width += 9.2;
  }
  return Math.ceil(width);
}

const original = lang();
afterAll(() => setLang(original));

const BESIDE_STOP = 126;
const BESIDE_SEND = 134;
const BESIDE_ENTER = 162;

describe("compose placeholders fit a 320px phone on one line", () => {
  for (const language of ["zh", "en"] as const) {
    test(`${language}: the compose, chat and cannot-send lines fit beside the widest button`, () => {
      setLang(language);
      // 组字 beside 停止 while the agent works; the chat field's working and blocked lines likewise.
      for (const key of ["compose.batchPh", "chat.placeholderWorking", "chat.cantSendPh"] as const) {
        expect(estimate(t(key)), `${key}: ${t(key)}`).toBeLessThanOrEqual(BESIDE_STOP);
      }
      expect(estimate(t("chat.placeholder")), t("chat.placeholder")).toBeLessThanOrEqual(BESIDE_SEND);
    });

    test(`${language}: the live line fits beside ⏎`, () => {
      setLang(language);
      expect(estimate(t("compose.livePh")), t("compose.livePh")).toBeLessThanOrEqual(BESIDE_ENTER);
    });
  }

  test("the estimate is an upper bound on what the browser measured", () => {
    // Chromium, -apple-system 16px: the numbers the copy was chosen against.
    expect(estimate("Compose · Send")).toBeGreaterThanOrEqual(120);
    expect(estimate("Live · sent as typed")).toBeGreaterThanOrEqual(141);
    expect(estimate("Send a message")).toBeGreaterThanOrEqual(120);
    expect(estimate("组字 · 写完点发送")).toBeGreaterThanOrEqual(125);
    // The lines this replaced do not pass.
    expect(estimate("Compose · tap Send when done")).toBeGreaterThan(BESIDE_STOP);
    expect(estimate("You can send while it runs")).toBeGreaterThan(BESIDE_STOP);
    expect(estimate("Message the agent")).toBeGreaterThan(BESIDE_SEND);
  });

  test("beside the list the composed line is no longer than the live one, which fits the 720px column's field", () => {
    // The field there is 147px in English (Chromium, 15px): "Live · sent as typed" measures 133 and fits;
    // "Compose · send when done" measured 190 and faded out after "send whe".
    for (const language of ["zh", "en"] as const) {
      setLang(language);
      expect(estimate(t("deskDock.batchPh")), t("deskDock.batchPh")).toBeLessThanOrEqual(estimate(t("compose.livePh")));
    }
    setLang("en");
    expect(t("deskDock.batchPh")).toMatch(/^Compose · /);
    setLang("zh");
    expect(t("deskDock.batchPh")).toMatch(/^组字 · /);
  });

  test("the copy still says what the field is: the mode, and what sends", () => {
    setLang("en");
    expect(t("compose.batchPh")).toMatch(/^Compose · .*Send/);
    expect(t("compose.livePh")).toMatch(/^Live · /);
    setLang("zh");
    expect(t("compose.batchPh")).toMatch(/^组字 · .*发送/);
    expect(t("compose.livePh")).toMatch(/^实时 · /);
  });
});
