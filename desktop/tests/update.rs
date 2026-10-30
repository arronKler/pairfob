//! The desktop updater against a local release channel: version ordering,
//! manifest validation, and replacing a fake executable.

use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use pairfob_desktop::update::{self, install_with_current, Manifest, Version, MAX_ARTIFACT};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

struct Channel {
    base: String,
    address: SocketAddr,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Channel {
    fn start(version: &str, target: &str, artifact: Vec<u8>) -> Self {
        Self::start_with_manifest(manifest(version, target, &artifact), target, artifact)
    }

    fn start_with_manifest(manifest: String, target: &str, artifact: Vec<u8>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let artifact_path = format!("/desktop/pairfob-desktop-{target}");
        let worker = thread::spawn(move || {
            while !worker_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => serve(stream, &manifest, &artifact_path, &artifact),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => return,
                }
            }
        });
        Self {
            base: format!("http://{address}/desktop"),
            address,
            stop,
            worker: Some(worker),
        }
    }
}

impl Drop for Channel {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect(self.address);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn serve(mut stream: TcpStream, manifest: &str, artifact_path: &str, artifact: &[u8]) {
    let mut request = [0u8; 4096];
    let read = stream.read(&mut request).unwrap_or(0);
    let request = String::from_utf8_lossy(&request[..read]);
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("");
    let (status, body): (&str, &[u8]) = if path == "/desktop/release.json" {
        ("200 OK", manifest.as_bytes())
    } else if path == artifact_path {
        ("200 OK", artifact)
    } else {
        ("404 Not Found", b"")
    };
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
}

fn manifest(version: &str, target: &str, artifact: &[u8]) -> String {
    let sha256 = format!("{:x}", Sha256::digest(artifact));
    format!(
        r#"{{"schema":1,"version":"{version}","commit":"{}","files":{{"{target}":{{"sha256":"{sha256}","size":{}}}}}}}"#,
        "a".repeat(40),
        artifact.len()
    )
}

fn fake_binary(version: &str) -> Vec<u8> {
    format!("#!/bin/sh\necho 'pairfob-desktop {version}'\n").into_bytes()
}

fn executable(path: &Path) -> PathBuf {
    let path = path.to_path_buf();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path
}

fn directory() -> TempDir {
    TempDir::new().unwrap()
}

#[test]
fn a_newer_manifest_installs_and_reports_the_published_version() {
    let dir = directory();
    let dest = executable(&{
        let path = dir.path().join("pairfob-desktop");
        fs::write(&path, fake_binary("v0.1.0")).unwrap();
        path
    });
    let artifact = fake_binary("v0.2.0");
    let channel = Channel::start("v0.2.0", "darwin-arm64", artifact.clone());

    let updated = install_with_current(&channel.base, &dest, "darwin-arm64", "v0.1.0").unwrap();

    assert_eq!(updated.version, "v0.2.0");
    assert_eq!(fs::read(&dest).unwrap(), artifact);
    assert!(fs::metadata(&dest).unwrap().permissions().mode() & 0o111 != 0);
    let output = std::process::Command::new(&dest)
        .arg("--version")
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&output.stdout).contains("v0.2.0"));
    let backup = dir.path().join(".pairfob-desktop.update-backup");
    assert_eq!(fs::read(backup).unwrap(), fake_binary("v0.1.0"));
}

#[test]
fn a_hash_mismatch_keeps_the_previous_build() {
    let dir = directory();
    let old = fake_binary("v0.1.0");
    let dest = executable(&{
        let path = dir.path().join("pairfob-desktop");
        fs::write(&path, &old).unwrap();
        path
    });
    let artifact = fake_binary("v0.2.0");
    let mut manifest = manifest("v0.2.0", "darwin-arm64", &artifact);
    manifest = manifest.replace(&format!("{:x}", Sha256::digest(&artifact)), &"b".repeat(64));
    let channel = Channel::start_with_manifest(manifest, "darwin-arm64", artifact);

    let error = install_with_current(&channel.base, &dest, "darwin-arm64", "v0.1.0").unwrap_err();

    assert!(error.contains("SHA-256"), "{error}");
    assert_eq!(fs::read(&dest).unwrap(), old);
}

