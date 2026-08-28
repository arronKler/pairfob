import { describe, expect, test } from "bun:test";
import { buildPromptBlocks, liftAskLabel, liftTap } from "./prompt";
import { parseAnsi } from "./ansi";

function rows(text: string): string[] {
  return parseAnsi(text).map((line) => line.text);
}

const yesNo = ["May I edit README.md?", "❯ 1. Yes", "  2. No"].join("\n");

const claudeBox = [
  "╭──────────────────────────────────────────────────╮",
  "│ Edit file                                        │",
  "│                                                  │",
  "│ Do you want to make this edit to config.ts?      │",
  "│ ❯ 1. Yes                                         │",
  "│   2. Yes, allow all edits this session           │",
  "│   3. No, and tell Claude what to do differently  │",
  "╰──────────────────────────────────────────────────╯",
  "",
  "  esc to interrupt · ? for shortcuts",
].join("\n");

const codexBar = ["▌ Allow Codex to run `npm test`?", "▌ 1. Yes", "▌ 2. No, tell Codex what to do", "", "  ↑↓ select · enter confirm"].join(
  "\n",
);

const foreign = ["some stack trace", "at foo:1", "not a menu"].join("\n");

const answered = ["❯ 1. Yes", "  2. No", "", "Applied the edit to config.ts.", "Running the test suite now."].join("\n");

const prose = ["Here is the plan:", "1. Read the config", "2. Patch the handler"].join("\n");

const nonConsecutive = ["Pick one:", "❯ 2. Yes", "  3. No"].join("\n");

describe("prompt lift", () => {
  test("lifts a bare numbered menu at the tail", () => {
    const blocks = buildPromptBlocks(rows(yesNo));
    expect(blocks[0].kind).toBe("prompt-select");
    if (blocks[0].kind !== "prompt-select") return;
    expect(blocks[0].options).toHaveLength(2);
    expect(blocks[0].keys[0]).toEqual(["1", "enter"]);
    expect(blocks[0].question).toBe("May I edit README.md?");
  });

  test("lifts a box-drawn dialog with a trailing key hint", () => {
    const blocks = buildPromptBlocks(rows(claudeBox));
    expect(blocks[0].kind).toBe("prompt-select");
    if (blocks[0].kind !== "prompt-select") return;
    expect(blocks[0].options.map((option) => option.label)).toEqual([
      "Yes",
      "Yes, allow all edits this session",
      "No, and tell Claude what to do differently",
    ]);
    expect(blocks[0].question).toBe("Do you want to make this edit to config.ts?");
  });

  test("lifts a gutter-bar dialog", () => {
    const blocks = buildPromptBlocks(rows(codexBar));
    expect(blocks[0].kind).toBe("prompt-select");
    if (blocks[0].kind !== "prompt-select") return;
    expect(blocks[0].options).toHaveLength(2);
  });

  test("every guard is a literal substring of its rendered row", () => {
    for (const screen of [yesNo, claudeBox, codexBar]) {
      const lines = rows(screen);
      const block = buildPromptBlocks(lines)[0];
      expect(block.kind).toBe("prompt-select");
      if (block.kind !== "prompt-select") continue;
      for (const option of block.options) {
        expect(lines[option.line]).toContain(option.guard);
        expect(screen).toContain(option.guard);
      }
    }
  });

  test("guard drops the caret so a moved selection still matches", () => {
    const block = buildPromptBlocks(rows(claudeBox))[0];
    expect(block.kind).toBe("prompt-select");
    if (block.kind !== "prompt-select") return;
    expect(block.options[0].guard).toBe("1. Yes");
    expect(liftTap(block, 0)).toEqual({ keys: ["1", "enter"], expectedPrompt: "1. Yes" });
  });

  test("foreign output stays raw", () => {
    expect(buildPromptBlocks(rows(foreign))[0].kind).toBe("raw");
  });

  test("an answered menu followed by fresh output stays raw", () => {
    expect(buildPromptBlocks(rows(answered))[0].kind).toBe("raw");
  });

  test("a numbered list inside prose stays raw", () => {
    expect(buildPromptBlocks(rows(prose))[0].kind).toBe("raw");
  });

  test("options that do not start at 1 stay raw", () => {
    expect(buildPromptBlocks(rows(nonConsecutive))[0].kind).toBe("raw");
  });

  test("liftTap is null on raw and out of range", () => {
    expect(liftTap({ kind: "raw", lines: ["x"] }, 0)).toBeNull();
    const block = buildPromptBlocks(rows(yesNo))[0];
    expect(liftTap(block, 9)).toBeNull();
    expect(liftTap(block, -1)).toBeNull();
  });

  test("ask label uses the live agent name", () => {
    expect(liftAskLabel("codex")).toBe("codex 在问");
    expect(liftAskLabel(" Claude ")).toBe("Claude 在问");
    expect(liftAskLabel("")).toBe("Agent 在问");
    expect(liftAskLabel()).toBe("Agent 在问");
  });
});
