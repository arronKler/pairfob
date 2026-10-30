//! The devices paired to this computer, read from the local Pairfob CLI.
//!
//! The window never opens the admin socket itself; `pairfob devices --json` is
//! the one seam, so the CLI's device list and the identity rules behind it stay
//! in one place.

use std::path::Path;
use std::time::{Duration, SystemTime};

use serde::Deserialize;

use crate::process::{self, CommandOutput};

const TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Device {
    pub id: String,
    pub label: String,
    pub created: i64,
    pub last_seen: i64,
    /// `Some(true)` is the only connected state. `None` comes from a daemon
    /// that predates the field, so the row must not claim the device is
    /// offline.
    pub connected: Option<bool>,
}

impl Device {
    pub fn is_connected(&self) -> bool {
        self.connected == Some(true)
    }
}

#[derive(Deserialize)]
struct WireList {
    devices: Vec<WireDevice>,
}

#[derive(Deserialize)]
struct WireDevice {
    device_id: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    created_at: i64,
    #[serde(default)]
    last_seen: i64,
    #[serde(default)]
    connected: Option<bool>,
}

pub fn list(pairfob: &Path) -> Result<Vec<Device>, String> {
    let output = process::run(pairfob, &["devices", "--json"], TIMEOUT)
        .map_err(|error| error.to_string())?;
    if !output.ok() {
        return Err(failure(&output));
    }
    parse_list(&output.stdout)
}

pub fn revoke(pairfob: &Path, id: &str) -> Result<(), String> {
    let output = process::run(pairfob, &["devices", "revoke", id], TIMEOUT)
        .map_err(|error| error.to_string())?;
    if output.ok() {
        Ok(())
    } else {
        Err(failure(&output))
    }
}

pub fn parse_list(stdout: &str) -> Result<Vec<Device>, String> {
    let wire: WireList = serde_json::from_str(stdout.trim())
        .map_err(|_| "pairfob returned an invalid device list.".to_owned())?;
    Ok(wire
        .devices
        .into_iter()
        .map(|device| Device {
            id: device.device_id,
            label: device.label,
            created: device.created_at,
            last_seen: device.last_seen,
            connected: device.connected,
        })
        .collect())
}

pub fn sort(devices: &mut [Device]) {
    devices.sort_by(|a, b| {
        b.is_connected()
            .cmp(&a.is_connected())
            .then_with(|| b.last_seen.cmp(&a.last_seen))
            .then_with(|| a.label.to_lowercase().cmp(&b.label.to_lowercase()))
            .then_with(|| a.id.cmp(&b.id))
    });
}

pub fn last_seen_phrase(last_seen: i64, connected: Option<bool>, now: SystemTime) -> String {
    if connected == Some(true) {
        return "connected now".to_owned();
    }
    ago_phrase(last_seen, now)
}

pub fn paired_phrase(created: i64, now: SystemTime) -> String {
    format!("paired {}", ago_phrase(created, now))
}

fn ago_phrase(unix: i64, now: SystemTime) -> String {
    if unix <= 0 {
        return "never seen".to_owned();
    }
    let seen = SystemTime::UNIX_EPOCH + Duration::from_secs(unix as u64);
    let delta = now.duration_since(seen).unwrap_or(Duration::ZERO);
    if delta < Duration::from_secs(2 * 60) {
        return "just now".to_owned();
    }
    if delta < Duration::from_secs(60 * 60) {
        return format!("{} min ago", delta.as_secs() / 60);
    }
    if delta < Duration::from_secs(36 * 60 * 60) {
        let hours = delta.as_secs() / (60 * 60);
        if hours == 1 {
            return "1 hour ago".to_owned();
        }
        return format!("{hours} hours ago");
    }
    let days = delta.as_secs() / (24 * 60 * 60);
    if days == 1 {
        "yesterday".to_owned()
    } else {
        format!("{days} days ago")
    }
}

/// A failed command is one line. The CLI logs through `log.Fatal`, whose
/// timestamp prefix is noise in the drawer.
fn failure(output: &CommandOutput) -> String {
    let combined = output.combined();
    if let Some(line) = combined
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
    {
        return strip_timestamp(line).to_owned();
    }
    match output.status {
        Some(code) => format!("pairfob exited with code {code}."),
        None => "pairfob was terminated by a signal.".to_owned(),
    }
}

