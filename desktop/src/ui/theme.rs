//! Chrome tokens in one place. The terminal keeps its own palette in
//! [`crate::terminal::Theme`]; this covers everything drawn around it.
//!
//! One scheme per system appearance: a graphite surface family separated by
//! hairlines, one system-blue fill for what is live or selected, and status as
//! small desaturated dots. Nothing else is colored.

use gpui::{font, Font, FontFallbacks, FontWeight, Rgba, WindowAppearance};
use serde::{Deserialize, Serialize};

use crate::app::Connection;
use crate::model::AgentStatus;
use crate::terminal::{Rgb, Theme};

#[derive(Clone)]
pub struct Chrome {
    /// Whether this is the dark scheme, which also picks the terminal palette.
    pub dark: bool,
    /// The canvas behind the content column and the sidebar material.
    pub background: Rgb,
    /// Sidebar material, one step lighter than the canvas.
    pub sidebar: Rgb,
    /// Floating surfaces: sheets, the diagnostics drawer.
    pub card: Rgb,
    /// Inset controls and the focused workspace row.
    pub raised: Rgb,
    pub hover: Rgb,
    /// Selection inside the session list.
    pub selected: Rgb,
    /// Hairline between surfaces.
    pub line: Rgb,
    /// Hairline inside one surface.
    pub line_soft: Rgb,
    pub foreground: Rgb,
    pub secondary: Rgb,
    pub muted: Rgb,
    pub accent: Rgb,
    /// Text on an accent fill.
    pub on_accent: Rgb,
    pub danger: Rgb,
    pub warning: Rgb,
    pub success: Rgb,
    /// The wash behind every other find hit: the warning hue over the surface,
    /// which keeps it apart from the blue selection in both schemes.
    pub find_match: Rgb,
    /// The wash behind the find hit the bar is on, the same hue but stronger.
    pub find_current: Rgb,
}

impl Chrome {
    pub fn dark() -> Self {
        let background = Rgb::new(0x0d, 0x0f, 0x12);
        let warning = Rgb::new(0xe8, 0xb4, 0x5a);
        Self {
            dark: true,
            background,
            sidebar: Rgb::new(0x13, 0x16, 0x1a),
            card: Rgb::new(0x19, 0x1c, 0x21),
            raised: Rgb::new(0x1e, 0x22, 0x27),
            hover: Rgb::new(0x22, 0x26, 0x2c),
            selected: Rgb::new(0x0a, 0x6f, 0xd8),
            line: Rgb::new(0x23, 0x27, 0x2e),
            line_soft: Rgb::new(0x1b, 0x1e, 0x24),
            foreground: Rgb::new(0xe8, 0xeb, 0xef),
            secondary: Rgb::new(0x9b, 0xa2, 0xac),
            muted: Rgb::new(0x6c, 0x73, 0x7d),
            accent: Rgb::new(0x0a, 0x84, 0xff),
            on_accent: Rgb::new(0xff, 0xff, 0xff),
            danger: Rgb::new(0xff, 0x6b, 0x63),
            warning,
            success: Rgb::new(0x30, 0xd1, 0x58),
            find_match: warning.blend(background, 38),
            find_current: warning.blend(background, 65),
        }
    }

    pub fn light() -> Self {
        let background = Rgb::new(0xff, 0xff, 0xff);
        let warning = Rgb::new(0xb2, 0x50, 0x00);
        Self {
            dark: false,
            background,
            sidebar: Rgb::new(0xf2, 0xf2, 0xf4),
            card: Rgb::new(0xff, 0xff, 0xff),
            raised: Rgb::new(0xe9, 0xe9, 0xec),
            hover: Rgb::new(0xe6, 0xe6, 0xea),
            selected: Rgb::new(0x0a, 0x6f, 0xd8),
            line: Rgb::new(0xd6, 0xd6, 0xdb),
            line_soft: Rgb::new(0xe9, 0xe9, 0xed),
            foreground: Rgb::new(0x1d, 0x1d, 0x1f),
            secondary: Rgb::new(0x51, 0x51, 0x54),
            muted: Rgb::new(0x86, 0x86, 0x8b),
            accent: Rgb::new(0x0a, 0x6f, 0xd8),
            on_accent: Rgb::new(0xff, 0xff, 0xff),
            danger: Rgb::new(0xd7, 0x00, 0x15),
            warning,
            success: Rgb::new(0x1d, 0x7f, 0x37),
            find_match: warning.blend(background, 28),
            find_current: warning.blend(background, 55),
        }
    }

