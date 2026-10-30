//! The process helpers against fake binaries: discovery order, bounded
//! execution, the doctor checklist, socket resolution and Herdr startup.
//! Nothing here runs the user's real Pairfob or starts a real Herdr server.

use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use pairfob_desktop::herdr::ConnectTarget;
use pairfob_desktop::process::{self, ProcessError, ServiceAction, Tools};
use tempfile::TempDir;

/// `std::env` is process-wide, so the tests that touch it take turns.
static ENV: Mutex<()> = Mutex::new(());

fn env_lock() -> MutexGuard<'static, ()> {
    ENV.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Sets variables for the life of the guard and restores them on drop.
struct EnvGuard {
    _lock: MutexGuard<'static, ()>,
    saved: Vec<(&'static str, Option<OsString>)>,
}

impl EnvGuard {
    fn new(vars: &[(&'static str, Option<PathBuf>)]) -> Self {
        let lock = env_lock();
        let mut saved = Vec::new();
        for (name, value) in vars {
            saved.push((*name, std::env::var_os(name)));
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
        Self { _lock: lock, saved }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (name, value) in self.saved.drain(..) {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
}

fn write_file(dir: &Path, name: &str, body: &str, mode: u32) -> PathBuf {
    fs::create_dir_all(dir).unwrap();
    let path = dir.join(name);
    fs::write(&path, body).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
    path
}

fn fake(dir: &Path, name: &str, body: &str) -> PathBuf {
    write_file(dir, name, &format!("#!/bin/sh\n{body}\n"), 0o755)
}

fn path_var(entries: &[&Path]) -> OsString {
    std::env::join_paths(entries.iter().map(|path| path.as_os_str())).unwrap()
}

fn process_alive(pid: &str) -> bool {
    std::process::Command::new("ps")
        .args(["-p", pid, "-o", "pid="])
        .output()
        .map(|output| output.status.success() && !output.stdout.iter().all(u8::is_ascii_whitespace))
        .unwrap_or(false)
}

#[test]
fn detect_prefers_the_bundled_sidecar() {
    let tmp = TempDir::new().unwrap();
    let exe_dir = tmp.path().join("app");
    let path_dir = tmp.path().join("path");
    let extra = tmp.path().join("extra");
    let home = tmp.path().join("home");
    let pairfob = fake(&exe_dir, "pairfob", "exit 0");
    let herdr = fake(&exe_dir, "herdr", "exit 0");
    fake(&path_dir, "pairfob", "exit 0");
    fake(&extra, "pairfob", "exit 0");
    fake(&home.join(".local/bin"), "pairfob", "exit 0");

    let path = path_var(&[&path_dir]);
    let tools = process::detect_with(
        Some(&exe_dir),
        Some(path.as_os_str()),
        Some(&home),
        std::slice::from_ref(&extra),
    )
    .unwrap();

    assert_eq!(tools.pairfob, pairfob);
    assert_eq!(tools.herdr, Some(herdr));
}

#[test]
fn detect_walks_path_then_extra_then_the_home_install_dir() {
    let tmp = TempDir::new().unwrap();
    let path_dir = tmp.path().join("path");
    let extra = tmp.path().join("extra");
    let home = tmp.path().join("home");
    let from_path = fake(&path_dir, "pairfob", "exit 0");
    let from_extra = fake(&extra, "pairfob", "exit 0");
    let from_home = fake(&home.join(".local/bin"), "pairfob", "exit 0");

    let path = path_var(&[&path_dir]);
    let found = process::detect_with(
        None,
        Some(path.as_os_str()),
        Some(&home),
        std::slice::from_ref(&extra),
    )
    .unwrap();
    assert_eq!(found.pairfob, from_path);

    let found =
        process::detect_with(None, None, Some(&home), std::slice::from_ref(&extra)).unwrap();
    assert_eq!(found.pairfob, from_extra);

    let found = process::detect_with(None, None, Some(&home), &[]).unwrap();
    assert_eq!(found.pairfob, from_home);
}

#[test]
fn detect_ignores_non_executable_files_and_still_requires_pairfob() {
    let tmp = TempDir::new().unwrap();
    let exe_dir = tmp.path().join("app");
    let path_dir = tmp.path().join("path");
    let blocked = write_file(&exe_dir, "pairfob", "#!/bin/sh\nexit 0\n", 0o644);
    let usable = fake(&path_dir, "pairfob", "exit 0");

    let path = path_var(&[&path_dir]);
    let tools = process::detect_with(Some(&exe_dir), Some(path.as_os_str()), None, &[]).unwrap();
    assert_eq!(tools.pairfob, usable);
    assert_ne!(tools.pairfob, blocked);
    assert_eq!(tools.herdr, None);

    let herdr_only = tmp.path().join("herdr-only");
    fake(&herdr_only, "herdr", "exit 0");
    let path = path_var(&[&herdr_only]);
    assert!(
        process::detect_with(Some(&herdr_only), Some(path.as_os_str()), None, &[]).is_none(),
        "pairfob is required"
    );
}

#[test]
fn run_captures_stdout_stderr_and_the_exit_code() {
    let output = process::run(
        Path::new("/bin/sh"),
        &["-c", "printf out; printf err >&2; exit 3"],
        Duration::from_secs(5),
    )
    .unwrap();

    assert_eq!(output.status, Some(3));
    assert_eq!(output.stdout, "out");
    assert_eq!(output.stderr, "err");
    assert!(!output.ok());
    assert_eq!(output.combined(), "out\nerr");
}

#[test]
fn run_kills_the_command_when_the_deadline_passes() {
    let tmp = TempDir::new().unwrap();
    let pid_file = tmp.path().join("pid");
    let script = format!("echo $$ > '{}'; exec sleep 30", pid_file.display());

    let started = Instant::now();
    // A cold `/bin/sh` start on a loaded CI machine can take longer than the
    // old 200ms budget, which killed the shell before it wrote the pid file.
    // The deadline only has to be clearly shorter than `sleep 30`.
    let result = process::run(
        Path::new("/bin/sh"),
        &["-c", script.as_str()],
        Duration::from_secs(1),
    );
    let elapsed = started.elapsed();

    assert!(
        matches!(result, Err(ProcessError::Timeout(_, _))),
        "expected a timeout, got {result:?}"
    );
    assert!(elapsed < Duration::from_secs(3), "waited {elapsed:?}");

    let pid = fs::read_to_string(&pid_file).unwrap().trim().to_owned();
    assert!(!pid.is_empty());
    std::thread::sleep(Duration::from_millis(50));
    assert!(!process_alive(&pid), "child {pid} survived the timeout");
}

#[test]
fn doctor_keeps_the_report_when_pairfob_is_not_ready() {
    let tmp = TempDir::new().unwrap();
    let pairfob = fake(
        tmp.path(),
        "pairfob",
        "echo 'pairfob 9.9.9'; echo 'herdr: ready'; echo 'daemon: not running'; exit 1",
    );
    let tools = Tools {
        pairfob,
        herdr: None,
    };

    let health = process::doctor(&tools).unwrap();

    assert!(!health.ok);
    assert!(!health.herdr_ready);
    assert!(health.report.contains("pairfob 9.9.9"), "{}", health.report);
    assert!(health.report.contains("daemon: not running"));
}

#[test]
fn doctor_is_ok_when_pairfob_exits_zero() {
    let tmp = TempDir::new().unwrap();
    let pairfob = fake(
        tmp.path(),
        "pairfob",
        "echo 'pairfob 9.9.9'; echo 'herdr: ready'; exit 0",
    );
    let tools = Tools {
        pairfob,
        herdr: None,
    };

    let health = process::doctor(&tools).unwrap();

    assert!(health.ok);
    assert!(health.report.contains("herdr: ready"));
}

#[test]
fn doctor_needs_both_the_binary_and_the_socket() {
    let tmp = TempDir::new().unwrap();
    let socket = tmp.path().join("herdr-client.sock");
    let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    let pairfob = fake(tmp.path(), "pairfob", "echo ready; exit 0");

    {
        let _env = EnvGuard::new(&[
            ("HERDR_SOCKET_PATH", None),
            ("HERDR_CLIENT_SOCKET_PATH", Some(socket.clone())),
        ]);
        let tools = Tools {
            pairfob: pairfob.clone(),
            herdr: None,
        };
        assert!(!process::doctor(&tools).unwrap().herdr_ready);

        let tools = Tools {
            pairfob,
            herdr: Some(tmp.path().join("herdr")),
        };
        assert!(process::doctor(&tools).unwrap().herdr_ready);
    }
    drop(listener);
}

#[test]
fn doctor_for_a_named_session_checks_that_sessions_socket() {
    let tmp = TempDir::new().unwrap();
    let session_dir = tmp.path().join("herdr").join("sessions").join("work");
    fs::create_dir_all(&session_dir).unwrap();
    let socket = session_dir.join("herdr-client.sock");
    let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    let pairfob = fake(tmp.path(), "pairfob", "echo ready; exit 0");
    let tools = Tools {
        pairfob,
        herdr: Some(tmp.path().join("herdr")),
    };

    {
        let _env = EnvGuard::new(&[
            ("HERDR_SOCKET_PATH", None),
            ("HERDR_CLIENT_SOCKET_PATH", None),
            ("XDG_CONFIG_HOME", Some(tmp.path().to_path_buf())),
        ]);
        let health = process::doctor_for(&tools, Some("work")).unwrap();
        assert!(health.herdr_ready, "the named session has a socket");
        assert!(
            !process::doctor_for(&tools, Some("other"))
                .unwrap()
                .herdr_ready,
            "a session without a socket is not ready"
        );
        assert!(
            !process::doctor_for(&tools, Some("../escape"))
                .unwrap()
                .herdr_ready,
            "an invalid name must not fall back to another session"
        );
    }
    drop(listener);
}

#[test]
fn setup_and_service_pass_their_arguments() {
    let tmp = TempDir::new().unwrap();
    let args_file = tmp.path().join("args");
    let pairfob = fake(
        tmp.path(),
        "pairfob",
        &format!("echo \"$@\" > '{}'", args_file.display()),
    );
    let tools = Tools {
        pairfob,
        herdr: None,
    };

    process::setup(&tools).unwrap();
    assert_eq!(fs::read_to_string(&args_file).unwrap().trim(), "setup");

    let output = process::service(&tools, ServiceAction::Start).unwrap();
    assert!(output.ok());
    assert_eq!(
        fs::read_to_string(&args_file).unwrap().trim(),
        "service start"
    );

    process::service(&tools, ServiceAction::Restart).unwrap();
    assert_eq!(
        fs::read_to_string(&args_file).unwrap().trim(),
        "service restart"
    );
}

#[test]
fn client_socket_matches_herdr_discovery() {
    let _guard = env_lock();

    assert_eq!(
        process::client_socket(None),
        ConnectTarget::Local.socket_path().ok()
    );
    assert_eq!(
        process::client_socket(Some("work")),
        ConnectTarget::Session {
            name: "work".to_owned(),
            development: false,
        }
        .socket_path()
        .ok()
    );
}

#[test]
fn client_socket_rejects_names_that_escape_the_config_root() {
    for name in ["", ".", "..", "bad/name", "a b"] {
        assert_eq!(process::client_socket(Some(name)), None, "{name:?}");
    }
    assert_eq!(process::client_socket(Some(&"x".repeat(65))), None);
}

#[test]
fn wait_for_socket_accepts_a_listening_socket() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("herdr-client.sock");
    let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();

    process::wait_for_socket(&path, Duration::from_secs(2)).unwrap();

    drop(listener);
}

#[test]
fn wait_for_socket_times_out_on_a_missing_path() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("missing.sock");

    let started = Instant::now();
    let error = process::wait_for_socket(&path, Duration::from_millis(200)).unwrap_err();
    let elapsed = started.elapsed();

    assert!(matches!(error, ProcessError::Timeout(_, _)));
    assert!(elapsed >= Duration::from_millis(200));
    assert!(elapsed < Duration::from_secs(3), "waited {elapsed:?}");
}

#[test]
fn wait_for_socket_waits_for_a_socket_that_arrives() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("late.sock");
    let creating = {
        let path = path.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            std::os::unix::net::UnixListener::bind(path).unwrap()
        })
    };