#[test]
fn a_build_that_does_not_start_is_rolled_back() {
    let dir = directory();
    let old = fake_binary("v0.1.0");
    let dest = executable(&{
        let path = dir.path().join("pairfob-desktop");
        fs::write(&path, &old).unwrap();
        path
    });
    let channel = Channel::start("v0.2.0", "darwin-arm64", fake_binary("v9.9.9"));

    let error = install_with_current(&channel.base, &dest, "darwin-arm64", "v0.1.0").unwrap_err();

    assert!(error.contains("previous build was restored"), "{error}");
    assert_eq!(fs::read(&dest).unwrap(), old);
    assert!(!dir.path().join(".pairfob-desktop.update-backup").exists());
}

#[test]
fn a_manifest_that_is_not_newer_is_refused() {
    let dir = directory();
    let old = fake_binary("v0.3.0");
    let dest = executable(&{
        let path = dir.path().join("pairfob-desktop");
        fs::write(&path, &old).unwrap();
        path
    });
    let channel = Channel::start("v0.2.0", "darwin-arm64", fake_binary("v0.2.0"));

    let error = install_with_current(&channel.base, &dest, "darwin-arm64", "v0.3.0").unwrap_err();

    assert!(error.contains("not newer"), "{error}");
    assert_eq!(fs::read(&dest).unwrap(), old);
}

#[test]
fn fetching_a_manifest_rejects_an_unknown_schema() {
    let error = Manifest::parse(
        br#"{"schema":2,"version":"v1.0.0","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","files":{"darwin-arm64":{"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":1}}}"#,
    )
    .unwrap_err();
    assert!(error.contains("schema"), "{error}");
}

#[test]
fn manifest_validation_rejects_unknown_targets_and_oversized_files() {
    for manifest in [
        r#"{"schema":1,"version":"v1.0.0","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","files":{"windows-amd64":{"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":1}}}"#.to_owned(),
        format!(
            r#"{{"schema":1,"version":"v1.0.0","commit":"{}","files":{{"linux-amd64":{{"sha256":"{}","size":{}}}}}}}"#,
            "a".repeat(40),
            "a".repeat(64),
            MAX_ARTIFACT + 1
        ),
        r#"{"schema":1,"version":"1.0","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","files":{"linux-amd64":{"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":1}}}"#.to_owned(),
        r#"{"schema":1,"version":"v1.0.0","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","files":{}}"#.to_owned(),
    ] {
        assert!(Manifest::parse(manifest.as_bytes()).is_err(), "{manifest}");
    }
}

#[test]
fn versions_need_three_parts_and_order_numerically() {
    assert_eq!(Version::parse("v1.2.3").unwrap().major, 1);
    assert_eq!(Version::parse(" 1.2.3 ").unwrap().patch, 3);
    assert!(Version::parse("1.2").is_none());
    assert!(Version::parse("1.2.3.4").is_none());
    assert!(Version::parse("v1.x.3").is_none());
    assert!(Version::parse("v1.10.0") > Version::parse("v1.9.0"));
    assert_eq!(Version::parse("v0.2.0").unwrap().to_string(), "0.2.0");
}

#[test]
fn the_update_base_is_https_or_loopback_only() {
    assert!(update::allowed_base("https://dl.pairfob.com/desktop"));
    assert!(update::allowed_base("http://127.0.0.1:8080/desktop"));
    assert!(update::allowed_base("http://localhost:8080/desktop"));
    assert!(update::allowed_base("http://[::1]:8080/desktop"));
    assert!(!update::allowed_base("http://dl.pairfob.com/desktop"));
    assert!(!update::allowed_base("https://user@dl.pairfob.com/desktop"));
    assert!(!update::allowed_base("https://dl.pairfob.com/desktop?x=1"));
    assert!(!update::allowed_base("https://dl.pairfob.com/../desktop"));
    assert!(!update::allowed_base("ftp://dl.pairfob.com/desktop"));
    assert!(!update::allowed_base(""));
}
