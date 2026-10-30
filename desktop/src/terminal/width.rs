//! How many columns a cell's symbol covers.

use unicode_width::UnicodeWidthStr;

/// The daemon marks most wide glyph continuation cells only by leaving a plain
/// space behind, so the width has to come from Unicode. A halfwidth katakana
/// with a voiced-sound mark counts as two columns, matching the host renderer.
pub fn columns(symbol: &str) -> u16 {
    // The host renderer accepts this pair as one composed glyph even though
    // the mark alone would measure separately.
    let mut chars = symbol.chars();
    if matches!(
        (chars.next(), chars.next(), chars.next()),
        (
            Some('\u{ff66}'..='\u{ff9d}'),
            Some('\u{ff9e}' | '\u{ff9f}'),
            None
        )
    ) {
        return 2;
    }
    // Zero-width symbols (a lone combining mark, an empty cell) still sit in
    // one column; nothing spans more than two.
    symbol.width().clamp(1, 2) as u16
}
