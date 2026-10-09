import { describe, expect, test } from "bun:test";
import { setLang } from "../../lib/i18n";
import { connectViewModel, formatPairCodeDraft, pairCodeProblem, pastedPairCode } from "./model";

const empty = {
  phase: "connect",
  addingComputer: false,
  computerCount: 0,
  fragment: null,
  pairCodeDraft: "",
  pairManualOpen: false,
  pairErrorTarget: null as "code" | null,
  pairFailedStep: null,
  pairAwaitingApproval: false,
  notice: null,
  wide: false,
  finePointer: false,
};

describe("connect view model", () => {
  test("first pairing and add-computer share one skeleton; only the chrome differs", () => {
    setLang("zh");
    const first = connectViewModel(empty);
    expect(first.stage).toBe("idle");
    expect(first.title).toBe("连上你的电脑");
    expect(first.adding).toBeFalse();
    expect(first.showInstall).toBeTrue();
    const add = connectViewModel({ ...empty, addingComputer: true });
    expect(add.stage).toBe("idle");
    expect(add.backTitle).toBe("添加电脑");
    expect(add.title).toBe(first.title);
    expect(add.lede).toContain("pairfob pair");
  });

  test("the handshake stages swap copy and hide the sheet", () => {
    setLang("zh");
    const connecting = connectViewModel({ ...empty, phase: "pairing", pairManualOpen: true });
    expect(connecting.stage).toBe("connecting");
    expect(connecting.busy).toBeTrue();
    expect(connecting.sheetOpen).toBeFalse();
    const approve = connectViewModel({ ...empty, phase: "pairing", pairAwaitingApproval: true });
    expect(approve.stage).toBe("approve");
    expect(approve.title).toContain("Enter");
    expect(approve.ledeKeycap).toBeTrue();
    expect(approve.lede).toContain("{key}");
  });

  test("a step failure lands on the page; a code failure stays on the field", () => {
    setLang("zh");
    const notice = { text: "电脑上没有确认。", tone: "error" as const };
    const failed = connectViewModel({ ...empty, pairFailedStep: "verify", notice });
    expect(failed.stage).toBe("failed");
    expect(failed.lede).toBe("电脑上没有确认。");
    expect(failed.ledeTone).toBe("error");
    const code = connectViewModel({ ...empty, pairFailedStep: "code", pairErrorTarget: "code", pairManualOpen: true, notice });
    expect(code.stage).toBe("idle");
    expect(code.fieldNotice).toEqual(notice);
    expect(code.pairCodeInvalid).toBeTrue();
    expect(code.lede).not.toBe(notice.text);
  });

  test("an incomplete code is not marked complete; clipboard formatting groups it 4-4-6", () => {
    const draft = connectViewModel({ ...empty, pairCodeDraft: "ABCD-EFGH" });
    expect(draft.pairCodeLength).toBe(8);
    expect(draft.pairCodeComplete).toBeFalse();
    expect(formatPairCodeDraft("7k3m9h2pwj3k9m")).toBe("7K3M-9H2P-WJ3K9M");
    expect(formatPairCodeDraft("7k3mo")).toBe("7K3M-0");
    expect(formatPairCodeDraft("https://pairfob.com/pair#c=1")).toBe("https://pairfob.com/pair#c=1");
    // Grouping keeps every character it was given.
    expect(formatPairCodeDraft("7k3m9h2pwj3k9mxyz")).toBe("7K3M-9H2P-WJ3K9MXYZ");
  });

  test("more characters than a code has is said at once, on the field, wherever the field is", () => {
    setLang("zh");
    const twenty = "abcd2345abcd2345abcd";
    // The sheet, the wide card and the typed card; nothing was submitted and no notice was raised.
    for (const where of [{ pairManualOpen: true }, { wide: true, finePointer: true }, { finePointer: true }]) {
      const over = connectViewModel({ ...empty, ...where, pairCodeDraft: twenty });
      expect(over.pairCodeDraft).toBe(twenty);
      expect([over.pairCodeLength, over.pairCodeComplete, over.pairCodeOver, over.pairCodeInvalid]).toEqual([20, false, true, true]);
      expect(over.fieldNotice).toEqual({ text: "配对码太长了：应该是 14 位，现在识别到 20 位。", tone: "error" });
      // The page's own lede is not turned into the field's message.
      expect(over.ledeTone).toBe("muted");
    }
    // Separators and stray marks are not characters of the code.
    const dotted = connectViewModel({ ...empty, finePointer: true, pairCodeDraft: "ABCD.2345.ABCD.23456" });
    expect(dotted.pairCodeLength).toBe(17);
    expect(dotted.fieldNotice?.text).toBe("配对码太长了：应该是 14 位，现在识别到 17 位。");
    // The live count replaces an older rejection's words, and goes as soon as the entry is short enough.
    const stale = { text: "配对码格式不对。请按电脑上显示的完整码输入。", tone: "error" as const };
    expect(connectViewModel({ ...empty, finePointer: true, pairCodeDraft: twenty, pairErrorTarget: "code", pairFailedStep: "code", notice: stale })
      .fieldNotice?.text).toContain("20");
    const exact = connectViewModel({ ...empty, finePointer: true, pairCodeDraft: "abcd2345abcd23" });
    expect([exact.pairCodeOver, exact.pairCodeInvalid, exact.pairCodeComplete, exact.fieldNotice]).toEqual([false, false, true, null]);
    const short = connectViewModel({ ...empty, finePointer: true, pairCodeDraft: "abcd" });
    expect([short.pairCodeOver, short.pairCodeInvalid, short.fieldNotice]).toEqual([false, false, null]);
    // A handshake in flight shows the code it is using, read-only: nothing to correct.
    expect(connectViewModel({ ...empty, finePointer: true, phase: "pairing", pairCodeDraft: twenty }).pairCodeOver).toBeFalse();
  });
});

