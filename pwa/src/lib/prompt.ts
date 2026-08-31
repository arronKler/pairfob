import { t } from "./i18n.ts";

export type PromptOption = {
  /** Digit the runtime expects for this row. */
  n: string;
  label: string;
  /** Index of the rendered row this option came from. */
  line: number;
  /**
   * Exact slice of the rendered row. SendKeys.expected_prompt is compared by the
   * daemon with strings.Contains against a fresh text read, so the guard must be
   * a literal substring of one row — never reflowed or gutter-stripped text.
   */
  guard: string;
};

export type Block =
  | { kind: "raw"; lines: string[] }
  | { kind: "prompt-select"; question: string; options: PromptOption[]; keys: string[][] };

const GUTTER = "\\s\u2502\u2503\u2551\u258c\u258d\u258e\u258f\u2590\u2506\u250a\u254e\u254f";
const LEAD = new RegExp(`^[${GUTTER}]*`, "u");
const TRAIL = new RegExp(`[${GUTTER}]*$`, "u");
const BORDER = /^[\s\u2500-\u257f\u2580-\u259f•·=~_-]*$/u;
const OPTION = /^(?<lead>(?:[❯>›▸▶→◆◇*•]\s+)?)(?<n>\d)(?<sep>[.)])(?<gap>[ \t]+)(?<label>\S.*)$/u;
const HINT_WORD =
  /(?:^|[^\p{L}])(?:esc|escape|enter|return|tab|ctrl|shift|space|arrows?|shortcuts?|select|confirm|cancel|interrupt|toggle|cycle)(?:[^\p{L}]|$)/iu;
const HINT_GLYPH = /[↑↓←→⏎⏵⇧⌥⌘]/u;
const ASKS = /[?？]$/u;

const MAX_OPTIONS = 9;
const MAX_HINT_LINES = 4;
const MAX_QUESTION_LINES = 8;
const MAX_HINT_WIDTH = 120;

/** Row content with box gutters removed from both edges. */
function body(raw: string): string {
  return raw.replace(LEAD, "").replace(TRAIL, "");
}

function isBorder(text: string): boolean {
  return text === "" || BORDER.test(text);
}

function isHint(text: string): boolean {
  return text.length <= MAX_HINT_WIDTH && (HINT_WORD.test(text) || HINT_GLYPH.test(text));
}

/**
 * Fail-closed: only lift a numbered menu that is still the live question.
 * Agents box their dialogs and print a key hint underneath, so the anchor is
 * "nothing but border and key hints below the options" rather than "options are
 * the literal last row". Ordinary agent output below an answered menu is prose
 * or code, which matches neither, so a stale menu still stays raw.
 */
export function buildPromptBlocks(lines: string[]): Block[] {
  const raws = lines.map((line) => line.replace(/\s+$/, ""));
  const rawBlock: Block[] = [{ kind: "raw", lines: raws }];
  const bodies = raws.map(body);

  let cursor = bodies.length - 1;
  let hints = 0;
  while (cursor >= 0) {
    const text = bodies[cursor];
    if (isBorder(text)) {
      cursor--;
      continue;
    }
    if (isHint(text) && ++hints <= MAX_HINT_LINES) {
      cursor--;
      continue;
    }
    break;
  }
  if (cursor < 0) return rawBlock;

  const options: PromptOption[] = [];
  let marked = false;
  let bridged = false;
  while (cursor >= 0) {
    const match = OPTION.exec(bodies[cursor]);
    if (match?.groups) {
      const { lead, n, label } = match.groups;
      if (lead) marked = true;
      options.unshift({ n, label: label.trim(), line: cursor, guard: bodies[cursor].slice(lead.length) });
      bridged = false;
      cursor--;
      if (options.length >= MAX_OPTIONS) break;
      continue;
    }
    if (!options.length) return rawBlock;
    if (!bridged && isBorder(bodies[cursor])) {
      bridged = true;
      cursor--;
      continue;
    }
    break;
  }

  if (options.length < 2) return rawBlock;
  if (options.some((option, index) => option.n !== String(index + 1))) return rawBlock;

  const questionLines: string[] = [];
  for (let index = cursor; index >= 0 && questionLines.length < MAX_QUESTION_LINES; index--) {
    const text = bodies[index];
    if (OPTION.test(text)) break;
    if (isBorder(text)) {
      if (questionLines.length) break;
      continue;
    }
    questionLines.unshift(text);
  }
  const question = questionLines.join("\n").trim();

  // A bare numbered list inside agent prose is not a menu. Require either a
  // selection caret or a question mark before offering one-tap.
  if (!marked && !ASKS.test(question)) return rawBlock;

  return [
    {
      kind: "prompt-select",
      question,
      options,
      keys: options.map((option) => [option.n, "enter"]),
    },
  ];
}

/** Keys + expected_prompt for a lifted option tap (fail-closed if not prompt-select). */
export function liftTap(block: Block, index: number): { keys: string[]; expectedPrompt: string } | null {
  if (block.kind !== "prompt-select") return null;
  if (index < 0 || index >= block.keys.length) return null;
  return { keys: block.keys[index], expectedPrompt: block.options[index].guard };
}

export function liftAskLabel(agent?: string): string {
  const name = agent?.trim();
  return name ? t("ask.named", { name }) : t("ask.agent");
}
