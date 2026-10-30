//! The independent endpoint client against a real Herdr session.
//! `PF_DESKTOP_LIVE=1 cargo test --test connect_live -- --ignored`

use std::collections::HashSet;
use std::time::{Duration, Instant};

use pairfob_desktop::herdr::connect::{
    self, ClientEvent, ConnectOptions, ConnectTarget, Connection,
};
use pairfob_desktop::herdr::wire::{ClientShellSnapshot, PaneSurfaceFrame};
use pairfob_desktop::model::Size;

const TIMEOUT: Duration = Duration::from_secs(15);

fn live_target() -> ConnectTarget {
    let name = std::env::var("PF_DESKTOP_SESSION").unwrap_or_else(|_| "pffixture".into());
    ConnectTarget::Session {
        name,
        development: false,
    }
}

fn connect() -> Connection {
    connect::connect(ConnectOptions {
        target: live_target(),
        surface: Size::new(100, 30),
        cell_width_px: 9,
        cell_height_px: 18,
    })
    .expect("connect to the live endpoint")
}

fn await_session(
    connection: &Connection,
    deadline: Instant,
) -> (ClientShellSnapshot, PaneSurfaceFrame) {
    let mut snapshot = None;
    let mut surface = None;
    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match connection.events.recv_timeout(remaining) {
            Ok(ClientEvent::Connected(_)) => {}
            Ok(ClientEvent::Snapshot(value)) => snapshot = Some(*value),
            Ok(ClientEvent::Surface(value)) => surface = Some(*value),
            // A patch only lands after the full surface this test waits for.
            Ok(ClientEvent::Patch(_)) => {}
            Ok(ClientEvent::Disconnected(reason)) => panic!("disconnected: {reason}"),
            Ok(ClientEvent::Response {
                method, response, ..
            }) => {
                panic!("unexpected response before focus: {method} {response}")
            }
            Err(error) => panic!("no snapshot and surface: {error}"),
        }
        if let (Some(snapshot), Some(surface)) = (&snapshot, &surface) {
            return (snapshot.clone(), surface.clone());
        }
    }
    panic!("no snapshot and surface within {TIMEOUT:?}");
}

fn await_response(connection: &Connection, expected: &str) {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(!remaining.is_zero(), "{expected} never answered");
        match connection.events.recv_timeout(remaining) {
            Ok(ClientEvent::Response {
                method, response, ..
            }) => {
                if method != expected {
                    continue;
                }
                assert!(
                    response.get("error").is_none(),
                    "{method} failed: {response}"
                );
                return;
            }
            Ok(ClientEvent::Disconnected(reason)) => panic!("disconnected: {reason}"),
            Ok(_) => {}
            Err(error) => panic!("{expected} never answered: {error}"),
        }
    }
}

fn await_snapshot_where(
    connection: &Connection,
    deadline: Instant,
    predicate: impl Fn(&ClientShellSnapshot) -> bool,
) -> ClientShellSnapshot {
    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match connection.events.recv_timeout(remaining) {
            Ok(ClientEvent::Snapshot(value)) if predicate(&value) => return *value,
            Ok(ClientEvent::Disconnected(reason)) => panic!("disconnected: {reason}"),
            Ok(_) => {}
            Err(error) => panic!("expected snapshot never arrived: {error}"),
        }
    }
    panic!("expected snapshot never arrived within {TIMEOUT:?}");
}

#[test]
#[ignore = "attaches to a running Herdr session; set PF_DESKTOP_LIVE=1"]
fn connects_and_reads_a_snapshot_surface_and_focus_response() {
    if std::env::var("PF_DESKTOP_LIVE").ok().as_deref() != Some("1") {
        return;
    }
    let connection = connect();
    let (snapshot, surface) = await_session(&connection, Instant::now() + TIMEOUT);
    assert!(!snapshot.workspaces.is_empty());
    assert_eq!(snapshot.boot_id, surface.boot_id);
    assert!(!surface.panes.is_empty());
    assert_eq!(
        surface.frame.cells.len(),
        usize::from(surface.frame.width) * usize::from(surface.frame.height)
    );

    let pane = snapshot
        .focused_pane_id
        .clone()
        .or_else(|| surface.panes.first().map(|pane| pane.pane_id.clone()))
        .expect("a pane to focus");
    connection.handle.focus_pane(&pane).expect("send focus");
    await_response(&connection, "pane.focus");
}

#[test]
#[ignore = "creates and closes a real split; set PF_DESKTOP_LIVE=1"]
fn splits_zooms_and_closes_a_pane() {
    if std::env::var("PF_DESKTOP_LIVE").ok().as_deref() != Some("1") {
        return;
    }
    let connection = connect();
    let (snapshot, _) = await_session(&connection, Instant::now() + TIMEOUT);
    let before: HashSet<String> = snapshot
        .panes
        .iter()
        .map(|pane| pane.pane_id.clone())
        .collect();
    let pane = snapshot
        .focused_pane_id
        .clone()
        .or_else(|| before.iter().next().cloned())
        .expect("a pane to split");

    connection
        .handle
        .split(&pane, "right", None, true)
        .expect("send split");
    await_response(&connection, "pane.split");
    let after = await_snapshot_where(&connection, Instant::now() + TIMEOUT, |snapshot| {
        snapshot.panes.len() > before.len()
    });
    let created = after
        .panes
        .iter()
        .map(|pane| pane.pane_id.clone())
        .find(|id| !before.contains(id))
        .expect("the new pane");

    connection
        .handle
        .zoom(&created, "toggle")
        .expect("send zoom");
    await_response(&connection, "pane.zoom");
    connection
        .handle
        .zoom(&created, "off")
        .expect("send zoom off");
    await_response(&connection, "pane.zoom");

    connection.handle.close_pane(&created).expect("send close");
    await_response(&connection, "pane.close");
    let _ = await_snapshot_where(&connection, Instant::now() + TIMEOUT, |snapshot| {
        snapshot.panes.len() == before.len()
    });
}
