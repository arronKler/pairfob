//! The desktop update channel. A background thread checks the release manifest
//! at launch and every six hours; nothing is downloaded or replaced until the
//! user asks for it. The daemon and `pairfob-chat` have their own updaters.

mod install;
mod manifest;
mod version;

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub use install::{
    allowed_base, install as install_build, install_with_current, relaunch, Updated,
};
pub use manifest::{host_target, File, Manifest, MAX_ARTIFACT, TARGETS};
pub use version::Version;

pub const DEFAULT_BASE: &str = "https://dl.pairfob.com/desktop";
pub const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
pub const RETRY_EVERY: Duration = Duration::from_secs(5 * 60);

/// The version compiled into this build. Release builds set
/// `PAIRFOB_DESKTOP_VERSION`; a local `cargo run` reports the crate version.
pub const VERSION: &str = match option_env!("PAIRFOB_DESKTOP_VERSION") {
    Some(value) => value,
    None => env!("CARGO_PKG_VERSION"),
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Checking,
    UpToDate,
    Available,
    /// The channel publishes no build for this OS and architecture.
    Unsupported,
    Downloading,
    Restarting,
    Failed(String),
    Disabled,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub current: String,
    pub latest: Option<String>,
    pub phase: Phase,
    pub revision: u64,
}

struct Shared {
    snapshot: Snapshot,
}

enum Command {
    Check,
    Install,
}

/// The window's handle to the background checker. Dropping it stops the
/// thread once the current request returns.
pub struct Updater {
    shared: Arc<Mutex<Shared>>,
    commands: Sender<Command>,
}

impl Updater {
    pub fn start() -> Self {
        let (commands, receiver) = mpsc::channel();
        let shared = Arc::new(Mutex::new(Shared {
            snapshot: Snapshot {
                current: VERSION.to_owned(),
                latest: None,
                phase: Phase::Idle,
                revision: 0,
            },
        }));
        if updates_disabled() {
            set(&shared, Phase::Disabled, None);
            return Self { shared, commands };
        }
        let base = match update_base() {
            Ok(base) => base,
            Err(error) => {
                set(&shared, Phase::Failed(error), None);
                return Self { shared, commands };
            }
        };
        let worker_shared = Arc::clone(&shared);
        if let Err(error) = thread::Builder::new()
            .name("pairfob-desktop-update".into())
            .spawn(move || run(receiver, worker_shared, base))
        {
            set(
                &shared,
                Phase::Failed(format!("could not start the update check: {error}")),
                None,
            );
        }
        Self { shared, commands }
    }

    pub fn snapshot(&self) -> Snapshot {
        read(&self.shared)
    }

    pub fn check_now(&self) {
        let _ = self.commands.send(Command::Check);
    }

    pub fn install_now(&self) {
        let _ = self.commands.send(Command::Install);
    }

    /// A still image of a phase for the screenshot harness. Never used by a
    /// normal window.
    #[cfg(feature = "shot")]
    pub fn fixture(&self, value: &str) {
        let (phase, latest) = match value {
            "available" => (Phase::Available, Some("v0.2.0".to_owned())),
            "up-to-date" => (Phase::UpToDate, Some(VERSION.to_owned())),
            "failed" => (
                Phase::Failed("Could not reach dl.pairfob.com.".to_owned()),
                None,
            ),
            _ => (Phase::Idle, None),
        };
        set(&self.shared, phase, latest);
    }
}