describe("layout and the way in", () => {
  test("width picks the layout and the pointer picks the way in, each on its own", () => {
    setLang("zh");
    const phone = connectViewModel(empty);
    expect([phone.layout, phone.entry]).toEqual(["phone", "scan"]);
    // A narrow desktop window is one column, and still has nothing to scan with.
    const narrowMouse = connectViewModel({ ...empty, finePointer: true });
    expect([narrowMouse.layout, narrowMouse.entry]).toEqual(["phone", "code"]);
    // A landscape tablet is wide and still has the camera.
    const tablet = connectViewModel({ ...empty, wide: true });
    expect([tablet.layout, tablet.entry]).toEqual(["wide", "scan"]);
    const desktop = connectViewModel({ ...empty, wide: true, finePointer: true });
    expect([desktop.layout, desktop.entry]).toEqual(["wide", "code"]);
    expect(new Set([phone.lede, narrowMouse.lede, tablet.lede, desktop.lede]).size).toBe(4);
    for (const typed of [narrowMouse, desktop]) {
      expect(typed.lede).not.toContain("手机");
      expect(typed.lede).not.toContain("扫");
    }
    // The field is beside the steps with two columns and under them with one.
    expect(desktop.lede).toContain("右边");
    expect(narrowMouse.lede).toContain("下面");
    expect(narrowMouse.lede).not.toContain("右边");
  });

  test("a touch screen below the wide tier is the phone page exactly, sheet and all", () => {
    setLang("zh");
    const notice = { text: "已取消配对。", tone: "status" as const };
    const touch = connectViewModel({ ...empty, pairManualOpen: true, notice });
    expect([touch.layout, touch.entry]).toEqual(["phone", "scan"]);
    expect(touch.sheetOpen).toBeTrue();
    expect(touch.fieldNotice).toEqual(notice);
    expect(connectViewModel(empty).lede).toBe("在电脑终端运行 pairfob pair，再扫出现的二维码。");
    expect(connectViewModel(empty).showInstall).toBeTrue();
  });

  test("typing on the page has no sheet: a code error goes to the field, anything else to the lede", () => {
    setLang("zh");
    const desktop = { ...empty, wide: true, finePointer: true };
    const error = { text: "配对码还没输完整", tone: "error" as const };
    const status = { text: "已取消配对。", tone: "status" as const };
    // In one column as in two.
    for (const mouse of [desktop, { ...desktop, wide: false }]) {
      const code = connectViewModel({ ...mouse, pairManualOpen: true, pairErrorTarget: "code", pairFailedStep: "code", notice: error });
      expect(code.sheetOpen).toBeFalse();
      expect(code.fieldNotice).toEqual(error);
      expect(code.pairCodeInvalid).toBeTrue();
      expect(code.lede).not.toBe(error.text);
      const cancelled = connectViewModel({ ...mouse, notice: status });
      expect(cancelled.fieldNotice).toBeNull();
      expect(cancelled.lede).toBe(status.text);
    }
    // The same input on a touch screen opens the sheet and shows the notice there.
    const sheet = connectViewModel({ ...desktop, finePointer: false, pairManualOpen: true, notice: status });
    expect(sheet.sheetOpen).toBeTrue();
    expect(sheet.fieldNotice).toEqual(status);
  });

  test("a failed step without its own message does not send a mouse to a scanner", () => {
    setLang("zh");
    const failed = { ...empty, pairFailedStep: "verify" as const };
    expect(connectViewModel(failed).lede).toContain("扫码");
    expect(connectViewModel({ ...failed, wide: true, finePointer: true }).lede).not.toContain("扫");
    expect(connectViewModel({ ...failed, finePointer: true }).lede).not.toContain("扫");
  });
});

