//! The state the window shows, built only from events. The engine keeps one
//! copy for its own decisions and the window keeps one for painting; both apply
//! the same events in the same order, so they never disagree.

pub mod input;

use std::sync::Arc;

use crate::herdr::search::SearchOutcome;
use crate::model::{Frame, Pane, PaneId, Session, WorkspaceId};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Connection {
    #[default]
    Connecting,
    Ready,
    Reconnecting {
        attempt: u32,
        reason: String,
    },
    Offline {
        reason: String,
    },
}

impl Connection {
    pub fn is_ready(&self) -> bool {
        matches!(self, Self::Ready)
    }

    pub fn label(&self) -> String {
        match self {
            Self::Connecting => "connecting".into(),
            Self::Ready => "connected".into(),
            Self::Reconnecting { attempt, .. } => format!("reconnecting ({attempt})"),
            Self::Offline { .. } => "offline".into(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoticeLevel {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Notice {
    pub level: NoticeLevel,
    pub text: String,
}

impl Notice {
    pub fn info(text: impl Into<String>) -> Self {
        Self {
            level: NoticeLevel::Info,
            text: text.into(),
        }
    }

    pub fn warning(text: impl Into<String>) -> Self {
        Self {
            level: NoticeLevel::Warning,
            text: text.into(),
        }
    }

    pub fn error(text: impl Into<String>) -> Self {
        Self {
            level: NoticeLevel::Error,
            text: text.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServerInfo {
    pub version: String,
    pub generation: u16,
    pub snapshot_codec: String,
    pub surface_codec: String,
    /// Endpoint methods the server welcomes through the client shell lane.
    pub methods: Vec<String>,
    pub capabilities: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AppEvent {
    Connection(Connection),
    Server(ServerInfo),
    Session(Session),
    Frame(Arc<Frame>),
    Notice(Notice),
    /// A `pane.copy_search` reply, routed to the find bar by the window before
    /// the event is applied here.
    Search {
        request_id: u64,
        outcome: SearchOutcome,
    },
}

#[derive(Default)]
pub struct App {
    pub connection: Connection,
    pub server: Option<ServerInfo>,
    pub session: Option<Session>,
    pub frame: Option<Arc<Frame>>,
    pub notice: Option<Notice>,
}

impl App {
    pub fn apply(&mut self, event: AppEvent) {
        match event {
            AppEvent::Connection(connection) => self.connection = connection,
            AppEvent::Server(server) => self.server = Some(server),
            AppEvent::Session(session) => self.session = Some(session),
            AppEvent::Frame(frame) => self.frame = Some(frame),
            AppEvent::Notice(notice) => self.notice = Some(notice),
            AppEvent::Search { .. } => {}
        }
    }

    pub fn can_interact(&self) -> bool {
        self.connection.is_ready() && self.frame.is_some()
    }

    /// Whether the welcome advertised an endpoint method. An older server
    /// without `methods` reports none, so the control stays hidden.
    pub fn supports(&self, method: &str) -> bool {
        self.server
            .as_ref()
            .is_some_and(|server| server.methods.iter().any(|known| known == method))
    }

    pub fn focused_pane(&self) -> Option<PaneId> {
        self.frame
            .as_ref()
            .and_then(|frame| frame.focused_pane().cloned())
            .or_else(|| {
                self.session
                    .as_ref()
                    .and_then(|session| session.focused_pane.clone())
            })
    }

    pub fn pane(&self, id: &PaneId) -> Option<&Pane> {
        self.session.as_ref().and_then(|session| session.pane(id))
    }

    pub fn workspace_label(&self, id: &WorkspaceId) -> Option<&str> {
        self.session
            .as_ref()
            .and_then(|session| session.workspace(id))
            .map(|workspace| workspace.label.as_str())
    }

    /// The header line for the session: branch when Herdr knows it, else label.
    pub fn active_title(&self) -> Option<String> {
        let session = self.session.as_ref()?;
        let workspace = session.focused_workspace()?;
        match &workspace.branch {
            Some(branch) => Some(format!("{} · {branch}", workspace.label)),
            None => Some(workspace.label.clone()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AgentStatus, Size, Tab};

    fn frame(pane: &str) -> Arc<Frame> {
        Arc::new(Frame {
            size: Size::new(10, 4),
            cells: vec![Default::default(); 40],
            panes: vec![crate::model::PaneRect {
                id: pane.into(),
                rect: crate::model::Rect {
                    x: 0,
                    y: 0,
                    width: 10,
                    height: 4,
                },
                focused: true,
                alternate_screen: false,
                mouse_reporting: false,
                scroll: None,
                content_revision: 1,
            }],
            ..Frame::default()
        })
    }

    #[test]
    fn events_replace_state_and_keep_the_latest_notice() {
        let mut app = App::default();
        assert!(!app.can_interact());
        app.apply(AppEvent::Connection(Connection::Ready));
        app.apply(AppEvent::Frame(frame("w1:p1")));
        app.apply(AppEvent::Notice(Notice::warning("focus lost")));
        assert!(app.can_interact());
        assert_eq!(app.focused_pane(), Some("w1:p1".into()));
        assert_eq!(
            app.notice.as_ref().map(|n| n.level),
            Some(NoticeLevel::Warning)
        );
    }

    #[test]
    fn the_session_lookup_fills_the_gap_before_the_first_frame() {
        let mut app = App::default();
        app.apply(AppEvent::Session(Session {
            workspaces: vec![crate::model::Workspace {
                id: "w1".into(),
                number: 1,
                label: "repo".into(),
                branch: Some("main".into()),
                focused: true,
                status: AgentStatus::Idle,
                tabs: vec![Tab {
                    id: "w1:t1".into(),
                    number: 1,
                    label: "1".into(),
                    focused: true,
                    zoomed: false,
                    status: AgentStatus::Idle,
                    panes: vec![Pane {
                        id: "w1:p1".into(),
                        label: None,
                        cwd: None,
                        focused: true,
                        status: AgentStatus::Idle,
                        agent: None,
                        tokens: Vec::new(),
                    }],
                }],
            }],
            focused_workspace: Some("w1".into()),
            focused_tab: Some("w1:t1".into()),
            focused_pane: Some("w1:p1".into()),
        }));
        assert_eq!(app.focused_pane(), Some("w1:p1".into()));
        assert_eq!(app.active_title().as_deref(), Some("repo · main"));
    }

    #[test]
    fn connection_labels_name_the_state() {
        assert_eq!(Connection::default().label(), "connecting");
        assert_eq!(Connection::Ready.label(), "connected");
        assert_eq!(
            Connection::Reconnecting {
                attempt: 3,
                reason: "closed".into()
            }
            .label(),
            "reconnecting (3)"
        );
    }
}