    pub fn for_dark(dark: bool) -> Self {
        if dark {
            Self::dark()
        } else {
            Self::light()
        }
    }

    pub fn terminal(&self) -> Theme {
        if self.dark {
            Theme::dark()
        } else {
            Theme::light()
        }
    }

    /// A tint of `color` over `base`, used for chips and soft fills where GPUI
    /// would otherwise need alpha compositing the canvas cannot do.
    pub fn blend(color: Rgb, base: Rgb, percent: u8) -> Rgb {
        color.blend(base, percent)
    }

    pub fn accent_soft(&self) -> Rgb {
        Self::blend(
            self.accent,
            self.background,
            if self.dark { 18 } else { 12 },
        )
    }
}

impl Default for Chrome {
    fn default() -> Self {
        Self::dark()
    }
}

/// Which scheme the window paints. `Auto` follows the system and re-reads it
/// when macOS changes appearance, which is what a native window does.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Appearance {
    #[default]
    Auto,
    Light,
    Dark,
}

impl Appearance {
    pub fn is_dark(self, system: WindowAppearance) -> bool {
        let system_dark = matches!(
            system,
            WindowAppearance::Dark | WindowAppearance::VibrantDark
        );
        match self {
            Self::Auto => system_dark,
            Self::Light => false,
            Self::Dark => true,
        }
    }

    /// The explicit choice a quick toggle should land on: the opposite of what
    /// the window is showing now. From `Auto` this keeps following the system
    /// as the starting point, so the first press always changes the picture.
    pub fn toggled(self, system: WindowAppearance) -> Self {
        if self.is_dark(system) {
            Self::Light
        } else {
            Self::Dark
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "auto" => Some(Self::Auto),
            "light" => Some(Self::Light),
            "dark" => Some(Self::Dark),
            _ => None,
        }
    }
}

/// One cell's color as GPUI's renderer takes it.
pub fn tone(value: Rgb) -> Rgba {
    gpui::rgb(value.0)
}

pub fn status_tone(status: AgentStatus, chrome: &Chrome) -> Rgb {
    match status {
        AgentStatus::Working => chrome.accent,
        AgentStatus::Blocked => chrome.warning,
        AgentStatus::Done => chrome.success,
        AgentStatus::Idle | AgentStatus::Unknown => chrome.muted,
    }
}

pub fn status_label(status: AgentStatus) -> &'static str {
    match status {
        AgentStatus::Working => "working",
        AgentStatus::Blocked => "blocked",
        AgentStatus::Done => "done",
        AgentStatus::Idle => "idle",
        AgentStatus::Unknown => "unknown",
    }
}

pub fn connection_tone(connection: &Connection, chrome: &Chrome) -> Rgb {
    match connection {
        Connection::Ready => chrome.success,
        Connection::Connecting | Connection::Reconnecting { .. } => chrome.warning,
        Connection::Offline { .. } => chrome.danger,
    }
}

pub fn mono_font() -> Font {
    let family = if cfg!(target_os = "macos") {
        "Menlo"
    } else {
        "monospace"
    };
    let mut font = font(family);
    font.fallbacks = Some(FontFallbacks::from_fonts(vec![
        "Menlo".into(),
        "DejaVu Sans Mono".into(),
        "Consolas".into(),
        "monospace".into(),
    ]));
    font
}

pub fn mono_font_bold() -> Font {
    let mut font = mono_font();
    font.weight = FontWeight::BOLD;
    font
}

