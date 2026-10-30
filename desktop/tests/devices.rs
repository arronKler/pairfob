#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use pairfob_desktop::devices;
use tempfile::TempDir;

fn fake(dir: &TempDir, body: &str) -> PathBuf {
    let path = dir.path().join("pairfob");
    let body = body.replace("@DIR@", &dir.path().display().to_string());
    fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write fake pairfob");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).expect("chmod fake");
    path
}

#[test]
fn list_reads_the_cli_json() {
    let dir = tempfile::tempdir().unwrap();
    let script = fake(
        &dir,
        r#"printf '%s\n' '{"devices":[
            {"device_id":"dev_phone01","label":"iPhone","created_at":1700000000,"last_seen":1700000100,"connected":true},
            {"device_id":"dev_tablet02","created_at":1690000000,"last_seen":0,"connected":false},
            {"device_id":"dev_reader03","created_at":1680000000,"last_seen":1679999999}
        ]}'"#,
    );

    let rows = devices::list(&script).expect("list");
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].id, "dev_phone01");
    assert_eq!(rows[0].label, "iPhone");
    assert_eq!(rows[0].created, 1_700_000_000);
    assert_eq!(rows[0].last_seen, 1_700_000_100);
    assert_eq!(rows[0].connected, Some(true));
    assert!(rows[0].is_connected());
    assert_eq!(rows[1].id, "dev_tablet02");
    assert_eq!(rows[1].connected, Some(false));
    assert_eq!(rows[2].id, "dev_reader03");
    assert_eq!(rows[2].connected, None, "an old daemon omits the field");
}

#[test]
fn revoke_records_the_device_id() {
    let dir = tempfile::tempdir().unwrap();
    let script = fake(
        &dir,
        "printf '%s\\n' \"$@\" > '@DIR@/args'\nprintf '%s\\n' 'Forgotten.'",
    );

    devices::revoke(&script, "dev_phone01").expect("revoke");
    let args = fs::read_to_string(dir.path().join("args")).expect("fake wrote argv");
    assert_eq!(
        args.lines().collect::<Vec<_>>(),
        ["devices", "revoke", "dev_phone01"]
    );
}

#[test]
fn a_failed_list_is_one_line_without_the_log_stamp() {
    let dir = tempfile::tempdir().unwrap();
    let script = fake(
        &dir,
        "printf '%s\\n' \"2026/10/30 12:34:56 Pairfob isn't running. Start it: pairfob service start\" >&2\nexit 1",
    );

    let error = devices::list(&script).unwrap_err();
    assert_eq!(
        error,
        "Pairfob isn't running. Start it: pairfob service start"
    );
}

#[test]
fn a_failed_revoke_reports_the_cli_line() {
    let dir = tempfile::tempdir().unwrap();
    let script = fake(
        &dir,
        "printf '%s\\n' \"2026/10/30 12:34:56 no device matching that name\" >&2\nexit 3",
    );

    let error = devices::revoke(&script, "dev_gone").unwrap_err();
    assert_eq!(error, "no device matching that name");
}
