//! `pane.copy_search` against a real Herdr session: the window only shows the
//! visible cells, so find has to be checked against the daemon that owns the
//! scrollback.
//! `PF_DESKTOP_LIVE=1 cargo test --test search_live -- --ignored`

use std::time::{Duration, Instant};

use pairfob_desktop::herdr::connect::{
    self, ClientEvent, ConnectOptions, ConnectTarget, Connection,
};
use pairfob_desktop::herdr::search::{
    self, SearchDirection, SearchOutcome, SearchRequest, TextPoint,
};
use pairfob_desktop::herdr::wire::PaneSurfaceFrame;
use pairfob_desktop::model::Size;

const TIMEOUT: Duration = Duration::from_secs(15);

fn connect() -> Connection {
    let name = std::env::var("PF_DESKTOP_SESSION").unwrap_or_else(|_| "pffixture".into());
    connect::connect(ConnectOptions {
        target: ConnectTarget::Session {
            name,
            development: false,
        },
        surface: Size::new(100, 30),
        cell_width_px: 9,
        cell_height_px: 18,
    })
    .expect("connect to the live endpoint")
}

fn await_surface(connection: &Connection, deadline: Instant) -> PaneSurfaceFrame {
    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match connection.events.recv_timeout(remaining) {
            Ok(ClientEvent::Surface(value)) => return *value,
            Ok(ClientEvent::Disconnected(reason)) => panic!("disconnected: {reason}"),
            Ok(_) => {}
            Err(error) => panic!("no surface: {error}"),
        }
    }
    panic!("no surface within {TIMEOUT:?}");
}

/// The longest run of letters or digits on screen, as the daemon would find
/// it. Picking it from the frame keeps the test independent of what the
/// fixture prints.
fn word_on_screen(surface: &PaneSurfaceFrame) -> String {
    let width = usize::from(surface.frame.width);
    let cells = &surface.frame.cells;
    let mut longest = String::new();
    let mut word = String::new();
    for cell in cells {
        if cell.skip {
            continue;
        }
        for ch in cell.symbol.chars() {
            if ch.is_alphanumeric() {
                word.push(ch);
            } else {
                if word.len() > longest.len() {
                    longest = std::mem::take(&mut word);
                } else {
                    word.clear();
                }
            }
        }
    }
    if word.len() > longest.len() {
        longest = word;
    }
    assert!(
        longest.len() >= 2,
        "no word on screen to search for (width {width})"
    );
    longest
}

#[test]
#[ignore = "searches a running Herdr session's scrollback; set PF_DESKTOP_LIVE=1"]
fn finds_a_word_that_is_on_the_screen() {
    if std::env::var("PF_DESKTOP_LIVE").ok().as_deref() != Some("1") {
        return;
    }
    let connection = connect();
    let surface = await_surface(&connection, Instant::now() + TIMEOUT);
    let pane = surface
        .panes
        .iter()
        .find(|pane| pane.focused)
        .or_else(|| surface.panes.first())
        .expect("a pane to search");
    let word = word_on_screen(&surface);

    let request = SearchRequest {
        pane_id: pane.pane_id.clone(),
        query: word.clone(),
        direction: SearchDirection::Forward,
        cursor: TextPoint { row: 0, col: 0 },
        content_revision: pane.content_revision,
        previous: None,
    };
    connection
        .handle
        .request("pane.copy_search", serde_json::to_value(&request).unwrap())
        .expect("send pane.copy_search");

    let deadline = Instant::now() + TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(!remaining.is_zero(), "pane.copy_search never answered");
        match connection.events.recv_timeout(remaining) {
            Ok(ClientEvent::Response {
                method, response, ..
            }) if method == "pane.copy_search" => match search::parse_response(&response) {
                SearchOutcome::Found(result) => {
                    assert_eq!(result.pane_id, pane.pane_id);
                    assert!(result.total >= 1, "the word came from this screen");
                    assert!(!result.matches.is_empty());
                    return;
                }
                // A pane that printed between the surface and the request is
                // legitimate; the window retries with the newer revision.
                SearchOutcome::Stale => return,
                SearchOutcome::Failed { code, message } => {
                    panic!("pane.copy_search failed: {code}: {message}")
                }
            },
            Ok(ClientEvent::Disconnected(reason)) => panic!("disconnected: {reason}"),
            Ok(_) => {}
            Err(error) => panic!("pane.copy_search never answered: {error}"),
        }
    }
}
