//! Herdr's cell color word, decoded.

use crate::model::Color;

/// `0x00_00_00XX` is a named color (1-based), `0x01_00_00XX` a 256-palette
/// index, `0x02_RRGGBB` a direct color, and everything else the default.
pub fn from_wire(raw: u32) -> Color {
    match raw >> 24 {
        0 => match raw & 0xFF {
            1..=16 => Color::Named((raw & 0xFF) as u8),
            _ => Color::Default,
        },
        1 => Color::Palette((raw & 0xFF) as u8),
        2 => Color::Rgb(
            ((raw >> 16) & 0xFF) as u8,
            ((raw >> 8) & 0xFF) as u8,
            (raw & 0xFF) as u8,
        ),
        _ => Color::Default,
    }
}