fn run(receiver: Receiver<Command>, shared: Arc<Mutex<Shared>>, base: String) {
    let mut next = Instant::now();
    loop {
        if Instant::now() >= next {
            next = Instant::now() + check(&shared, &base);
        }
        let wait = next.saturating_duration_since(Instant::now());
        match receiver.recv_timeout(wait) {
            Ok(Command::Check) => {
                if !busy(&shared) {
                    next = Instant::now() + check(&shared, &base);
                }
            }
            Ok(Command::Install) => {
                if installable(&shared) {
                    next = Instant::now() + install_update(&shared, &base);
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

fn check(shared: &Arc<Mutex<Shared>>, base: &str) -> Duration {
    set(shared, Phase::Checking, None);
    match install::fetch_manifest(base) {
        Ok(manifest) => match host_target() {
            Some(target) if manifest.file(target).is_some() => {
                let phase = if newer(&manifest.version) {
                    Phase::Available
                } else {
                    Phase::UpToDate
                };
                set(shared, phase, Some(manifest.version));
                CHECK_EVERY
            }
            _ => {
                set(shared, Phase::Unsupported, Some(manifest.version));
                CHECK_EVERY
            }
        },
        Err(error) => {
            set(shared, Phase::Failed(error), None);
            RETRY_EVERY
        }
    }
}

fn install_update(shared: &Arc<Mutex<Shared>>, base: &str) -> Duration {
    let Some(target) = host_target() else {
        set(shared, Phase::Unsupported, None);
        return CHECK_EVERY;
    };
    let Some(latest) = read(shared).latest else {
        return RETRY_EVERY;
    };
    set(shared, Phase::Downloading, Some(latest.clone()));
    let destination = match install::current_executable() {
        Ok(path) => path,
        Err(error) => {
            set(shared, Phase::Failed(error), Some(latest));
            return RETRY_EVERY;
        }
    };
    match install::install(base, &destination, target) {
        Ok(updated) => {
            set(shared, Phase::Restarting, Some(updated.version.clone()));
            match install::relaunch(&destination) {
                Ok(()) => CHECK_EVERY,
                Err(error) => {
                    set(
                        shared,
                        Phase::Failed(format!("Updated to {}; {error}", updated.version)),
                        Some(updated.version),
                    );
                    RETRY_EVERY
                }
            }
        }
        Err(error) => {
            set(shared, Phase::Failed(error), Some(latest));
            RETRY_EVERY
        }
    }
}

fn newer(latest: &str) -> bool {
    match (Version::parse(latest), Version::parse(VERSION)) {
        (Some(latest), Some(current)) => latest > current,
        (Some(_), None) => true,
        _ => false,
    }
}

fn busy(shared: &Arc<Mutex<Shared>>) -> bool {
    matches!(
        read(shared).phase,
        Phase::Checking | Phase::Downloading | Phase::Restarting
    )
}

/// An available update, or a previous install attempt that failed after the
/// check succeeded. The drawer's retry action uses the same command.
fn installable(shared: &Arc<Mutex<Shared>>) -> bool {
    let snapshot = read(shared);
    matches!(snapshot.phase, Phase::Available)
        || (matches!(snapshot.phase, Phase::Failed(_)) && snapshot.latest.is_some())
}

fn update_base() -> Result<String, String> {
    let raw =
        std::env::var("PAIRFOB_DESKTOP_UPDATE_BASE").unwrap_or_else(|_| DEFAULT_BASE.to_owned());
    let base = raw.trim().trim_end_matches('/').to_owned();
    if !allowed_base(&base) {
        return Err("the update base must be an HTTPS origin (HTTP only on loopback)".into());
    }
    Ok(base)
}

fn updates_disabled() -> bool {
    match std::env::var("PAIRFOB_DESKTOP_UPDATE") {
        Ok(value) => matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "0" | "off" | "false" | "no"
        ),
        Err(_) => false,
    }
}

fn read(shared: &Arc<Mutex<Shared>>) -> Snapshot {
    shared
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .snapshot
        .clone()
}

fn set(shared: &Arc<Mutex<Shared>>, phase: Phase, latest: Option<String>) {
    let mut shared = shared
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    shared.snapshot.phase = phase;
    shared.snapshot.latest = latest;
    shared.snapshot.revision = shared.snapshot.revision.wrapping_add(1);
}
