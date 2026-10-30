//! Decisions about where things go, kept free of GPUI so they can be checked
//! without a window.

use std::path::Path;
use std::time::Duration;

use crate::model::{Frame, Pane, PaneId, Size, SplitDirection, SplitRect, Workspace};

pub const SIDEBAR_DEFAULT: f32 = 260.;
pub const SIDEBAR_MIN: f32 = 220.;
pub const SIDEBAR_MAX: f32 = 340.;
/// Below this content width (window minus sidebar) the toolbar shortens its
/// text labels and tightens its gaps, so the window actions keep fitting at the
/// smallest legal window with the widest sidebar. The full "Pair a device"
/// label still fits at 460, which is where the default sidebar meets the
/// smallest window; this threshold keeps the long label everywhere it reads.
pub const COMPACT_TOOLBAR_WIDTH: f32 = 440.;
/// Below this content width the footer's shortcut hints stop fitting; the
/// status and the working directory keep the room instead.
pub const FOOTER_HINTS_WIDTH: f32 = 470.;
/// Width reserved for the sidebar controls when the sidebar is collapsed.
pub const COLLAPSED_TOOLBAR_INSET: f32 = 92.;
pub const TOOLBAR_HEIGHT: f32 = 52.;
pub const FOOTER_HEIGHT: f32 = 46.;
pub const FILTER_HEIGHT: f32 = 26.;
pub const GROUP_ROW: f32 = 30.;
pub const PANE_ROW: f32 = 26.;
pub const GROUP_INSET: f32 = 10.;
pub const PANE_INSET: f32 = 30.;
/// The band at the top of the sidebar that holds the window controls. It is
/// also where a drag moves the window.
pub const TITLEBAR_HEIGHT: f32 = 38.;
pub const FONT_SIZE_DEFAULT: f32 = 13.;
pub const FONT_SIZE_MIN: f32 = 9.;
pub const FONT_SIZE_MAX: f32 = 24.;
pub const FONT_SIZE_STEP: f32 = 1.;
pub const TERMINAL_FONT_SIZE: f32 = FONT_SIZE_DEFAULT;
/// Radii: rows are pills, cards are windows, controls sit between.
pub const RADIUS_ROW: f32 = 7.;
pub const RADIUS_CARD: f32 = 12.;
pub const RADIUS_CONTROL: f32 = 6.;

pub fn clamp_font_size(size: f32) -> f32 {
    if size.is_finite() {
        size.clamp(FONT_SIZE_MIN, FONT_SIZE_MAX)
    } else {
        FONT_SIZE_DEFAULT
    }
}

/// A resizable sidebar, clamped so it never crowds the terminal.
pub fn sidebar_width(requested: f32, collapsed: bool) -> f32 {
    if collapsed {
        0.
    } else {
        requested.clamp(SIDEBAR_MIN, SIDEBAR_MAX)
    }
}

/// Left padding inside the toolbar, which must clear the window controls when
/// the sidebar is gone.
pub fn toolbar_inset(collapsed: bool) -> f32 {
    if collapsed {
        COLLAPSED_TOOLBAR_INSET
    } else {
        16.
    }
}

/// Whether a pane survives the sidebar filter. An empty filter keeps every
/// row; a query matches the pane's name, agent, cwd, workspace and tab.
pub fn pane_matches(pane: &Pane, workspace: &str, tab: &str, filter: &str, index: usize) -> bool {
    let query = filter.trim().to_lowercase();
    if query.is_empty() {
        return true;
    }
    let label = pane_label(pane, index).to_lowercase();
    [
        label,
        workspace.to_lowercase(),
        tab.to_lowercase(),
        pane.agent.clone().unwrap_or_default().to_lowercase(),
        pane.cwd.clone().unwrap_or_default().to_lowercase(),
    ]
    .iter()
    .any(|field| field.contains(&query))
}

/// The splitter under a surface cell, if any. The server's hit rect is wider
/// than the drawn line so a mouse can grab it.
pub fn split_at(frame: &Frame, x: u16, y: u16) -> Option<&SplitRect> {
    frame.splits.iter().find(|split| {
        let hit = split.hit_rect;
        x >= hit.x && x < hit.right() && y >= hit.y && y < hit.bottom()
    })
}

/// The ratio a pointer at `(x, y)` asks of a split. It is clamped to the range
/// the endpoint accepts, so a drag cannot collapse a pane.
pub fn split_ratio(split: &SplitRect, x: u16, y: u16) -> f32 {
    let area = split.area;
    let (position, extent) = match split.direction {
        SplitDirection::Vertical => (
            u32::from(x.saturating_sub(area.x)),
            u32::from(area.width.max(1)),
        ),
        SplitDirection::Horizontal => (
            u32::from(y.saturating_sub(area.y)),
            u32::from(area.height.max(1)),
        ),
    };
    (position as f32 / extent as f32).clamp(0.1, 0.9)
}

