//! Window size and position remembered between runs. The file is small and
//! written off the UI thread except at shutdown, where there is no next frame
//! to defer to.

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use gpui::{point, px, size, App, Bounds, Pixels};
use serde::{Deserialize, Serialize};

use super::layout;
use super::theme::Appearance;

const DEFAULT_WIDTH: f32 = 1280.;
const DEFAULT_HEIGHT: f32 = 840.;
const MIN_WIDTH: f32 = 720.;
const MIN_HEIGHT: f32 = 520.;
const MAX_SIDE: f32 = 20_000.;
/// Bounds change on every drag frame; the file is written at most this often.
pub const SAVE_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Saved {
    pub width: f32,
    pub height: f32,
    #[serde(default)]
    pub x: Option<f32>,
    #[serde(default)]
    pub y: Option<f32>,
    #[serde(default = "default_sidebar")]
    pub sidebar_width: f32,
    #[serde(default)]
    pub sidebar_collapsed: bool,
    #[serde(default)]
    pub appearance: Appearance,
    #[serde(default = "default_font_size")]
    pub font_size: f32,
}

fn default_sidebar() -> f32 {
    layout::SIDEBAR_DEFAULT
}

fn default_font_size() -> f32 {
    layout::FONT_SIZE_DEFAULT
}

impl Default for Saved {
    fn default() -> Self {
        Self {
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            x: None,
            y: None,
            sidebar_width: layout::SIDEBAR_DEFAULT,
            sidebar_collapsed: false,
            appearance: Appearance::Auto,
            font_size: layout::FONT_SIZE_DEFAULT,
        }
    }
}

impl Saved {
    pub fn load() -> Self {
        let Some(path) = path() else {
            return Self::default();
        };
        let Ok(bytes) = fs::read(path) else {
            return Self::default();
        };
        serde_json::from_slice::<Saved>(&bytes)
            .ok()
            .filter(Saved::is_valid)
            .unwrap_or_default()
    }

    pub fn bounds(&self, cx: &App) -> Bounds<Pixels> {
        let size = size(
            px(clamp_side(self.width, MIN_WIDTH)),
            px(clamp_side(self.height, MIN_HEIGHT)),
        );
        match (self.x, self.y) {
            (Some(x), Some(y)) if x.is_finite() && y.is_finite() => {
                Bounds::new(point(px(x), px(y)), size)
            }
            _ => Bounds::centered(None, size, cx),
        }
    }

    pub fn from_bounds(bounds: Bounds<Pixels>) -> Self {
        Self {
            width: clamp_side(f32::from(bounds.size.width), MIN_WIDTH),
            height: clamp_side(f32::from(bounds.size.height), MIN_HEIGHT),
            x: Some(f32::from(bounds.origin.x)),
            y: Some(f32::from(bounds.origin.y)),
            ..Self::default()
        }
    }

    /// A malformed file must not put the window off every display, so only
    /// finite positive sizes are trusted; positions are checked when used.
    fn is_valid(&self) -> bool {
        self.width.is_finite()
            && self.height.is_finite()
            && self.width >= MIN_WIDTH
            && self.height >= MIN_HEIGHT
            && self.width <= MAX_SIDE
            && self.height <= MAX_SIDE
            && self.font_size.is_finite()
    }

    pub fn save(&self) {
        let Some(path) = path() else {
            return;
        };
        let Some(parent) = path.parent() else {
            return;
        };
        if fs::create_dir_all(parent).is_err() {
            return;
        }
        let Ok(bytes) = serde_json::to_vec_pretty(self) else {
            return;
        };
        let temporary = path.with_extension("json.tmp");
        if fs::write(&temporary, bytes).is_ok() {
            let _ = fs::rename(temporary, path);
        }
    }
}

fn clamp_side(value: f32, minimum: f32) -> f32 {
    if value.is_finite() {
        value.clamp(minimum, MAX_SIDE)
    } else {
        minimum
    }
}

fn path() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        let home = std::env::var_os("HOME")?;
        return Some(
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("Pairfob")
                .join("window.json"),
        );
    }
    let state = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local").join("state"))
        })?;
    Some(state.join("pairfob").join("window.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nonsense_sizes_fall_back_to_the_default() {
        assert!(Saved::default().is_valid());
        assert!(!Saved {
            width: f32::NAN,
            ..Saved::default()
        }
        .is_valid());
        assert!(!Saved {
            height: 100.,
            ..Saved::default()
        }
        .is_valid());
        assert_eq!(clamp_side(f32::INFINITY, 720.), 720.);
        assert_eq!(clamp_side(100., 720.), 720.);
    }

    #[test]
    fn round_tripping_bounds_keeps_the_size_and_position() {
        let bounds = Bounds::new(point(px(40.), px(60.)), size(px(1280.), px(840.)));
        let saved = Saved::from_bounds(bounds);
        assert_eq!(saved.width, 1280.);
        assert_eq!(saved.height, 840.);
        assert_eq!(saved.x, Some(40.));
        assert_eq!(saved.y, Some(60.));
        assert_eq!(saved.sidebar_width, layout::SIDEBAR_DEFAULT);
        assert_eq!(saved.appearance, Appearance::Auto);
    }

    #[test]
    fn older_files_without_sidebar_or_appearance_still_load() {
        let saved: Saved = serde_json::from_str(r#"{"width":1280,"height":840}"#).unwrap();
        assert_eq!(saved.sidebar_width, layout::SIDEBAR_DEFAULT);
        assert!(!saved.sidebar_collapsed);
        assert_eq!(saved.appearance, Appearance::Auto);
    }
}
