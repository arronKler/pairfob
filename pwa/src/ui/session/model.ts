import { parseAnsi, type StyledLine } from "../../lib/ansi";
import { selectedAgent, state } from "../../state";

export type PaneModel = {
  lines: StyledLine[];
  texts: string[];
};

let cachedText: string | null = null;
let cached: PaneModel | null = null;

/**
 * ANSI parsing runs on every repaint and on every 1.5s pane read, so memoise
 * on the exact buffer we were handed.
 */
export function paneModel(): PaneModel {
  if (cached && cachedText === state.paneText) return cached;
  const lines = parseAnsi(state.paneText);
  const texts = lines.map((line) => line.text);
  cached = { lines, texts };
  cachedText = state.paneText;
  return cached;
}

export function paneReadLines(): number {
  const rows = selectedAgent()?.viewportRows;
  if (rows && rows >= 8 && rows <= 200) return rows;
  return 80;
}
