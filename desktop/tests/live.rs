//! Opt-in checks against a real Herdr session. They never start or stop a
//! session, never send input, and refuse to run unless `PF_DESKTOP_LIVE=1`.

use std::time::{Duration, Instant};

use pairfob_desktop::app::{AppEvent, Connection};
use pairfob_desktop::herdr::{self, Config, ConnectTarget};

fn live_target() -> Option<ConnectTarget> {
    if std::env::var("PF_DESKTOP_LIVE").as_deref() != Ok("1") {
        eprintln!("skipped: set PF_DESKTOP_LIVE=1 to attach to a real Herdr session");
        return None;
    }
    Some(ConnectTarget::Session {
        name: std::env::var("PF_DESKTOP_LIVE_SESSION").unwrap_or_else(|_| "pffixture".into()),
        development: false,
    })
}

#[test]
#[ignore = "attaches to a running Herdr session; set PF_DESKTOP_LIVE=1"]
fn attaches_to_a_live_session() {
    let Some(target) = live_target() else {
        return;
    };
    let mut config = Config::local();
    config.target = target;

    let report = herdr::self_check(&config, Duration::from_secs(15)).expect("self check");
    println!("{}", report.summary());

    assert_eq!(
        report.cells,
        usize::from(config.surface.cols) * usize::from(config.surface.rows),
        "the surface should cover the negotiated grid"
    );
    assert!(report.panes >= 1, "expected at least one pane");
    assert!(report.workspaces >= 1, "expected at least one workspace");
    assert!(report.boot.is_some(), "expected a snapshot boot id");
}

#[test]
#[ignore = "attaches to a running Herdr session; set PF_DESKTOP_LIVE=1"]
fn the_engine_streams_a_session_and_a_frame() {
    let Some(target) = live_target() else {
        return;
    };
    let mut config = Config::local();
    config.target = target;

    let desktop = herdr::start(config).expect("start engine");
    let deadline = Instant::now() + Duration::from_secs(15);
    let (mut session, mut frame, mut ready) = (false, false, false);
    while Instant::now() < deadline && !(session && frame && ready) {
        match desktop.events.recv_timeout(Duration::from_millis(200)) {
            Ok(AppEvent::Session(value)) => session = !value.workspaces.is_empty(),
            Ok(AppEvent::Frame(value)) => frame = !value.cells.is_empty(),
            Ok(AppEvent::Connection(Connection::Ready)) => ready = true,
            Ok(_) => {}
            Err(_) => {}
        }
    }
    desktop.handle.shutdown();

    assert!(ready, "engine never reported ready");
    assert!(session, "engine never reported a session");
    assert!(frame, "engine never reported a frame");
}