    process::wait_for_socket(&path, Duration::from_secs(3)).unwrap();

    drop(creating.join().unwrap());
}

/// A short root under `/tmp`: Herdr session sockets must stay inside the
/// platform's `sun_path` limit, which the default macOS temp path can exceed.
fn short_tmp() -> TempDir {
    tempfile::Builder::new()
        .prefix("pf")
        .tempdir_in("/tmp")
        .unwrap()
}

fn sandbox_env(tmp: &TempDir) -> Vec<(&'static str, Option<PathBuf>)> {
    vec![
        ("HOME", Some(tmp.path().to_owned())),
        ("XDG_CONFIG_HOME", Some(tmp.path().join("config"))),
        ("XDG_STATE_HOME", Some(tmp.path().join("state"))),
    ]
}

#[test]
fn start_herdr_starts_a_named_session_and_waits_for_its_socket() {
    let tmp = short_tmp();
    let _env = EnvGuard::new(&sandbox_env(&tmp));

    let socket = process::client_socket(Some("work")).unwrap();
    assert!(
        socket.starts_with(tmp.path()),
        "socket escaped the sandbox: {}",
        socket.display()
    );

    let args_file = tmp.path().join("args");
    let script = format!(
        "echo \"$@\" > '{}'\nmkdir -p '{}'\nexec python3 -I -c 'import socket, sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])' '{}'",
        args_file.display(),
        socket.parent().unwrap().display(),
        socket.display()
    );
    let herdr = fake(tmp.path(), "herdr", &script);
    let tools = Tools {
        pairfob: tmp.path().join("pairfob"),
        herdr: Some(herdr),
    };

    process::start_herdr(&tools, Some("work")).unwrap();

    assert_eq!(
        fs::read_to_string(&args_file).unwrap().trim(),
        "--session work server"
    );
    assert!(socket.exists(), "no socket at {}", socket.display());
}

#[test]
fn start_herdr_returns_when_the_socket_is_already_there() {
    let tmp = short_tmp();
    let _env = EnvGuard::new(&sandbox_env(&tmp));

    let socket = process::client_socket(Some("work")).unwrap();
    fs::create_dir_all(socket.parent().unwrap()).unwrap();
    let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    let tools = Tools {
        pairfob: tmp.path().join("pairfob"),
        herdr: None,
    };

    process::start_herdr(&tools, Some("work")).unwrap();

    drop(listener);
}

#[test]
fn start_herdr_reports_an_early_exit() {
    let tmp = TempDir::new().unwrap();
    let _env = EnvGuard::new(&sandbox_env(&tmp));

    let herdr = fake(
        tmp.path(),
        "herdr",
        "echo 'herdr: cannot open the display' >&2\nexit 1",
    );
    let tools = Tools {
        pairfob: tmp.path().join("pairfob"),
        herdr: Some(herdr),
    };

    let error = process::start_herdr(&tools, Some("work")).unwrap_err();

    assert!(
        error.to_string().contains("cannot open the display"),
        "lost the server's stderr: {error}"
    );
}

#[test]
fn start_herdr_refuses_an_invalid_session_name() {
    let tools = Tools {
        pairfob: PathBuf::from("/nonexistent/pairfob"),
        herdr: None,
    };

    let error = process::start_herdr(&tools, Some("bad/name")).unwrap_err();

    assert!(matches!(error, ProcessError::Message(_)));
    assert!(error.to_string().contains("session name"));
}
