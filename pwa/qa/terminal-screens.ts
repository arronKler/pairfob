import { PANE_TEXT } from "./data";

/**
 * Screens the fixture computer draws in the complete terminal.
 *
 * Each is a function of the grid it was asked for, like a full-screen program
 * redrawing after a resize: the fixture session sends it when the terminal
 * opens and again whenever the page asks for another size. Rows are placed by
 * cursor address and never end in a newline, so a row that fills the grid does
 * not wrap or scroll.
 */

const ESC = "\u001b";
const CLEAR = `${ESC}[2J${ESC}[H`;

function at(row: number, text: string): string {
  return `${ESC}[${row};1H${text}`;
}

/** The guided scenes' pane, as the same pane's complete terminal shows it. */
export function paneScreen(_cols: number, rows: number): string {
  const lines = PANE_TEXT.split("\n").slice(0, rows);
  return CLEAR + lines.map((line, index) => at(index + 1, line)).join("");
}

const BUILD_LOG = [
  "vite v6 building for production: transforming modules and rendering chunks for the workbench shell",
  "dist/assets/inspector-detail-3f2a91.js    12.41 kB | gzip  4.12 kB | map  38.02 kB | src/features/workspace/inspector-detail.tsx",
  "dist/assets/command-palette-77c0de.js      6.08 kB | gzip  2.31 kB | map  17.44 kB | src/features/command-palette/palette.tsx",
  "dist/assets/full-terminal-pan-bar-1b0e.js  1.92 kB | gzip  0.94 kB | map   6.10 kB | src/features/session/full-terminal/full-terminal-pan-bar.ts",
  "warning: src/features/session/full-terminal/full-terminal-fit.ts(212,7) the fitted grid is wider than the visible column; pan to read the rest",
  "PASS src/features/workspace/inspector.test.tsx > the terminal keeps its columns while the inspector covers part of the session column",
];

/**
 * Rows that use the whole grid: a column ruler, then log lines padded to the
 * last column, each ending in the number of that column. In a terminal wider
 * than the column it is shown in, the ruler says which columns are in view and
 * a row's end is on screen only once it has been panned to. ASCII only, so
 * every character is one cell.
 */
export function wideScreen(cols: number, rows: number): string {
  // Each ten is written so that its last digit sits in the column it names.
  const tens = Array.from({ length: cols }, (_unused, index) => {
    const ten = Math.ceil((index + 1) / 10) * 10;
    const label = String(ten);
    const offset = index + 1 - (ten - label.length + 1);
    return offset >= 0 && ten <= cols ? label[offset] : " ";
  }).join("");
  const units = Array.from({ length: cols }, (_unused, index) => String((index + 1) % 10)).join("");
  const end = ` ${cols}|`;
  const body = Math.max(0, rows - 3);
  const out = [at(1, `${ESC}[2m${tens}${ESC}[0m`), at(2, `${ESC}[2m${units}${ESC}[0m`)];
  for (let index = 0; index < body; index++) {
    const stamp = `[04:00:${String(index % 60).padStart(2, "0")}] `;
    const text = (stamp + BUILD_LOG[index % BUILD_LOG.length]).slice(0, Math.max(0, cols - end.length - 1));
    const fill = ".".repeat(Math.max(0, cols - text.length - end.length - 1));
    const tone = text.includes("warning") ? `${ESC}[33m` : text.includes("PASS") ? `${ESC}[32m` : "";
    out.push(at(index + 3, `${tone}${text}${ESC}[0m ${ESC}[2m${fill}${ESC}[0m${end}`));
  }
  out.push(at(rows, "$ "));
  return CLEAR + out.join("");
}
