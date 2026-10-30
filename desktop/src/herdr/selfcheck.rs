//! The headless probe behind `pairfob-desktop --self-check` and the opt-in
//! live test: connect once, read one snapshot and one surface, report them.

use std::time::{Duration, Instant};

use crossbeam_channel::RecvTimeoutError;

use super::connect::{self, ClientEvent};
use super::engine::{Config, EngineError};
use super::map;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SelfCheck {
    pub server: Option<String>,
    pub boot: Option<String>,
    pub panes: usize,
    pub workspaces: usize,
    pub cells: usize,
    pub cursor: Option<(u16, u16)>,
}

impl SelfCheck {
    pub fn summary(&self) -> String {
        format!(
            "server={} boot={} panes={} workspaces={} cells={} cursor={:?}",
            self.server.as_deref().unwrap_or("-"),
            self.boot.as_deref().unwrap_or("-"),
            self.panes,
            self.workspaces,
            self.cells,
            self.cursor
        )
    }
}

/// Connects, waits for one snapshot and one surface frame, and returns what it
/// saw. This is the headless path used by `pairfob-desktop --self-check` and by
/// the opt-in live test.
pub fn self_check(config: &Config, timeout: Duration) -> Result<SelfCheck, EngineError> {
    let client = connect::connect(config.connect_options(config.surface))
        .map_err(|error| EngineError::Herdr(error.to_string()))?;
    let deadline = Instant::now() + timeout;
    let mut report = SelfCheck::default();
    let mut have_snapshot = false;
    let mut have_surface = false;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(no_surface(timeout));
        }
        match client.events.recv_timeout(remaining) {
            Ok(ClientEvent::Connected(welcome)) => {
                report.server = Some(welcome.server_version);
            }
            Ok(ClientEvent::Snapshot(snapshot)) => {
                let session = map::session(&snapshot);
                report.boot = Some(snapshot.boot_id.clone());
                report.workspaces = session.workspaces.len();
                report.panes = session.pane_count();
                have_snapshot = true;
            }
            Ok(ClientEvent::Surface(surface)) => {
                let frame = map::frame(&surface);
                report.cells = frame.cells.len();
                report.cursor = frame.cursor.map(|cursor| (cursor.x, cursor.y));
                have_surface = true;
            }
            Ok(ClientEvent::Disconnected(reason)) => {
                return Err(EngineError::Herdr(reason));
            }
            Ok(_) => {}
            Err(RecvTimeoutError::Timeout) => return Err(no_surface(timeout)),
            Err(RecvTimeoutError::Disconnected) => return Err(EngineError::Closed),
        }
        if have_snapshot && have_surface {
            return Ok(report);
        }
    }
}

fn no_surface(timeout: Duration) -> EngineError {
    EngineError::Herdr(format!("no surface within {}s", timeout.as_secs()))
}
