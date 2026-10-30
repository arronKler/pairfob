//! Colors the program asked for, resolved against the desktop's own palette.

use crate::model::Color;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Rgb(pub u32);

impl Rgb {
    pub const fn new(r: u8, g: u8, b: u8) -> Self {
        Self(((r as u32) << 16) | ((g as u32) << 8) | b as u32)
    }

    pub fn channels(self) -> (u8, u8, u8) {
        (
            ((self.0 >> 16) & 0xFF) as u8,
            ((self.0 >> 8) & 0xFF) as u8,
            (self.0 & 0xFF) as u8,
        )
    }

    /// Channel values in 0..=1, the form GPUI's `Rgba` takes.
    pub fn components(self) -> (f32, f32, f32) {
        let (r, g, b) = self.channels();
        (
            f32::from(r) / 255.,
            f32::from(g) / 255.,
            f32::from(b) / 255.,
        )
    }

    /// Contrasting ink for a block cursor sitting on this color.
    pub fn contrasting(self) -> Self {
        let (r, g, b) = self.channels();
        let luma = 0.2126 * f32::from(r) + 0.7152 * f32::from(g) + 0.0722 * f32::from(b);
        if luma > 140. {
            Self::new(0, 0, 0)
        } else {
            Self::new(255, 255, 255)
        }
    }

    /// A tint of `self` over `base`, for fills that would otherwise need alpha
    /// compositing the canvas cannot do.
    pub fn blend(self, base: Self, percent: u8) -> Self {
        let percent = u16::from(percent.min(100));
        let (r1, g1, b1) = self.channels();
        let (r2, g2, b2) = base.channels();
        let mix = |a: u8, b: u8| {
            (((u16::from(a) * percent) + (u16::from(b) * (100 - percent))) / 100) as u8
        };
        Self::new(mix(r1, r2), mix(g1, g2), mix(b1, b2))
    }
}

const ANSI: [u32; 16] = [
    0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080, 0xc0c0c0, 0x808080,
    0xff0000, 0x00ff00, 0xffff00, 0x0000ff, 0xff00ff, 0x00ffff, 0xffffff,
];

const fn cube_level(value: u8) -> u8 {
    if value == 0 {
        0
    } else {
        55 + value * 40
    }
}