/// One-cell runs that draw the divider where a drag would land it. The caller
/// paints them as a background in the accent color.
pub fn split_preview(split: &SplitRect, ratio: f32) -> Vec<(u16, u16, u16)> {
    let area = split.area;
    let ratio = ratio.clamp(0.1, 0.9);
    match split.direction {
        SplitDirection::Vertical => {
            let at = area.x + (f32::from(area.width) * ratio).round() as u16;
            let at = at.min(area.right().saturating_sub(1));
            (area.y..area.bottom()).map(|y| (at, y, 1)).collect()
        }
        SplitDirection::Horizontal => {
            let at = area.y + (f32::from(area.height) * ratio).round() as u16;
            let at = at.min(area.bottom().saturating_sub(1));
            vec![(area.x, at, area.width)]
        }
    }
}

/// The grid a canvas of exactly this size can hold. A cell is never painted
/// half off the canvas, so the columns and rows round down and never reach 0.
pub fn grid_for(width: f32, height: f32, cell_width: f32, cell_height: f32) -> Size {
    if !(width.is_finite() && height.is_finite()) || cell_width <= 0. || cell_height <= 0. {
        return Size::new(1, 1);
    }
    let cols = (width / cell_width).floor();
    let rows = (height / cell_height).floor();
    Size::new(
        cols.clamp(1., f32::from(u16::MAX)) as u16,
        rows.clamp(1., f32::from(u16::MAX)) as u16,
    )
}

/// The pane a workspace click should focus. There is no workspace-focus
/// command, so this is the pane the engine would focus for that workspace.
pub fn workspace_target(workspace: &Workspace) -> Option<PaneId> {
    workspace
        .tabs
        .iter()
        .flat_map(|tab| tab.panes.iter())
        .find(|pane| pane.focused)
        .or_else(|| {
            workspace
                .tabs
                .iter()
                .flat_map(|tab| tab.panes.iter())
                .next()
        })
        .map(|pane| pane.id.clone())
}

pub fn pane_label(pane: &Pane, index: usize) -> String {
    if let Some(label) = pane.label.as_deref().filter(|label| !label.is_empty()) {
        return label.to_owned();
    }
    if let Some(name) = pane.cwd.as_deref().and_then(basename) {
        return name.to_owned();
    }
    if let Some(agent) = pane.agent.as_deref().filter(|agent| !agent.is_empty()) {
        return agent.to_owned();
    }
    format!("pane {}", index + 1)
}

fn basename(cwd: &str) -> Option<&str> {
    Path::new(cwd)
        .components()
        .next_back()
        .and_then(|component| component.as_os_str().to_str())
        .filter(|name| !name.is_empty() && *name != "/")
}

/// `mm:ss` left on the pairing code. No expiry hides the countdown.
pub fn countdown(remaining: Option<Duration>) -> String {
    let Some(remaining) = remaining else {
        return String::new();
    };
    let mut seconds = remaining.as_secs();
    if remaining.subsec_nanos() > 0 {
        seconds = seconds.saturating_add(1);
    }
    format!("{:02}:{:02}", seconds / 60, seconds % 60)
}

