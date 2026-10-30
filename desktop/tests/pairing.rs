#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant, SystemTime};

use crossbeam_channel::RecvTimeoutError;
use pairfob_desktop::pairing::{Offer, OfferEvent, OfferSession};
use tempfile::TempDir;

// Generous: these fakes start a shell, and parallel test runs can starve it.
const WAIT: Duration = Duration::from_secs(30);

fn fake(dir: &TempDir, body: &str) -> PathBuf {
    let path = dir.path().join("pairfob");
    let body = body.replace("@DIR@", &dir.path().display().to_string());
    fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write fake pairfob");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).expect("chmod fake");
    path
}

fn next(events: &crossbeam_channel::Receiver<OfferEvent>) -> OfferEvent {
    events.recv_timeout(WAIT).expect("an offer event")
}

fn assert_stream_closed(events: &crossbeam_channel::Receiver<OfferEvent>) {
    assert_eq!(
        events.recv_timeout(WAIT),
        Err(RecvTimeoutError::Disconnected),
        "the reader must drop the channel when the child is gone"
    );
}

/// The controller reaps before dropping the sender, so an empty channel means
/// there is no zombie left behind.
fn process_state(pid: &str) -> String {
    let output = Command::new("ps")
        .args(["-o", "stat=", "-p", pid])
        .output()
        .expect("run ps");
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn read_pid(path: &Path) -> String {
    fs::read_to_string(path)
        .expect("fake wrote its pid")
        .trim()
        .to_owned()
}

/// Under a loaded machine the shell may not have started before the cancel
/// grace expires; giving up then would kill it before it could react to stdin.
fn wait_started(path: &Path) {
    let deadline = Instant::now() + WAIT;
    while !path.exists() {
        assert!(Instant::now() < deadline, "the fake never started");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn stream_reports_fields_in_order_then_reaps() {
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pid");
    let script = fake(
        &dir,
        &format!(
            "echo $$ > '{}'\n\
             printf '%s\\n' '{{\"event\":\"offer\",\"pair_ref\":\"ref-01\",\"pair_url\":\"https://pairfob.com/p#c\",\"code\":\"ABCD-EFGH\",\"pair_loc\":\"studio\",\"expires_at\":\"2030-01-02T03:04:05Z\",\"host\":\"workstation\"}}'\n\
             printf '%s\\n' '{{\"event\":\"ready\",\"pair_ref\":\"ref-01\"}}'\n\
             printf '%s\\n' '{{\"event\":\"paired\",\"pair_ref\":\"ref-01\"}}'",
            pid_file.display()
        ),
    );

    let session = OfferSession::start(&script).unwrap();
    let events = session.events();

    match next(&events) {
        OfferEvent::Offer(offer) => {
            assert_eq!(offer.reference, "ref-01");
            assert_eq!(offer.url, "https://pairfob.com/p#c");
            assert_eq!(offer.code, "ABCD-EFGH");
            assert_eq!(offer.location.as_deref(), Some("studio"));
            assert_eq!(offer.host.as_deref(), Some("workstation"));
            // 2030-01-02T03:04:05Z
            assert_eq!(
                offer.expires_at,
                Some(SystemTime::UNIX_EPOCH + Duration::from_secs(1_893_553_445))
            );
            assert!(offer.remaining(SystemTime::UNIX_EPOCH).is_some());
        }
        other => panic!("expected the offer, got {other:?}"),
    }
    assert_eq!(next(&events), OfferEvent::Ready);
    assert_eq!(next(&events), OfferEvent::Paired);
    assert_stream_closed(&events);

    let pid = read_pid(&pid_file);
    assert_eq!(
        process_state(&pid),
        "",
        "the child must be reaped, not left as a zombie"
    );
}

#[test]
fn error_event_carries_the_child_message() {
    let dir = tempfile::tempdir().unwrap();
    let script = fake(
        &dir,
        "printf '%s\\n' '{\"event\":\"error\",\"message\":\"daemon not running\"}'\nexit 7",
    );

    let session = OfferSession::start(&script).unwrap();
    let events = session.events();

    assert_eq!(
        next(&events),
        OfferEvent::Failed("daemon not running".to_owned())
    );
    assert_stream_closed(&events);
}

#[test]
fn malformed_lines_are_skipped() {
    let dir = tempfile::tempdir().unwrap();
    let script = fake(
        &dir,
        "printf '%s\\n' 'this is not json'\n\
         printf '%s\\n' '{\"event\":\"mystery\",\"pair_ref\":\"ignored\"}'\n\
         printf '%s\\n' '{\"event\":\"offer\",\"pair_ref\":\"ref-02\",\"pair_url\":\"https://example.test/p#x\",\"code\":\"ZZZZ\"}'",
    );

    let session = OfferSession::start(&script).unwrap();
    let events = session.events();

    match next(&events) {
        OfferEvent::Offer(offer) => {
            assert_eq!(offer.reference, "ref-02");
            assert_eq!(offer.url, "https://example.test/p#x");
            assert_eq!(offer.code, "ZZZZ");
            assert_eq!(offer.location, None);
            assert_eq!(offer.host, None);
            assert_eq!(offer.expires_at, None);
        }
        other => panic!("expected the offer, got {other:?}"),
    }
    assert_stream_closed(&events);
}

#[test]
fn cancel_closes_stdin_and_reports_cancelled() {
    let dir = tempfile::tempdir().unwrap();
    let started = dir.path().join("started");
    let marker = dir.path().join("stdin-closed");
    let script = fake(
        &dir,
        &format!(
            "echo ready > '{}'\ncat > /dev/null\n: > '{}'",
            started.display(),
            marker.display()
        ),
    );

    let session = OfferSession::start(&script).unwrap();
    let events = session.events();

    wait_started(&started);
    session.cancel();

    assert!(
        marker.exists(),
        "closing stdin must let the child finish and write its marker"
    );
    assert_eq!(next(&events), OfferEvent::Cancelled);
    assert_stream_closed(&events);
}

#[test]
fn cancel_reports_cancelled_even_when_the_child_errors_on_close() {
    // The real CLI answers a stdin close with an error line.
    let dir = tempfile::tempdir().unwrap();
    let started = dir.path().join("started");
    let script = fake(
        &dir,
        &format!(
            "echo ready > '{}'\ncat > /dev/null\n\
             printf '%s\\n' '{{\"event\":\"error\",\"message\":\"pairing cancelled\"}}'\nexit 1",
            started.display()
        ),
    );

    let session = OfferSession::start(&script).unwrap();
    let events = session.events();

    wait_started(&started);
    session.cancel();

    assert_eq!(
        next(&events),
        OfferEvent::Failed("pairing cancelled".to_owned())
    );
    assert_eq!(next(&events), OfferEvent::Cancelled);
    assert_stream_closed(&events);
}

fn sample_offer(url: &str, code: &str) -> Offer {
    Offer {
        reference: "ref".to_owned(),
        url: url.to_owned(),
        code: code.to_owned(),
        location: None,
        host: None,
        expires_at: None,
    }
}

#[test]
fn qr_matrix_has_quiet_zone_and_finder_pattern() {
    let offer = sample_offer("https://pairfob.com/p#c/ABCD", "ABCD");
    let matrix = offer.qr_matrix().unwrap();

    let symbol = qrcode::QrCode::new(offer.url.as_bytes()).unwrap();
    assert_eq!(matrix.width, symbol.width() + 8);

    assert!(!matrix.get(0, 0), "the quiet zone must start light");
    assert!(!matrix.get(matrix.width - 1, matrix.width - 1));

    // The top-left finder is a 7x7 symbol at the inner origin.
    for dy in 0..7 {
        for dx in 0..7 {
            let expected = dx == 0
                || dx == 6
                || dy == 0
                || dy == 6
                || ((2..=4).contains(&dx) && (2..=4).contains(&dy));
            assert_eq!(
                matrix.get(4 + dx, 4 + dy),
                expected,
                "finder cell ({dx},{dy})"
            );
        }
    }
}

#[test]
fn different_urls_give_different_matrices() {
    let first = sample_offer("https://pairfob.com/p#c/ABCD", "ABCD")
        .qr_matrix()
        .unwrap();
    let second = sample_offer("https://pairfob.com/p#c/WXYZ", "WXYZ")
        .qr_matrix()
        .unwrap();
    assert_ne!(first, second);
}

#[test]
fn qr_falls_back_to_the_code_when_the_url_is_missing() {
    let offer = sample_offer("", "ABCD-EFGH");
    let matrix = offer.qr_matrix().unwrap();
    let symbol = qrcode::QrCode::new(offer.code.as_bytes()).unwrap();
    assert_eq!(matrix.width, symbol.width() + 8);

    assert!(sample_offer("", "").qr_matrix().is_err());
}
