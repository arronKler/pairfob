import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestDOM } from "../../../../test-support/boot-dom";

await resetTestDOM();
const { CHAT_SIZES, autoChatSize, beforeChatReadingChange, canStepChatSize, chatFontSize, drawnChatSize, resetChatFontSize,
  setChatFontSize, stepChatSize } = await import("./chat-reading");

const SIZE_KEY = "pairfob.chat.fontSize";

describe("chat reading size", () => {
  beforeEach(() => { resetChatFontSize(); localStorage.removeItem(SIZE_KEY); });
  afterEach(() => { resetChatFontSize(); });

  test("a mine reads smaller than a finger's until the reader picks", () => {
    expect(autoChatSize(true)).toBe(14);
    expect(autoChatSize(false)).toBe(16);
    expect(drawnChatSize(null, true)).toBe(14);
    expect(drawnChatSize(null, false)).toBe(16);
    expect(drawnChatSize(18.5, false)).toBe(18.5);
  });

  test("a chosen size is kept on the device, and only the steps are accepted", () => {
    setChatFontSize(99);
    expect(chatFontSize()).toBeNull();
    expect(CHAT_SIZES).toEqual([12.5, 14, 15.5, 17, 18.5, 20, 22]);
    setChatFontSize(17);
    expect(chatFontSize()).toBe(17);
    expect(localStorage.getItem(SIZE_KEY)).toBe("17");
    resetChatFontSize();
    expect(chatFontSize()).toBeNull();
    expect(localStorage.getItem(SIZE_KEY)).toBeNull();
  });

  test("steps walk the sizes with the automatic one among them, and stepping back onto it gives the choice back", () => {
    const walked: Array<number | null> = [];
    while (stepChatSize(1, 16)) walked.push(chatFontSize());
    expect(walked).toEqual([17, 18.5, 20, 22]);
    expect(canStepChatSize(1, 16)).toBe(false);
    for (const size of [20, 18.5, 17]) {
      expect(stepChatSize(-1, 16)).toBe(true);
      expect(chatFontSize()).toBe(size);
    }
    expect(stepChatSize(-1, 16)).toBe(true);
    expect(chatFontSize()).toBeNull();
    expect(localStorage.getItem(SIZE_KEY)).toBeNull();
    expect(stepChatSize(-1, 16)).toBe(true);
    expect(chatFontSize()).toBe(15.5);
  });

  test("hear about a change before the transcript is redrawn", () => {
    const order: string[] = [];
    const stop = beforeChatReadingChange(() => order.push(`before:${chatFontSize()}`));
    setChatFontSize(18.5);
    order.push(`after:${chatFontSize()}`);
    stop();
    setChatFontSize(20);
    expect(order).toEqual(["before:null", "after:18.5"]);
  });
});
