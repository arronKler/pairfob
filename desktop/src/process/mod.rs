//! Finding Pairfob and Herdr, asking them how they are, and starting what is
//! missing. No network here: every answer comes from a local process.

use std::ffi::OsStr;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use crate::herdr::ConnectTarget;

pub mod sessions;

const PAIRFOB: &str = "pairfob";
const HERDR: &str = "herdr";
const DOCTOR_TIMEOUT: Duration = Duration::from_secs(30);
const SETUP_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const SERVICE_TIMEOUT: Duration = Duration::from_secs(60);
const START_TIMEOUT: Duration = Duration::from_secs(10);
const SOCKET_POLL: Duration = Duration::from_millis(50);
const RUN_POLL: Duration = Duration::from_millis(10);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tools {
    pub pairfob: PathBuf,
    pub herdr: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandOutput {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl CommandOutput {
    pub fn ok(&self) -> bool {
        self.status == Some(0)
    }

    pub fn combined(&self) -> String {
        let mut text = self.stdout.trim_end().to_owned();
        let stderr = self.stderr.trim_end();
        if !stderr.is_empty() {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(stderr);
        }
        text
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ProcessError {
    #[error("could not run {program}: {detail}")]
    Spawn { program: String, detail: String },
    #[error("{0} did not finish within {1:?}")]
    Timeout(String, Duration),
    #[error("{0}")]
    Message(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServiceAction {
    Start,
    Restart,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Health {
    /// Pairfob's own checklist passed: installed, running, Herdr ready.
    pub ok: bool,
    /// Herdr answered, so the desktop can attach.
    pub herdr_ready: bool,
    pub report: String,
}

/// Where the desktop looks for the two programs, in order: a bundled sidecar
/// beside this executable, then the login `PATH`, then the usual install
/// directories.
pub fn detect() -> Option<Tools> {
    let exe = std::env::current_exe().ok();
    let path_var = std::env::var_os("PATH");
    let home = std::env::var_os("HOME").map(PathBuf::from);
    detect_with(
        exe.as_deref().and_then(Path::parent),
        path_var.as_deref(),
        home.as_deref(),
        &[],
    )
}

/// The same search, with its inputs passed in so the order can be tested.
pub fn detect_with(
    exe_dir: Option<&Path>,
    path_var: Option<&OsStr>,
    home: Option<&Path>,
    extra: &[PathBuf],
) -> Option<Tools> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(dir) = exe_dir {
        dirs.push(dir.to_owned());
    }
    if let Some(path_var) = path_var {
        dirs.extend(std::env::split_paths(path_var));
    }
    dirs.extend(extra.iter().cloned());
    if let Some(home) = home {
        dirs.push(home.join(".local").join("bin"));
    }
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));

    let pairfob = find(&dirs, PAIRFOB)?;
    Some(Tools {
        pairfob,
        herdr: find(&dirs, HERDR),
    })
}

fn find(dirs: &[PathBuf], name: &str) -> Option<PathBuf> {
    dirs.iter()
        .map(|dir| dir.join(name))
        .find(|path| executable_file(path))
}

fn executable_file(path: &Path) -> bool {
    if !path.is_absolute() {
        return false;
    }
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

pub fn run(
    program: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<CommandOutput, ProcessError> {
    let name = program.display().to_string();
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|detail| ProcessError::Spawn {
            program: name.clone(),
            detail: detail.to_string(),
        })?;

    let stdout = child.stdout.take().map(spawn_reader);
    let stderr = child.stderr.take().map(spawn_reader);

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(detail) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(ProcessError::Message(format!(
                    "could not wait for {name}: {detail}"
                )));
            }
        }
        let remaining = timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(ProcessError::Timeout(name, timeout));
        }
        std::thread::sleep(RUN_POLL.min(remaining));
    };

    Ok(CommandOutput {
        status: status.code(),
        stdout: collected(stdout),
        stderr: collected(stderr),
    })
}

fn spawn_reader(mut pipe: impl Read + Send + 'static) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = pipe.read_to_end(&mut buffer);
        buffer
    })
}

fn collected(handle: Option<std::thread::JoinHandle<Vec<u8>>>) -> String {
    handle
        .and_then(|handle| handle.join().ok())
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default()
}

pub fn doctor(tools: &Tools) -> Result<Health, ProcessError> {
    doctor_for(tools, None)
}

/// [`doctor`] for the session the window actually attaches to: readiness is
/// the socket of that session, not the default one.
pub fn doctor_for(tools: &Tools, session: Option<&str>) -> Result<Health, ProcessError> {
    let output = run(&tools.pairfob, &["doctor"], DOCTOR_TIMEOUT)?;
    let herdr_ready =
        tools.herdr.is_some() && client_socket(session).is_some_and(|path| is_socket(&path));
    Ok(Health {
        ok: output.ok(),
        herdr_ready,
        report: output.combined(),
    })
}

