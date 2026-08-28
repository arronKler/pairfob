import { parseAnsi, type StyledLine } from "../../lib/ansi";
import { buildPromptBlocks, type Block } from "../../lib/prompt";
import { selectedAgent, state } from "../../state";

export type PaneModel = {
  lines: StyledLine[];
  texts: string[];
  block: Block;
  /** Row index -> option index, for rows that can be answered by tapping. */
  options: Map<number, number>;
};

let cachedText: string | null = null;
let cached: PaneModel | null = null;

/**
 * Parsing and prompt detection run on every repaint and on every 1.5s pane
 * read, so memoise on the exact buffer we were handed.
 */
export function paneModel(): PaneModel {
  if (cached && cachedText === state.paneText) return cached;
  const lines = parseAnsi(state.paneText);
  const texts = lines.map((line) => line.text);
  const block = buildPromptBlocks(texts)[0] || { kind: "raw", lines: texts };
  const options = new Map<number, number>();
  if (block.kind === "prompt-select") block.options.forEach((option, index) => options.set(option.line, index));
  cached = { lines, texts, block, options };
  cachedText = state.paneText;
  return cached;
}

export function paneReadLines(): number {
  const rows = selectedAgent()?.viewportRows;
  if (rows && rows >= 8 && rows <= 200) return rows;
  return 80;
}
