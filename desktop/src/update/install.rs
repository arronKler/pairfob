//! Fetching, checking and replacing the executable. Every network call goes
//! through `curl`, which the install script already requires; the bytes are
//! only trusted after the SHA-256 in the manifest matches.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

use super::manifest::{File, Manifest};
use super::version::Version;
use super::VERSION;

const MANIFEST_LIMIT: u64 = 1 << 20;
const MANIFEST_TIMEOUT_SECONDS: u64 = 20;
const ARTIFACT_TIMEOUT_SECONDS: u64 = 300;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Updated {
    pub version: String,
    pub destination: PathBuf,
}

/// The download base is HTTPS, or plain HTTP only on the loopback interface.
/// It may carry a path (`https://dl.pairfob.com/desktop`), never credentials,
/// a query or a fragment.
pub fn allowed_base(raw: &str) -> bool {
    let raw = raw.trim().trim_end_matches('/');
    if raw.is_empty()
        || raw.contains('?')
        || raw.contains('#')
        || raw.contains('@')
        || raw.contains(char::is_whitespace)
        || raw.split('/').any(|part| part == "." || part == "..")
    {
        return false;
    }
    if let Some(rest) = raw.strip_prefix("https://") {
        return valid_authority(rest);
    }
    if let Some(rest) = raw.strip_prefix("http://") {
        return loopback_host(rest);
    }
    false
}

fn valid_authority(rest: &str) -> bool {
    let authority = rest.split('/').next().unwrap_or("");
    !authority.is_empty() && !authority.starts_with(':')
}

fn loopback_host(rest: &str) -> bool {
    let authority = rest.split('/').next().unwrap_or("");
    let host = if let Some(inside) = authority.strip_prefix('[') {
        inside.split(']').next().unwrap_or("")
    } else {
        authority.split(':').next().unwrap_or("")
    };
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}

pub fn fetch_manifest(base: &str) -> Result<Manifest, String> {
    let text = curl_text(
        &format!("{base}/release.json"),
        MANIFEST_LIMIT,
        MANIFEST_TIMEOUT_SECONDS,
    )?;
    Manifest::parse(text.as_bytes())
}

/// The executable to replace, with symlinks resolved so an installed link keeps
/// pointing at the file that was actually updated.
pub fn current_executable() -> Result<PathBuf, String> {
    let path =
        std::env::current_exe().map_err(|error| format!("could not find Pairfob: {error}"))?;
    Ok(fs::canonicalize(&path).unwrap_or(path))
}

/// Download `target`, verify it, replace `dest`, and check that the new binary
/// runs and reports the manifest version. The previous executable is kept
/// beside it until the next update, so a failed check can restore it.
pub fn install(base: &str, dest: &Path, target: &str) -> Result<Updated, String> {
    install_with_current(base, dest, target, VERSION)
}

/// The same install with the running version supplied, so a test does not
/// depend on the version this test binary was built with.
pub fn install_with_current(
    base: &str,
    dest: &Path,
    target: &str,
    current: &str,
) -> Result<Updated, String> {
    let manifest = fetch_manifest(base)?;
    let remote = manifest
        .version()
        .ok_or_else(|| "release manifest has no version".to_owned())?;
    if let Some(running) = Version::parse(current) {
        if remote <= running {
            return Err(format!(
                "{} is not newer than the running {current}",
                manifest.version
            ));
        }
    }
    let file = manifest
        .file(target)
        .ok_or_else(|| format!("no desktop build is published for {target}"))?;
    let name = format!("pairfob-desktop-{target}");
    let url = format!("{base}/{name}");
    let temporary = temporary_path(dest);
    let result = download_and_replace(&url, file, &manifest.version, &temporary, dest);
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    Ok(Updated {
        version: manifest.version,
        destination: dest.to_owned(),
    })
}