pub fn setup(tools: &Tools) -> Result<CommandOutput, ProcessError> {
    run(&tools.pairfob, &["setup"], SETUP_TIMEOUT)
}

pub fn service(tools: &Tools, action: ServiceAction) -> Result<CommandOutput, ProcessError> {
    let action = match action {
        ServiceAction::Start => "start",
        ServiceAction::Restart => "restart",
    };
    run(&tools.pairfob, &["service", action], SERVICE_TIMEOUT)
}

/// The client socket Herdr's own discovery would use for a session. The
/// resolution belongs to the endpoint client; deriving it here would drift.
pub fn client_socket(session: Option<&str>) -> Option<PathBuf> {
    let target = match session {
        Some(name) => ConnectTarget::Session {
            name: name.to_owned(),
            development: false,
        },
        None => ConnectTarget::Local,
    };
    target.socket_path().ok()
}

/// Herdr creates its socket only once the server is up.
pub fn wait_for_socket(path: &Path, timeout: Duration) -> Result<(), ProcessError> {
    let started = Instant::now();
    loop {
        if is_socket(path) {
            return Ok(());
        }
        let remaining = timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Err(ProcessError::Timeout(path.display().to_string(), timeout));
        }
        std::thread::sleep(SOCKET_POLL.min(remaining));
    }
}

fn is_socket(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        metadata.file_type().is_socket()
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Starts a headless Herdr session when the socket is missing. Detached: the
/// window closing must not take the user's panes down.
pub fn start_herdr(tools: &Tools, session: Option<&str>) -> Result<(), ProcessError> {
    let socket = client_socket(session).ok_or_else(|| match session {
        Some(name) => ProcessError::Message(format!("invalid Herdr session name {name:?}")),
        None => ProcessError::Message("Herdr has no local socket path".to_owned()),
    })?;
    if is_socket(&socket) {
        return Ok(());
    }

    let herdr = tools
        .herdr
        .as_deref()
        .ok_or_else(|| ProcessError::Message("Herdr is not installed".to_owned()))?;
    let dir = data_dir()
        .ok_or_else(|| ProcessError::Message("no home directory for the Herdr log".to_owned()))?;
    std::fs::create_dir_all(&dir).map_err(|error| {
        ProcessError::Message(format!("could not create {}: {error}", dir.display()))
    })?;

    let log_path = dir.join("herdr.log");
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| {
            ProcessError::Message(format!("could not open {}: {error}", log_path.display()))
        })?;
    let written = log.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    let errors = log.try_clone().map_err(|error| {
        ProcessError::Message(format!("could not open {}: {error}", log_path.display()))
    })?;

    let mut command = Command::new(herdr);
    if let Some(name) = session {
        command.arg("--session").arg(name);
    }
    command
        .arg("server")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(errors));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Signals aimed at the app's process group must not reach the panes.
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|detail| ProcessError::Spawn {
        program: herdr.display().to_string(),
        detail: detail.to_string(),
    })?;

    await_server(&mut child, &socket, &log_path, written)
}

fn await_server(
    child: &mut Child,
    socket: &Path,
    log_path: &Path,
    written: u64,
) -> Result<(), ProcessError> {
    let started = Instant::now();
    loop {
        if is_socket(socket) {
            return Ok(());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                // The server may create the socket just before it exits.
                if is_socket(socket) {
                    return Ok(());
                }
                let text = log_tail(log_path, written);
                return Err(ProcessError::Message(if text.is_empty() {
                    format!("Herdr exited with {status} before creating its socket")
                } else {
                    format!("Herdr exited with {status}: {text}")
                }));
            }
            Ok(None) => {}
            Err(error) => {
                return Err(ProcessError::Message(format!(
                    "could not watch Herdr: {error}"
                )));
            }
        }
        let remaining = START_TIMEOUT.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Err(ProcessError::Timeout(
                socket.display().to_string(),
                START_TIMEOUT,
            ));
        }
        std::thread::sleep(SOCKET_POLL.min(remaining));
    }
}

fn log_tail(path: &Path, written: u64) -> String {
    let Ok(mut file) = std::fs::File::open(path) else {
        return String::new();
    };
    if file.seek(SeekFrom::Start(written)).is_err() {
        return String::new();
    }
    let mut text = String::new();
    let _ = file.read_to_string(&mut text);
    text.trim().to_owned()
}

fn data_dir() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        return std::env::var_os("HOME").map(|home| {
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("Pairfob")
        });
    }
    std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local").join("state"))
        })
        .map(|dir| dir.join("pairfob"))
}
