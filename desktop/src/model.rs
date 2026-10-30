//! What the desktop calls the things it shows. Herdr wire types stop at
//! [`crate::herdr::map`], GPUI types start at [`crate::ui`]; everything between
//! speaks this module.

use std::fmt;
use std::sync::Arc;

use smol_str::SmolStr;

macro_rules! id_type {
    ($name:ident) => {
        #[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name(Arc<str>);

        impl $name {
            pub fn new(value: impl AsRef<str>) -> Self {
                Self(Arc::from(value.as_ref()))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self::new(value)
            }
        }

        impl From<String> for $name {
            fn from(value: String) -> Self {
                Self::new(value)
            }
        }
    };
}

id_type!(WorkspaceId);
id_type!(TabId);
id_type!(PaneId);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Size {
    pub cols: u16,
    pub rows: u16,
}

impl Size {
    pub const fn new(cols: u16, rows: u16) -> Self {
        Self { cols, rows }
    }

    pub fn cells(&self) -> usize {
        usize::from(self.cols) * usize::from(self.rows)
    }

    pub fn contains(&self, x: u16, y: u16) -> bool {
        x < self.cols && y < self.rows
    }
}

/// A color as the terminal program asked for it. The theme resolves it to a
/// concrete channel value only at paint time.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Color {
    /// The program said nothing, so the theme's foreground or background.
    Default,
    /// One of the sixteen ANSI colors, 1-based as the wire sends them.
    Named(u8),
    Palette(u8),
    Rgb(u8, u8, u8),
}

impl Color {
    pub fn is_default(self) -> bool {
        matches!(self, Self::Default)
    }
}

/// Cell attributes, bit for bit as Herdr's daemon measures them. Reversed and
/// hidden never appear here: the daemon swaps or collapses colors instead.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Modifier(pub u16);

impl Modifier {
    pub const BOLD: Self = Self(1);
    pub const DIM: Self = Self(2);
    pub const ITALIC: Self = Self(4);
    pub const UNDERLINE: Self = Self(8);
    pub const BLINK: Self = Self(16);
    pub const STRIKETHROUGH: Self = Self(256);

