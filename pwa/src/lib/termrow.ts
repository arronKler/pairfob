/** Pure helpers for acting on a single rendered terminal row. */

const LEAD = /^[\s"'`([{<|│┃║▌▐•·*-]+/u;
const TRAIL = /[\s"'`>,.;:|│┃║▌▐]+$/u;
const OPENER: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
const URLY = /(https?:\/\/[^\s"'`)\]}<>|│┃║]+)/u;
const PATHY = /(?:^|[\s"'`([{<|])((?:~|\.{1,2})?\/?[\w.@+-]+(?:\/[\w.@+-]+)+(?::\d+(?::\d+)?)?)/u;
const FILEY = /(?:^|[\s"'`([{<|])([\w.@+-]+\.[A-Za-z][\w]{0,9}(?::\d+(?::\d+)?)?)/u;

function count(text: string, char: string): number {
  let n = 0;
  for (const c of text) if (c === char) n += 1;
  return n;
}

/**
 * Row text with box gutters and decoration trimmed off both ends. A closing
 * bracket is only decoration when the leading trim ate its opener, so
 * `Read README.md (18 lines)` keeps the paren the author typed.
 */
export function rowText(raw: string): string {
  let text = raw.replace(LEAD, "").replace(TRAIL, "");
  for (;;) {
    const last = text.at(-1) ?? "";
    const opener = OPENER[last];
    if (!opener || count(text, opener) >= count(text, last)) break;
    text = text.slice(0, -1).replace(TRAIL, "");
  }
  return text;
}

/**
 * The one token on the row worth putting on the clipboard: a URL, then a path
 * with separators, then a bare `name.ext`. Line/column suffixes are kept so the
 * result can be pasted straight back into an editor or a prompt.
 */
export function rowPath(raw: string): string | null {
  const text = rowText(raw);
  if (!text) return null;
  const hit = URLY.exec(text) || PATHY.exec(text) || FILEY.exec(text);
  const value = (hit?.[1] ?? "").replace(/[.,;:]+$/u, "");
  return value.length >= 3 ? value : null;
}
