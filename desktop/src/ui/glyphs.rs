//! Shaped cell symbols, reused across frames. The key is the shaping style and
//! the symbol; color is applied when painting, so a truecolor stream does not
//! reshape every cell every frame.

use std::collections::HashMap;

use gpui::{Font, FontStyle, ShapedLine};
use smol_str::SmolStr;

use crate::model::Modifier;

const CACHE_LIMIT: usize = 4096;
const STYLES: usize = 4;

pub struct GlyphCache {
    lines: Vec<ShapedLine>,
    /// `ascii[style * 128 + byte]`.
    ascii: Vec<Option<u32>>,
    other: [HashMap<SmolStr, u32>; STYLES],
}

impl Default for GlyphCache {
    fn default() -> Self {
        Self {
            lines: Vec::new(),
            ascii: vec![None; STYLES * 128],
            other: Default::default(),
        }
    }
}

/// The modifier bits that change shaping, as a small index.
pub fn style_of(modifier: Modifier) -> usize {
    usize::from(modifier.contains(Modifier::BOLD))
        | usize::from(modifier.contains(Modifier::ITALIC)) << 1
}

/// The face a cached style shapes in. Bold steps a little heavier than the
/// configured weight rather than jumping to the face's heaviest.
pub fn styled_font(base: &Font, style: usize) -> Font {
    let mut font = base.clone();
    if style & 1 != 0 {
        font.weight = gpui::FontWeight::BOLD;
    }
    if style & 2 != 0 {
        font.style = FontStyle::Italic;
    }
    font
}

fn ascii_index(style: usize, symbol: &str) -> Option<usize> {
    match symbol.as_bytes() {
        [byte] if byte.is_ascii() => Some(style * 128 + usize::from(*byte)),
        _ => None,
    }
}

impl GlyphCache {
    /// Shapes are tied to a font size, so a text-size change starts over.
    pub fn clear(&mut self) {
        *self = Self::default();
    }

    pub fn get(&self, style: usize, symbol: &str) -> Option<ShapedLine> {
        let id = match ascii_index(style, symbol) {
            Some(index) => self.ascii[index]?,
            None => *self.other[style].get(symbol)?,
        };
        self.lines.get(usize::try_from(id).ok()?).cloned()
    }

    /// Returns the shaped line either way. Past the limit the line is handed
    /// back without being kept, so a pathological frame cannot grow the cache
    /// without bound.
    pub fn insert(&mut self, style: usize, symbol: &str, line: ShapedLine) -> ShapedLine {
        if self.lines.len() >= CACHE_LIMIT {
            return line;
        }
        let id = u32::try_from(self.lines.len()).unwrap_or(u32::MAX);
        match ascii_index(style, symbol) {
            Some(index) => self.ascii[index] = Some(id),
            None => {
                self.other[style].insert(SmolStr::new(symbol), id);
            }
        }
        self.lines.push(line.clone());
        line
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.lines.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_bold_and_italic_change_the_shaping_key() {
        assert_eq!(style_of(Modifier::default()), 0);
        assert_eq!(style_of(Modifier::BOLD), 1);
        assert_eq!(style_of(Modifier::ITALIC), 2);
        assert_eq!(style_of(Modifier(Modifier::BOLD.0 | Modifier::ITALIC.0)), 3);
        assert_eq!(style_of(Modifier::UNDERLINE), 0);
    }

    #[test]
    fn the_shaping_font_follows_the_style_bits() {
        let base = gpui::font("Menlo");
        assert_eq!(styled_font(&base, 0).weight, base.weight);
        assert_ne!(styled_font(&base, 1).weight, base.weight);
        assert_eq!(styled_font(&base, 2).style, FontStyle::Italic);
        assert_eq!(styled_font(&base, 3).style, FontStyle::Italic);
    }

    #[test]
    fn an_empty_cache_reports_every_symbol_missing() {
        let cache = GlyphCache::default();
        assert_eq!(cache.len(), 0);
        assert!(cache.get(0, "a").is_none());
        assert!(cache.get(3, "\u{4e16}").is_none());
    }
}
