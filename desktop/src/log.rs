//! The desktop's own log file, so a diagnostics report can carry what led to a
//! failure.
//!
//! Never pass pairing codes, offer URLs, QR payloads, keys, or clipboard
//! contents to [`info`], [`warn`], or [`error`].

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, TryLockError};

use time::OffsetDateTime;

const FILE: &str = "pairfob-desktop.log";
/// Rotate before a line would take the file past this size.
const ROTATE_AT: u64 = 2 * 1024 * 1024;
/// `recent` reads at most this much from the end of the file.
const TAIL_BYTES: u64 = 64 * 1024;

struct LogFile {
    file: File,
    path: PathBuf,
    written: u64,
}

static LOG: Mutex<Option<LogFile>> = Mutex::new(None);

/// Opens the log file and installs a panic hook that records the panic before
/// the default hook prints it. A log that cannot be opened disables itself
/// silently; the app keeps working.
pub fn init() {
    if let Some(log) = path().as_deref().and_then(open) {
        *LOG.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(log);
    }
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic| {
        let location = panic
            .location()
            .map(|location| format!("{}:{}", location.file(), location.line()))
            .unwrap_or_else(|| "unknown location".to_owned());
        let message = match panic.payload().downcast_ref::<&str>() {
            Some(text) => (*text).to_owned(),
            None => panic
                .payload()
                .downcast_ref::<String>()
                .cloned()
                .unwrap_or_else(|| "unknown panic".to_owned()),
        };
        write_line("ERROR", &format!("panic at {location}: {message}"));
        default_hook(panic);
    }));
}

pub fn info(message: &str) {
    write_line("INFO", message);
}

pub fn warn(message: &str) {
    write_line("WARN", message);
}

pub fn error(message: &str) {
    write_line("ERROR", message);
}

/// The file every entry goes to, or `None` when there is no home directory.
pub fn path() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        return env_path("HOME")
            .map(|home| home.join("Library").join("Logs").join("Pairfob").join(FILE));
    }
    let state = env_path("XDG_STATE_HOME")
        .or_else(|| env_path("HOME").map(|home| home.join(".local").join("state")))?;
    Some(state.join("pairfob-desktop").join(FILE))
}

/// The newest `lines` entries of the current file, oldest first. Only the
/// last 64 KiB are read, so a long-running log stays cheap to inspect.
pub fn recent(lines: usize) -> Vec<String> {
    path()
        .map(|path| read_tail(&path, lines))
        .unwrap_or_default()
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn open(path: &Path) -> Option<LogFile> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).ok()?;
    }
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()?;
    let written = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    Some(LogFile {
        file,
        path: path.to_owned(),
        written,
    })
}

fn write_line(level: &str, message: &str) {
    let line = format_line(OffsetDateTime::now_utc(), level, message);
    // The panic hook runs while the panicking thread may still hold this
    // mutex, so a writer never waits for it and a busy lock drops the line.
    let mut state = match LOG.try_lock() {
        Ok(state) => state,
        Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
        Err(TryLockError::WouldBlock) => return,
    };
    if state
        .as_ref()
        .is_some_and(|log| exceeds_limit(log.written, line.len()))
    {
        rotate(&mut state);
    }
    let Some(log) = state.as_mut() else {
        return;
    };
    if log.file.write_all(line.as_bytes()).is_err() {
        *state = None;
        return;
    }
    log.written += line.len() as u64;
}

fn format_line(at: OffsetDateTime, level: &str, message: &str) -> String {
    let message = message.replace(['\r', '\n'], " ");
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z {level} {message}\n",
        at.year(),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
        at.second(),
    )
}

fn exceeds_limit(written: u64, incoming: usize) -> bool {
    written.saturating_add(incoming as u64) > ROTATE_AT
}

fn rotate(state: &mut Option<LogFile>) {
    let Some(log) = state.as_ref() else {
        return;
    };
    let path = log.path.clone();
    if fs::rename(&path, rotated_path(&path)).is_err() {
        return;
    }
    *state = open(&path);
}

fn rotated_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".1");
    PathBuf::from(name)
}

fn read_tail(path: &Path, lines: usize) -> Vec<String> {
    let Ok(mut file) = File::open(path) else {
        return Vec::new();
    };
    let Ok(size) = file.metadata().map(|meta| meta.len()) else {
        return Vec::new();
    };
    let start = size.saturating_sub(TAIL_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut bytes = Vec::new();
    if file.take(TAIL_BYTES).read_to_end(&mut bytes).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut entries: Vec<&str> = text.lines().collect();
    if start > 0 && !entries.is_empty() {
        // The window starts mid-line; that fragment is not an entry.
        entries.remove(0);
    }
    let first = entries.len().saturating_sub(lines);
    entries[first..]
        .iter()
        .map(|line| (*line).to_owned())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn epoch() -> OffsetDateTime {
        OffsetDateTime::from_unix_timestamp(0).unwrap()
    }

    #[test]
    fn a_line_is_utc_level_and_message_on_one_line() {
        assert_eq!(
            format_line(epoch(), "INFO", "started"),
            "1970-01-01T00:00:00Z INFO started\n"
        );
        assert_eq!(
            format_line(epoch(), "ERROR", "a\nb\r\nc"),
            "1970-01-01T00:00:00Z ERROR a b  c\n"
        );
    }

    #[test]
    fn the_rotation_threshold_fires_at_two_mebibytes() {
        assert!(!exceeds_limit(0, 1));
        assert!(!exceeds_limit(ROTATE_AT - 1, 1));
        assert!(exceeds_limit(ROTATE_AT, 1));
        assert!(exceeds_limit(ROTATE_AT - 1, 2));
        assert_eq!(
            rotated_path(Path::new("/tmp/pairfob-desktop.log")),
            PathBuf::from("/tmp/pairfob-desktop.log.1")
        );
    }

    #[test]
    fn recent_returns_the_tail_in_chronological_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.log");
        fs::write(&path, "one\ntwo\nthree\n").unwrap();
        assert_eq!(
            read_tail(&path, 2),
            vec!["two".to_owned(), "three".to_owned()]
        );
        assert!(read_tail(&path, 0).is_empty());
        assert!(read_tail(&dir.path().join("missing.log"), 3).is_empty());
    }

    #[test]
    fn a_large_file_is_read_from_the_tail_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.log");
        let text: String = (0..20_000).map(|index| format!("line {index}\n")).collect();
        fs::write(&path, text).unwrap();
        assert_eq!(read_tail(&path, 1), vec!["line 19999".to_owned()]);
    }
}