    pub fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }

    pub fn is_empty(self) -> bool {
        self.0 == 0
    }

    /// Underline styles are encoded as `level << 12`; zero means none.
    pub fn underline_level(self) -> u8 {
        ((self.0 >> 12) & 0xF) as u8
    }

    pub fn has_underline(self) -> bool {
        self.contains(Self::UNDERLINE) || self.underline_level() > 0
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cell {
    pub symbol: SmolStr,
    pub fg: Color,
    pub bg: Color,
    pub modifier: Modifier,
    /// The daemon reports a wide glyph's continuation cell as an ordinary
    /// space; this flag marks cells it knows must not be painted on their own.
    pub skip: bool,
    pub link: Option<u32>,
}

impl Default for Cell {
    fn default() -> Self {
        Self {
            symbol: SmolStr::new_static(" "),
            fg: Color::Default,
            bg: Color::Default,
            modifier: Modifier::default(),
            skip: false,
            link: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CursorShape {
    #[default]
    Block,
    Bar,
    Underline,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cursor {
    pub x: u16,
    pub y: u16,
    pub visible: bool,
    pub shape: CursorShape,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rect {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
}

impl Rect {
    pub fn contains(&self, x: u16, y: u16) -> bool {
        x >= self.x
            && y >= self.y
            && x < self.x.saturating_add(self.width)
            && y < self.y.saturating_add(self.height)
    }

    pub fn right(&self) -> u16 {
        self.x.saturating_add(self.width)
    }

    pub fn bottom(&self) -> u16 {
        self.y.saturating_add(self.height)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SplitDirection {
    Horizontal,
    Vertical,
}

/// Where a pane request moves or focuses, in the layout's own terms.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Left,
    Right,
    Up,
    Down,
}

impl Direction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Right => "right",
            Self::Up => "up",
            Self::Down => "down",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ZoomMode {
    Toggle,
    On,
    Off,
}

impl ZoomMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Toggle => "toggle",
            Self::On => "on",
            Self::Off => "off",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SplitRect {
    pub direction: SplitDirection,
    pub pos: u16,
    pub area: Rect,
    /// The grab band around the divider, in surface cells.
    pub hit_rect: Rect,
    /// Where the split sits in the layout tree; needed to resize it.
    pub path: Vec<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Scroll {
    pub offset_from_bottom: u64,
    pub max_offset_from_bottom: u64,
    pub viewport_rows: u16,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneRect {
    pub id: PaneId,
    pub rect: Rect,
    pub focused: bool,
    pub alternate_screen: bool,
    pub mouse_reporting: bool,
    pub scroll: Option<Scroll>,
    /// The pane content the surface was read from; a stale search reply names
    /// a different revision.
    pub content_revision: u64,
}

/// One surface frame: the cells of every pane in the focused workspace's
/// active tab, plus where those panes sit.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Frame {
    pub size: Size,
    pub cells: Vec<Cell>,
    pub cursor: Option<Cursor>,
    pub panes: Vec<PaneRect>,
    pub splits: Vec<SplitRect>,
    pub links: Vec<String>,
}

impl Frame {
    pub fn cell(&self, x: u16, y: u16) -> Option<&Cell> {
        if !self.size.contains(x, y) {
            return None;
        }
        self.cells
            .get(usize::from(y) * usize::from(self.size.cols) + usize::from(x))
    }

    pub fn pane_at(&self, x: u16, y: u16) -> Option<&PaneRect> {
        self.panes.iter().find(|pane| pane.rect.contains(x, y))
    }

    pub fn focused_pane(&self) -> Option<&PaneId> {
        self.panes
            .iter()
            .find(|pane| pane.focused)
            .map(|pane| &pane.id)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AgentStatus {
    Idle,
    Working,
    Blocked,
    Done,
    #[default]
    Unknown,
}

impl AgentStatus {
    pub fn label(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Working => "working",
            Self::Blocked => "blocked",
            Self::Done => "done",
            Self::Unknown => "unknown",
        }
    }

    /// Whether the dot should pulse or stand out in the session list.
    pub fn is_active(self) -> bool {
        matches!(self, Self::Working | Self::Blocked)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pane {
    pub id: PaneId,
    pub label: Option<String>,
    pub cwd: Option<String>,
    pub focused: bool,
    pub status: AgentStatus,
    pub agent: Option<String>,
    /// Metadata tokens reported by the pane's agent, keyed by token name.
    pub tokens: Vec<(String, String)>,
}

impl Pane {
    /// The pairfob-chat socket id, published as the `pairfob-chat` token.
    pub fn chat_id(&self) -> Option<&str> {
        self.tokens
            .iter()
            .find(|(name, _)| name == "pairfob-chat")
            .map(|(_, value)| value.as_str())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tab {
    pub id: TabId,
    pub number: usize,
    pub label: String,
    pub focused: bool,
    pub zoomed: bool,
    pub status: AgentStatus,
    pub panes: Vec<Pane>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Workspace {
    pub id: WorkspaceId,
    pub number: usize,
    pub label: String,
    pub branch: Option<String>,
    pub focused: bool,
    pub status: AgentStatus,
    pub tabs: Vec<Tab>,
}

impl Workspace {
    pub fn active_tab(&self) -> Option<&Tab> {
        self.tabs
            .iter()
            .find(|tab| tab.focused)
            .or(self.tabs.first())
    }

    pub fn pane_count(&self) -> usize {
        self.tabs.iter().map(|tab| tab.panes.len()).sum()
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Session {
    pub workspaces: Vec<Workspace>,
    pub focused_workspace: Option<WorkspaceId>,
    pub focused_tab: Option<TabId>,
    pub focused_pane: Option<PaneId>,
}

impl Session {
    pub fn workspace(&self, id: &WorkspaceId) -> Option<&Workspace> {
        self.workspaces.iter().find(|workspace| &workspace.id == id)
    }

    pub fn find_pane(&self, id: &PaneId) -> Option<(&Workspace, &Tab, &Pane)> {
        self.workspaces.iter().find_map(|workspace| {
            workspace.tabs.iter().find_map(|tab| {
                tab.panes
                    .iter()
                    .find(|pane| &pane.id == id)
                    .map(|pane| (workspace, tab, pane))
            })
        })
    }

    pub fn pane(&self, id: &PaneId) -> Option<&Pane> {
        self.find_pane(id).map(|(_, _, pane)| pane)
    }

    pub fn focused_workspace(&self) -> Option<&Workspace> {
        self.focused_workspace
            .as_ref()
            .and_then(|id| self.workspace(id))
            .or_else(|| self.workspaces.iter().find(|workspace| workspace.focused))
    }

    pub fn focused_tab(&self) -> Option<(&Workspace, &Tab)> {
        let workspace = self.focused_workspace()?;
        let tab = self
            .focused_tab
            .as_ref()
            .and_then(|id| workspace.tabs.iter().find(|tab| &tab.id == id))
            .or_else(|| workspace.active_tab())?;
        Some((workspace, tab))
    }

    pub fn pane_count(&self) -> usize {
        self.workspaces.iter().map(Workspace::pane_count).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.workspaces.is_empty()
    }

    pub fn ordered_panes(&self) -> impl Iterator<Item = (&Workspace, &Tab, &Pane)> {
        self.workspaces.iter().flat_map(|workspace| {
            workspace
                .tabs
                .iter()
                .flat_map(move |tab| tab.panes.iter().map(move |pane| (workspace, tab, pane)))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pane(id: &str) -> Pane {
        Pane {
            id: id.into(),
            label: None,
            cwd: None,
            focused: false,
            status: AgentStatus::Unknown,
            agent: None,
            tokens: Vec::new(),
        }
    }

    fn session() -> Session {
        Session {
            workspaces: vec![Workspace {
                id: "w1".into(),
                number: 1,
                label: "repo".into(),
                branch: Some("main".into()),
                focused: true,
                status: AgentStatus::Working,
                tabs: vec![Tab {
                    id: "w1:t1".into(),
                    number: 1,
                    label: "1".into(),
                    focused: true,
                    zoomed: false,
                    status: AgentStatus::Working,
                    panes: vec![pane("w1:p1"), pane("w1:p2")],
                }],
            }],
            focused_workspace: Some("w1".into()),
            focused_tab: Some("w1:t1".into()),
            focused_pane: Some("w1:p1".into()),
        }
    }

    #[test]
    fn finds_a_pane_through_its_workspace_and_tab() {
        let session = session();
        let (workspace, tab, pane) = session.find_pane(&"w1:p2".into()).expect("pane");
        assert_eq!(workspace.id, "w1".into());
        assert_eq!(tab.id, "w1:t1".into());
        assert_eq!(pane.id, "w1:p2".into());
        assert!(session.pane(&"w9:p9".into()).is_none());
    }

    #[test]
    fn focused_tab_falls_back_to_the_workspace_active_tab() {
        let mut session = session();
        session.focused_tab = Some("gone".into());
        let (workspace, tab) = session.focused_tab().expect("focused");
        assert_eq!(workspace.id, "w1".into());
        assert_eq!(tab.id, "w1:t1".into());
    }

    #[test]
    fn counts_panes_across_the_tree() {
        assert_eq!(session().pane_count(), 2);
        assert!(!session().is_empty());
        assert!(Session::default().is_empty());
    }

    #[test]
    fn frame_cell_and_pane_lookups_respect_bounds() {
        let frame = Frame {
            size: Size::new(4, 2),
            cells: vec![Cell::default(); 8],
            panes: vec![PaneRect {
                id: "w1:p1".into(),
                rect: Rect {
                    x: 0,
                    y: 0,
                    width: 2,
                    height: 2,
                },
                focused: true,
                alternate_screen: false,
                mouse_reporting: false,
                scroll: None,
                content_revision: 1,
            }],
            ..Frame::default()
        };
        assert!(frame.cell(3, 1).is_some());
        assert!(frame.cell(4, 1).is_none());
        assert_eq!(
            frame.pane_at(1, 1).map(|p| p.id.clone()),
            Some("w1:p1".into())
        );
        assert!(frame.pane_at(2, 1).is_none());
        assert_eq!(frame.focused_pane(), Some(&"w1:p1".into()));
    }

    #[test]
    fn modifier_bits_match_the_measured_daemon_values() {
        let combined = Modifier(4361);
        assert!(combined.contains(Modifier::BOLD));
        assert!(combined.contains(Modifier::UNDERLINE));
        assert!(combined.contains(Modifier::STRIKETHROUGH));
        assert_eq!(combined.underline_level(), 1);
        assert!(!Modifier(4104).contains(Modifier::ITALIC));
        assert!(Modifier::default().is_empty());
    }
}
