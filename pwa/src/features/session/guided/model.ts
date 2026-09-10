import { parseAnsi, type StyledLine } from "../../../lib/ansi";

export type PaneModel = {
  lines: StyledLine[];
  texts: string[];
};

export type PaneModelCache = { text: string; model: PaneModel };

/** Parse a pane buffer. Memoize only when the exact text is reused. */
export function paneModelFromText(text: string, previous?: PaneModelCache | null): PaneModel {
  if (previous && previous.text === text) return previous.model;
  const lines = parseAnsi(text);
  return { lines, texts: lines.map((line) => line.text) };
}

export function paneReadLinesFromViewport(rows: number | undefined): number {
  if (rows && rows >= 8 && rows <= 200) return rows;
  return 80;
}
