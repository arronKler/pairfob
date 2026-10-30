# Captured frames

`frame.json` is one real surface frame from Herdr 0.9.5, captured on
2026-10-28 from a throwaway session (`herdr --session pffixture server`) whose
panes ran a purpose-built script, so the file contains no personal terminal
content.

- 120x40 cells, one horizontal split at column 54, two panes (`w2:p1` focused,
  `w2:p2`), cursor at (1, 11) in `w2:p1`.
- Cells are `[symbol, fg, bg, modifier, skip, hyperlink]` in row-major order,
  with the raw color words and modifier bits the daemon sends.
- The script printed ASCII, CJK, fullwidth Latin, a ZWJ emoji, box drawing,
  256-palette and truecolor text, and bold, dim, italic, underline and
  strikethrough runs.

The paint tests read this file rather than hand-built frames, so a change in the
color decode, the wide-glyph rule, or the modifier bits fails against real
daemon output.