/// The xterm 256-color table. The daemon sends palette indices, so this table
/// has to match the one programs assume, not a designed palette.
pub const fn xterm_palette() -> [Rgb; 256] {
    let mut palette = [Rgb(0); 256];
    let mut i = 0;
    while i < 16 {
        palette[i] = Rgb(ANSI[i]);
        i += 1;
    }
    let mut i = 16;
    while i < 232 {
        let index = (i - 16) as u8;
        palette[i] = Rgb::new(
            cube_level(index / 36),
            cube_level((index / 6) % 6),
            cube_level(index % 6),
        );
        i += 1;
    }
    let mut i = 232;
    while i < 256 {
        let value = 8 + (i as u16 - 232) * 10;
        palette[i] = Rgb::new(value as u8, value as u8, value as u8);
        i += 1;
    }
    palette
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Theme {
    pub background: Rgb,
    pub foreground: Rgb,
    pub cursor: Rgb,
    /// The window's own chrome, so the terminal and the frame around it read
    /// as one surface.
    pub surface: Rgb,
    pub border: Rgb,
    pub muted: Rgb,
    pub accent: Rgb,
    /// The wash behind a text selection.
    pub selection: Rgb,
    pub palette: [Rgb; 256],
}

impl Default for Theme {
    fn default() -> Self {
        Self::dark()
    }
}

impl Theme {
    /// The ANSI sixteen for a light terminal. Indices 16 and up keep the
    /// xterm cube: programs index that table by number, so changing it would
    /// repaint their output in colors they did not ask for.
    const LIGHT_ANSI: [Rgb; 16] = [
        Rgb::new(0x00, 0x00, 0x00),
        Rgb::new(0xc2, 0x36, 0x21),
        Rgb::new(0x25, 0xbc, 0x24),
        Rgb::new(0xad, 0xad, 0x27),
        Rgb::new(0x49, 0x2e, 0xe1),
        Rgb::new(0xd3, 0x38, 0xd3),
        Rgb::new(0x33, 0xbb, 0xc8),
        Rgb::new(0xcb, 0xcc, 0xcd),
        Rgb::new(0x81, 0x83, 0x83),
        Rgb::new(0xfc, 0x39, 0x1f),
        Rgb::new(0x31, 0xe7, 0x22),
        Rgb::new(0xea, 0xec, 0x23),
        Rgb::new(0x58, 0x33, 0xff),
        Rgb::new(0xf9, 0x35, 0xf8),
        Rgb::new(0x14, 0xf0, 0xf0),
        Rgb::new(0xe9, 0xeb, 0xeb),
    ];

    pub fn light() -> Self {
        let mut palette = xterm_palette();
        palette[..16].copy_from_slice(&Self::LIGHT_ANSI);
        Self {
            background: Rgb::new(0xff, 0xff, 0xff),
            foreground: Rgb::new(0x1d, 0x1d, 0x1f),
            cursor: Rgb::new(0x0a, 0x6f, 0xd8),
            surface: Rgb::new(0xf2, 0xf2, 0xf4),
            border: Rgb::new(0xd6, 0xd6, 0xdb),
            muted: Rgb::new(0x86, 0x86, 0x8b),
            accent: Rgb::new(0x0a, 0x6f, 0xd8),
            selection: Rgb::new(0xcb, 0xe0, 0xfa),
            palette,
        }
    }

    pub fn dark() -> Self {
        Self {
            background: Rgb::new(0x0d, 0x0f, 0x12),
            foreground: Rgb::new(0xe6, 0xea, 0xf0),
            cursor: Rgb::new(0x6f, 0xa8, 0xff),
            surface: Rgb::new(0x19, 0x1c, 0x21),
            border: Rgb::new(0x23, 0x27, 0x2e),
            muted: Rgb::new(0x6c, 0x73, 0x7d),
            accent: Rgb::new(0x0a, 0x84, 0xff),
            selection: Rgb::new(0x1f, 0x44, 0x74),
            palette: xterm_palette(),
        }
    }

    /// Resolve a cell color. `background` picks the theme's default for
    /// [`Color::Default`]; the encoding does not say which side it means.
    pub fn resolve(&self, color: Color, background: bool) -> Rgb {
        match color {
            Color::Default => {
                if background {
                    self.background
                } else {
                    self.foreground
                }
            }
            // Named colors arrive 1-based over the sixteen ANSI slots (1 is
            // black, 9 is bright black); anything else is the theme default.
            Color::Named(index) if (1..=16).contains(&index) => {
                self.palette[usize::from(index - 1)]
            }
            Color::Named(_) => {
                if background {
                    self.background
                } else {
                    self.foreground
                }
            }
            Color::Palette(index) => self.palette[usize::from(index)],
            Color::Rgb(r, g, b) => Rgb::new(r, g, b),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_light_theme_replaces_only_the_ansi_sixteen() {
        let light = Theme::light();
        assert_eq!(light.palette[0], Theme::LIGHT_ANSI[0]);
        assert_eq!(light.palette[15], Theme::LIGHT_ANSI[15]);
        assert_eq!(light.palette[196], Theme::dark().palette[196]);
        assert_eq!(light.palette[244], Theme::dark().palette[244]);
        assert_eq!(light.resolve(Color::Named(1), false), Theme::LIGHT_ANSI[0]);
    }

    #[test]
    fn the_palette_matches_the_xterm_cube_and_greys() {
        let palette = xterm_palette();
        assert_eq!(palette[0], Rgb::new(0, 0, 0));
        assert_eq!(palette[1], Rgb::new(0x80, 0, 0));
        assert_eq!(palette[9], Rgb::new(0xff, 0, 0));
        assert_eq!(palette[15], Rgb::new(0xff, 0xff, 0xff));
        assert_eq!(palette[16], Rgb::new(0, 0, 0));
        assert_eq!(palette[196], Rgb::new(255, 0, 0));
        assert_eq!(palette[46], Rgb::new(0, 255, 0));
        assert_eq!(palette[244], Rgb::new(128, 128, 128));
        assert_eq!(palette[255], Rgb::new(238, 238, 238));
    }

    #[test]
    fn named_colors_are_one_based_and_fall_back_to_the_default() {
        let theme = Theme::dark();
        assert_eq!(theme.resolve(Color::Named(1), false), Rgb::new(0, 0, 0));
        assert_eq!(theme.resolve(Color::Named(2), false), Rgb::new(0x80, 0, 0));
        assert_eq!(
            theme.resolve(Color::Named(9), false),
            Rgb::new(0x80, 0x80, 0x80)
        );
        assert_eq!(theme.resolve(Color::Named(10), false), Rgb::new(0xff, 0, 0));
        assert_eq!(
            theme.resolve(Color::Named(16), false),
            Rgb::new(0xff, 0xff, 0xff)
        );
        assert_eq!(theme.resolve(Color::Named(0), false), theme.foreground);
        assert_eq!(theme.resolve(Color::Named(17), true), theme.background);
    }

    #[test]
    fn defaults_pick_the_side_the_caller_asks_for() {
        let theme = Theme::dark();
        assert_eq!(theme.resolve(Color::Default, false), theme.foreground);
        assert_eq!(theme.resolve(Color::Default, true), theme.background);
        assert_eq!(
            theme.resolve(Color::Rgb(0x12, 0x34, 0x56), true),
            Rgb::new(0x12, 0x34, 0x56)
        );
    }

    #[test]
    fn rgb_round_trips_and_picks_readable_cursor_ink() {
        let value = Rgb::new(0x12, 0x34, 0x56);
        assert_eq!(value.0, 0x123456);
        assert_eq!(value.channels(), (0x12, 0x34, 0x56));
        assert_eq!(Rgb::new(0, 0, 0).contrasting(), Rgb::new(255, 255, 255));
        assert_eq!(Rgb::new(255, 255, 255).contrasting(), Rgb::new(0, 0, 0));
    }
}