pub fn ui_font() -> Font {
    font(".SystemUIFont")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_dots_use_their_own_color_and_idle_shares_muted() {
        let chrome = Chrome::dark();
        assert_eq!(status_tone(AgentStatus::Working, &chrome), chrome.accent);
        assert_eq!(status_tone(AgentStatus::Blocked, &chrome), chrome.warning);
        assert_eq!(status_tone(AgentStatus::Done, &chrome), chrome.success);
        assert_eq!(status_tone(AgentStatus::Idle, &chrome), chrome.muted);
        assert_eq!(status_tone(AgentStatus::Unknown, &chrome), chrome.muted);
    }

    #[test]
    fn connection_dots_distinguish_live_busy_and_offline() {
        let chrome = Chrome::dark();
        assert_eq!(connection_tone(&Connection::Ready, &chrome), chrome.success);
        assert_eq!(
            connection_tone(&Connection::Connecting, &chrome),
            chrome.warning
        );
        assert_eq!(
            connection_tone(
                &Connection::Offline {
                    reason: "gone".into()
                },
                &chrome
            ),
            chrome.danger
        );
    }

    #[test]
    fn the_selection_is_system_blue_in_both_schemes() {
        assert_eq!(Chrome::dark().selected, Chrome::light().selected);
        assert_eq!(Chrome::dark().selected, Rgb::new(0x0a, 0x6f, 0xd8));
        assert!(!Chrome::light().dark);
        assert!(Chrome::dark().dark);
    }

    #[test]
    fn appearance_auto_follows_the_system_and_overrides_stay_put() {
        assert!(Appearance::Auto.is_dark(WindowAppearance::Dark));
        assert!(!Appearance::Auto.is_dark(WindowAppearance::Light));
        assert!(Appearance::Auto.is_dark(WindowAppearance::VibrantDark));
        assert!(Appearance::Dark.is_dark(WindowAppearance::Light));
        assert!(!Appearance::Light.is_dark(WindowAppearance::Dark));
        assert_eq!(
            Appearance::Auto.toggled(WindowAppearance::Dark),
            Appearance::Light
        );
        assert_eq!(
            Appearance::Auto.toggled(WindowAppearance::Light),
            Appearance::Dark
        );
        assert_eq!(
            Appearance::Dark.toggled(WindowAppearance::Dark),
            Appearance::Light
        );
        assert_eq!(
            Appearance::Light.toggled(WindowAppearance::Dark),
            Appearance::Dark
        );
        assert_eq!(
            Appearance::Dark.toggled(WindowAppearance::Light),
            Appearance::Light
        );
        assert_eq!(Appearance::parse("DARK"), Some(Appearance::Dark));
        assert_eq!(Appearance::parse("sepia"), None);
        assert_eq!(Appearance::parse("light"), Some(Appearance::Light));
    }

    #[test]
    fn find_washes_sit_between_the_warning_hue_and_the_surface() {
        for chrome in [Chrome::dark(), Chrome::light()] {
            let between =
                |low: u8, value: u8, high: u8| (low.min(high)..=low.max(high)).contains(&value);
            for wash in [chrome.find_match, chrome.find_current] {
                let (r, g, b) = wash.channels();
                let (wr, wg, wb) = chrome.warning.channels();
                let (br, bg, bb) = chrome.background.channels();
                assert!(between(br, r, wr) && between(bg, g, wg) && between(bb, b, wb));
                assert_ne!(wash, chrome.background);
            }
            assert_ne!(chrome.find_match, chrome.find_current);
        }
    }

    #[test]
    fn a_tint_stays_between_its_two_ends() {
        let chrome = Chrome::dark();
        let (r, g, b) = chrome.accent_soft().channels();
        let (ar, ag, ab) = chrome.accent.channels();
        let (br, bg, bb) = chrome.background.channels();
        let between =
            |low: u8, value: u8, high: u8| (low.min(high)..=low.max(high)).contains(&value);
        assert!(between(br, r, ar) && between(bg, g, ag) && between(bb, b, ab));
        assert_ne!(chrome.accent_soft(), chrome.accent);
        assert_eq!(
            Chrome::blend(chrome.accent, chrome.background, 100),
            chrome.accent
        );
        assert_eq!(
            Chrome::blend(chrome.accent, chrome.background, 0),
            chrome.background
        );
    }
}