describe("a pasted code", () => {
  test("a code alone is taken in any spacing the computer or a reader gives it", () => {
    expect(pastedPairCode("7K3M-9H2P-WJ3K9M")).toBe("7K3M-9H2P-WJ3K9M");
    expect(pastedPairCode("  7k3m 9h2p wj3k9m\n")).toBe("7K3M-9H2P-WJ3K9M");
    expect(pastedPairCode("7k3m9h2pwj3k9m")).toBe("7K3M-9H2P-WJ3K9M");
  });

  test("a selected terminal line gives up its one code", () => {
    expect(pastedPairCode("Can't scan? Type this pairing code:  7K3M-9H2P-WJ3K9M\n")).toBe("7K3M-9H2P-WJ3K9M");
    expect(pastedPairCode("Can't scan? Type this pairing code:  7K3M-9H2P-WJ3K9M\nOne use · expires in 120 seconds")).toBe("7K3M-9H2P-WJ3K9M");
  });

  test("text without exactly one whole code is left to the field", () => {
    expect(pastedPairCode("")).toBeNull();
    expect(pastedPairCode("7K3M-9H2P")).toBeNull();
    expect(pastedPairCode("hello world")).toBeNull();
    expect(pastedPairCode("7K3M-9H2P-WJ3K9M 1A2B-3C4D-5E6F7G")).toBeNull();
    expect(pastedPairCode("https://pairfob.com/pair#v=2&c=7K3M9H2P")).toBeNull();
  });
});

describe("a typed code that is turned away", () => {
  test("too few, too many and the wrong shape each get their own words, in both languages", () => {
    setLang("zh");
    expect(pairCodeProblem("ABCD")).toBe("配对码还没输完整：需要 14 位，现在识别到 4 位。");
    // Typed past the end in the middle of the field: more than a code has is not "incomplete".
    expect(pairCodeProblem("ABCD-EFGH-JKMNPQ-RSTV")).toBe("配对码太长了：应该是 14 位，现在识别到 18 位。");
    expect(pairCodeProblem("ABCDEFGHJKMNPQRSTVWX")).toBe("配对码太长了：应该是 14 位，现在识别到 20 位。");
    // Only code characters are counted: three dots do not make seventeen characters twenty,
    // and two marks do not make twelve fourteen.
    expect(pairCodeProblem("ABCD.2345.ABCD.23456")).toBe("配对码太长了：应该是 14 位，现在识别到 17 位。");
    expect(pairCodeProblem("ABCD-EFGH-JKMN!?")).toBe("配对码还没输完整：需要 14 位，现在识别到 12 位。");
    // Fourteen characters that are not a code are neither short nor long.
    expect(pairCodeProblem("ABCD.EFGH.JKMNPQ")).toBe("配对码格式不对。请按电脑上显示的完整码输入。");
    expect(pairCodeProblem("")).toBe("请完整输入电脑上显示的配对码。");
    expect(pairCodeProblem(" - ")).toBe("请完整输入电脑上显示的配对码。");
    setLang("en");
    expect(pairCodeProblem("ABCD")).toBe("The pairing code is not complete: 14 characters needed, 4 recognized.");
    expect(pairCodeProblem("ABCDEFGHJKMNPQRSTVWX")).toBe("The pairing code is too long: it should have 14 characters, 20 recognized.");
    for (const code of ["ABCD", "ABCDEFGHJKMNPQRSTVWX", "ABCD.EFGH.JKMNPQ", ""]) expect(pairCodeProblem(code)).not.toContain("glyph");
    setLang("zh");
  });
});