fn strip_timestamp(line: &str) -> &str {
    let bytes = line.as_bytes();
    let digits = |range: std::ops::Range<usize>| {
        bytes
            .get(range)
            .is_some_and(|part| part.iter().all(u8::is_ascii_digit))
    };
    let timestamp = bytes.len() >= 20
        && digits(0..4)
        && bytes[4] == b'/'
        && digits(5..7)
        && bytes[7] == b'/'
        && digits(8..10)
        && bytes[10] == b' '
        && digits(11..13)
        && bytes[13] == b':'
        && digits(14..16)
        && bytes[16] == b':'
        && digits(17..19)
        && bytes[19] == b' ';
    if timestamp {
        &line[20..]
    } else {
        line
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000)
    }

    fn at(seconds_ago: u64) -> i64 {
        1_700_000_000 - i64::try_from(seconds_ago).unwrap()
    }

    fn device(id: &str, connected: Option<bool>, last_seen: i64) -> Device {
        Device {
            id: id.to_owned(),
            label: String::new(),
            created: 0,
            last_seen,
            connected,
        }
    }

    #[test]
    fn parse_reads_the_frozen_fields() {
        let rows = parse_list(
            r#"{"devices":[
                {"device_id":"dev_a","label":"iPhone","created_at":10,"last_seen":20,"connected":true},
                {"device_id":"dev_b","created_at":5},
                {"device_id":"dev_c","created_at":6,"last_seen":7,"connected":false}
            ]}"#,
        )
        .unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].label, "iPhone");
        assert_eq!(rows[0].created, 10);
        assert_eq!(rows[0].last_seen, 20);
        assert_eq!(rows[0].connected, Some(true));
        assert!(rows[0].is_connected());
        assert_eq!(rows[1].label, "");
        assert_eq!(rows[1].last_seen, 0);
        assert_eq!(rows[1].connected, None, "an old daemon omits the field");
        assert_eq!(rows[2].connected, Some(false));
        assert!(!rows[2].is_connected());
    }

    #[test]
    fn parse_rejects_malformed_or_unwrapped_json() {
        assert!(parse_list("not json").is_err());
        assert!(parse_list("{}").is_err());
        assert!(parse_list(r#"{"devices":{}}"#).is_err());
    }

    #[test]
    fn sort_puts_connected_first_then_most_recent() {
        let mut rows = vec![
            device("dev_b", Some(false), 300),
            device("dev_a", None, 400),
            device("dev_c", Some(true), 100),
            device("dev_d", Some(true), 100),
        ];
        rows[0].label = "zebra".to_owned();
        rows[1].label = "Alpha".to_owned();
        rows[2].label = "beta".to_owned();
        rows[3].label = "Beta".to_owned();
        sort(&mut rows);
        let ids: Vec<&str> = rows.iter().map(|row| row.id.as_str()).collect();
        assert_eq!(ids, vec!["dev_c", "dev_d", "dev_a", "dev_b"]);
    }

    #[test]
    fn the_state_phrase_follows_the_ladder() {
        assert_eq!(
            last_seen_phrase(at(9_999), Some(true), now()),
            "connected now"
        );
        assert_eq!(last_seen_phrase(0, Some(false), now()), "never seen");
        assert_eq!(last_seen_phrase(0, None, now()), "never seen");
        assert_eq!(last_seen_phrase(at(30), Some(false), now()), "just now");
        assert_eq!(last_seen_phrase(at(30), None, now()), "just now");
        assert_eq!(last_seen_phrase(at(5 * 60), None, now()), "5 min ago");
        assert_eq!(
            last_seen_phrase(at(60 * 60), Some(false), now()),
            "1 hour ago"
        );
        assert_eq!(
            last_seen_phrase(at(5 * 60 * 60), None, now()),
            "5 hours ago"
        );
        assert_eq!(
            last_seen_phrase(at(37 * 60 * 60), Some(false), now()),
            "yesterday"
        );
        assert_eq!(
            last_seen_phrase(at(3 * 24 * 60 * 60), None, now()),
            "3 days ago"
        );
    }

    #[test]
    fn the_paired_phrase_prefixes_the_same_ladder() {
        assert_eq!(
            paired_phrase(at(2 * 24 * 60 * 60), now()),
            "paired 2 days ago"
        );
        assert_eq!(paired_phrase(at(30), now()), "paired just now");
    }

    #[test]
    fn a_log_timestamp_is_stripped_from_one_failure_line() {
        assert_eq!(
            strip_timestamp("2026/10/30 12:34:56 Pairfob isn't running."),
            "Pairfob isn't running."
        );
        assert_eq!(
            strip_timestamp("Pairfob isn't running."),
            "Pairfob isn't running."
        );
        assert_eq!(strip_timestamp("2026/10/30 Pairfob"), "2026/10/30 Pairfob");
    }

    #[test]
    fn a_failure_without_output_reports_the_exit_status() {
        let output = CommandOutput {
            status: Some(1),
            stdout: String::new(),
            stderr: String::new(),
        };
        assert_eq!(failure(&output), "pairfob exited with code 1.");
    }
}