fn download_and_replace(
    url: &str,
    file: &File,
    version: &str,
    temporary: &Path,
    dest: &Path,
) -> Result<(), String> {
    let parent = dest
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", dest.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("could not write next to {}: {error}", dest.display()))?;
    curl(url, file.size, ARTIFACT_TIMEOUT_SECONDS, Some(temporary))?;
    let metadata = fs::metadata(temporary)
        .map_err(|error| format!("could not read the downloaded build: {error}"))?;
    if metadata.len() != file.size {
        return Err("the downloaded build has the wrong size".into());
    }
    let digest = sha256_file(temporary)?;
    if digest != file.sha256 {
        return Err("the downloaded build failed SHA-256 verification".into());
    }
    set_executable(temporary)?;
    replace(temporary, dest)?;
    if let Err(error) = verify_version(dest, version) {
        let backup = backup_path(dest);
        let _ = fs::remove_file(dest);
        if backup.exists() {
            restore(&backup, dest);
            return Err(format!("{error}; the previous build was restored"));
        }
        return Err(error);
    }
    Ok(())
}

fn replace(temporary: &Path, dest: &Path) -> Result<(), String> {
    let backup = backup_path(dest);
    if backup.exists() {
        let _ = fs::remove_file(&backup);
    }
    if dest.exists() {
        fs::rename(dest, &backup).map_err(|error| {
            format!(
                "could not move the current build aside at {}: {error}",
                dest.display()
            )
        })?;
    }
    if let Err(error) = fs::rename(temporary, dest) {
        restore(&backup, dest);
        return Err(format!(
            "could not install the new build at {}: {error}",
            dest.display()
        ));
    }
    Ok(())
}

fn backup_path(dest: &Path) -> PathBuf {
    let name = dest
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("pairfob-desktop");
    dest.with_file_name(format!(".{name}.update-backup"))
}

fn restore(backup: &Path, dest: &Path) {
    if backup.exists() {
        let _ = fs::rename(backup, dest);
    }
}

fn verify_version(dest: &Path, want: &str) -> Result<(), String> {
    let output = Command::new(dest)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("the new build did not run: {error}"))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let got = text.split_whitespace().last().unwrap_or("");
    if output.status.success() && Version::parse(got) == Version::parse(want) {
        return Ok(());
    }
    Err(format!("the new build reported {got:?}, expected {want}"))
}

pub fn relaunch(dest: &Path) -> Result<(), String> {
    Command::new(dest)
        .args(std::env::args_os().skip(1))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("could not start the updated build: {error}"))
}

fn temporary_path(dest: &Path) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    let name = dest
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("pairfob-desktop");
    dest.with_file_name(format!(".{name}.update-{}-{stamp}", std::process::id()))
}

fn curl_text(url: &str, limit: u64, timeout_seconds: u64) -> Result<String, String> {
    let output = curl(url, limit, timeout_seconds, None)?;
    String::from_utf8(output.stdout).map_err(|_| "the release metadata is not UTF-8".into())
}

fn curl(
    url: &str,
    limit: u64,
    timeout_seconds: u64,
    output_path: Option<&Path>,
) -> Result<std::process::Output, String> {
    let mut command = Command::new("curl");
    command
        .arg("--fail")
        .arg("--silent")
        .arg("--show-error")
        .arg("--location")
        .arg("--connect-timeout")
        .arg("10")
        .arg("--max-time")
        .arg(timeout_seconds.to_string())
        .arg("--max-filesize")
        .arg(limit.to_string());
    if url.starts_with("https://") {
        command.arg("--proto-redir").arg("=https");
    }
    if let Some(path) = output_path {
        command.arg("--output").arg(path);
    }
    command.arg("--url").arg(url);
    let output = command
        .output()
        .map_err(|error| format!("curl is required to update Pairfob Desktop: {error}"))?;
    if output.status.success() {
        return Ok(output);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail: String = stderr.trim().chars().take(400).collect();
    Err(format!(
        "could not download {url}: {}",
        if detail.is_empty() {
            output.status.to_string()
        } else {
            detail
        }
    ))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("could not open the downloaded build: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("could not read the downloaded build: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(unix)]
fn set_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
        .map_err(|error| format!("could not make the downloaded build executable: {error}"))
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}