/// The pairing QR is square; it shrinks on short windows so the sheet still
/// fits, and never grows past the requested size.
pub fn qr_side(window_height: f32, requested: f32) -> f32 {
    (window_height - 360.).clamp(160., requested)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AgentStatus, Rect, Tab};

    fn pane(id: &str, cwd: Option<&str>, label: Option<&str>) -> Pane {
        Pane {
            id: id.into(),
            label: label.map(str::to_owned),
            cwd: cwd.map(str::to_owned),
            focused: false,
            status: AgentStatus::Idle,
            agent: None,
            tokens: Vec::new(),
        }
    }

    fn tab(id: &str, panes: Vec<Pane>) -> Tab {
        Tab {
            id: id.into(),
            number: 1,
            label: "1".into(),
            focused: true,
            zoomed: false,
            status: AgentStatus::Idle,
            panes,
        }
    }

    #[test]
    fn the_font_size_stays_inside_its_range() {
        assert_eq!(clamp_font_size(FONT_SIZE_DEFAULT), FONT_SIZE_DEFAULT);
        assert_eq!(clamp_font_size(0.), FONT_SIZE_MIN);
        assert_eq!(clamp_font_size(100.), FONT_SIZE_MAX);
        assert_eq!(clamp_font_size(f32::NAN), FONT_SIZE_DEFAULT);
        assert_eq!(clamp_font_size(f32::INFINITY), FONT_SIZE_DEFAULT);
    }

    #[test]
    fn the_sidebar_is_resizable_and_bounded() {
        assert_eq!(sidebar_width(260., false), 260.);
        assert_eq!(sidebar_width(100., false), SIDEBAR_MIN);
        assert_eq!(sidebar_width(999., false), SIDEBAR_MAX);
        assert_eq!(sidebar_width(260., true), 0.);
        assert_eq!(toolbar_inset(true), COLLAPSED_TOOLBAR_INSET);
        assert_eq!(toolbar_inset(false), 16.);
    }

    #[test]
    fn the_toolbar_compacts_before_the_window_actions_run_out_of_room() {
        // 720 is the window's minimum width, so this is the narrowest content
        // the toolbar can be given, and the widest sidebar a user can pick.
        const { assert!(720. - SIDEBAR_MAX < COMPACT_TOOLBAR_WIDTH) };
        const { assert!(720. - SIDEBAR_MIN > COMPACT_TOOLBAR_WIDTH) };
        const { assert!(1280. - SIDEBAR_DEFAULT > COMPACT_TOOLBAR_WIDTH) };
        const { assert!(720. - SIDEBAR_MAX < FOOTER_HINTS_WIDTH) };
        const { assert!(720. - SIDEBAR_MIN > FOOTER_HINTS_WIDTH) };
    }

    fn split() -> SplitRect {
        SplitRect {
            direction: SplitDirection::Vertical,
            pos: 10,
            area: Rect {
                x: 0,
                y: 0,
                width: 20,
                height: 6,
            },
            hit_rect: Rect {
                x: 9,
                y: 0,
                width: 2,
                height: 6,
            },
            path: vec![false],
        }
    }

    #[test]
    fn a_splitter_uses_the_servers_hit_rect_and_clamps_the_drag() {
        let frame = Frame {
            splits: vec![split()],
            ..Frame::default()
        };
        assert!(split_at(&frame, 9, 3).is_some());
        assert!(split_at(&frame, 8, 3).is_none());
        assert!(split_at(&frame, 9, 6).is_none());
        assert!((split_ratio(&split(), 10, 0) - 0.5).abs() < 1e-6);
        assert_eq!(split_ratio(&split(), 0, 0), 0.1);
        assert_eq!(split_ratio(&split(), 20, 0), 0.9);
    }

    #[test]
    fn the_preview_follows_the_dragged_ratio() {
        let runs = split_preview(&split(), 0.5);
        assert_eq!(runs.len(), 6);
        assert!(runs.iter().all(|(x, _, cells)| *x == 10 && *cells == 1));
        let mut horizontal = split();
        horizontal.direction = SplitDirection::Horizontal;
        horizontal.area.height = 8;
        assert_eq!(split_preview(&horizontal, 0.5), vec![(0, 4, 20)]);
    }

    #[test]
    fn filtering_matches_the_visible_words() {
        let pane = pane("p", Some("/src/repo"), None);
        assert!(pane_matches(&pane, "repo", "shell", "", 0));
        assert!(pane_matches(&pane, "repo", "shell", "REPO", 0));
        assert!(pane_matches(&pane, "repo", "shell", "shell", 0));
        assert!(pane_matches(&pane, "repo", "shell", "src", 0));
        assert!(!pane_matches(&pane, "repo", "shell", "claude", 0));
    }

    #[test]
    fn the_grid_rounds_down_and_stays_positive() {
        let grid = grid_for(101., 57., 9.5, 18.);
        assert_eq!(grid, Size::new(10, 3));
        assert_eq!(grid_for(0., 0., 9., 18.), Size::new(1, 1));
        assert_eq!(grid_for(10., 10., 0., 0.), Size::new(1, 1));
        assert_eq!(grid_for(f32::INFINITY, 10., 9., 18.), Size::new(1, 1));
    }

    #[test]
    fn a_workspace_click_targets_its_focused_pane_then_the_first() {
        let mut first = pane("w:t:p1", None, None);
        let mut second = pane("w:t:p2", None, None);
        second.focused = true;
        let workspace = Workspace {
            id: "w".into(),
            number: 1,
            label: "repo".into(),
            branch: None,
            focused: true,
            status: AgentStatus::Idle,
            tabs: vec![tab("w:t", vec![first.clone(), second])],
        };
        assert_eq!(workspace_target(&workspace), Some(PaneId::from("w:t:p2")));
        first.focused = true;
        let workspace = Workspace {
            tabs: vec![tab("w:t", vec![first, pane("w:t:p3", None, None)])],
            ..workspace
        };
        assert_eq!(workspace_target(&workspace), Some(PaneId::from("w:t:p1")));
    }

    #[test]
    fn labels_fall_back_from_name_to_directory_to_agent_to_number() {
        assert_eq!(
            pane_label(&pane("p", Some("/src/repo"), Some("shell")), 0),
            "shell"
        );
        assert_eq!(pane_label(&pane("p", Some("/src/repo"), None), 0), "repo");
        let mut agent = pane("p", None, None);
        agent.agent = Some("claude".into());
        assert_eq!(pane_label(&agent, 2), "claude");
        assert_eq!(pane_label(&pane("p", None, None), 2), "pane 3");
    }

    #[test]
    fn the_countdown_rounds_up_and_never_shows_a_bare_second() {
        assert_eq!(countdown(Some(Duration::from_secs(90))), "01:30");
        assert_eq!(countdown(Some(Duration::from_millis(1))), "00:01");
        assert_eq!(countdown(Some(Duration::from_secs(0))), "00:00");
        assert_eq!(countdown(None), "");
    }

    #[test]
    fn the_qr_shrinks_on_short_windows_but_keeps_a_floor() {
        assert_eq!(qr_side(840., 240.), 240.);
        assert_eq!(qr_side(520., 240.), 160.);
        assert_eq!(qr_side(620., 240.), 240.);
    }
}
