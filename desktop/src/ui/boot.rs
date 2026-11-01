//! What the desktop needs before it can show a session: the two programs, a
//! running Herdr, and the answers from `doctor` / `setup`. Every call that can
//! block runs on its own thread and reports back through [`UiTask`].

use std::thread;

use crossbeam_channel::{unbounded, Receiver, Sender};

use crate::herdr::ConnectTarget;
use crate::process::{self, CommandOutput, Health, Tools};

pub const INSTALL_COMMAND: &str = "curl -fsSL https://pairfob.com/install.sh | sh";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum HerdrState {
    /// Pairfob itself was not found.
    #[default]
    Missing,
    Starting,
    Running,
    Failed(String),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum SetupState {
    #[default]
    Idle,
    Running,
    Done(String),
    Failed(String),
}

/// The state of the one service action the panel offers. Starting a stopped
/// daemon and restarting a broken one are the same command to the operator.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum ServiceState {
    #[default]
    Idle,
    Running,
    Done(String),
    Failed(String),
}

pub struct Diagnostics {
    pub report: Option<String>,
    pub error: Option<String>,
    pub doctor_running: bool,
    pub setup: SetupState,
    pub service: ServiceState,
    /// The last copy of this report succeeded; the footer says so.
    pub copied: bool,
}

pub enum UiTask {
    Herdr(Result<(), String>),
    Doctor(Result<Health, String>),
    Setup(Result<CommandOutput, String>),
    Service(Result<CommandOutput, String>),
}

pub struct Boot {
    tools: Option<Tools>,
    /// Where the engine attaches. This is the whole target, so an explicit
    /// `--socket` is probed and diagnosed instead of the default session.
    target: ConnectTarget,
    /// The named session, for `herdr --session`. `None` covers the default
    /// session and an explicit socket; an explicit socket is never started.
    session: Option<String>,
    pub herdr: HerdrState,
    pub diagnostics: Option<Diagnostics>,
    tasks: Receiver<UiTask>,
    tx: Sender<UiTask>,
}

impl Boot {
    pub fn start(target: ConnectTarget) -> Self {
        let (tx, tasks) = unbounded();
        let session = match &target {
            ConnectTarget::Session { name, .. } => Some(name.clone()),
            _ => None,
        };
        let mut boot = Self {
            tools: process::detect(),
            target,
            session,
            herdr: HerdrState::Missing,
            diagnostics: None,
            tasks,
            tx,
        };
        boot.begin();
        boot
    }

    pub fn tools(&self) -> Option<&Tools> {
        self.tools.as_ref()
    }

    pub fn needs_install(&self) -> bool {
        self.tools.is_none()
    }

    /// Re-runs detection, then starts Herdr again if its socket is still
    /// missing. The engine keeps its own reconnect loop, so a running socket
    /// needs no command from here.
    pub fn retry(&mut self) {
        if matches!(self.herdr, HerdrState::Starting) {
            return;
        }
        self.tools = process::detect();
        self.begin();
    }

    fn begin(&mut self) {
        let Some(tools) = self.tools.clone() else {
            self.herdr = HerdrState::Missing;
            return;
        };
        if self.socket_present() {
            self.herdr = HerdrState::Running;
        } else if let ConnectTarget::Socket(path) = &self.target {
            // Nothing here may start a server for a socket the user named.
            self.herdr = HerdrState::Failed(format!(
                "no Herdr server is listening on {}",
                path.display()
            ));
        } else {
            self.start_herdr(&tools);
        }
    }

    fn start_herdr(&mut self, tools: &Tools) {
        if matches!(self.herdr, HerdrState::Starting) {
            return;
        }
        self.herdr = HerdrState::Starting;
        let tx = self.tx.clone();
        let tools = tools.clone();
        let session = self.session.clone();
        thread::spawn(move || {
            let result =
                process::start_herdr(&tools, session.as_deref()).map_err(|error| error.to_string());
            let _ = tx.send(UiTask::Herdr(result));
        });
    }

    /// A socket file alone is not enough: a server that was killed leaves the
    /// file behind, and treating that as running sends the window into a
    /// reconnect loop it can never leave.
    fn socket_present(&self) -> bool {
        process::socket_for(&self.target).is_some_and(|path| process::socket_alive(&path))
    }

    /// The engine connected, so Herdr is up whatever the detection said.
    pub fn connected(&mut self) {
        if matches!(
            self.herdr,
            HerdrState::Missing | HerdrState::Starting | HerdrState::Failed(_)
        ) {
            self.herdr = HerdrState::Running;
        }
    }

    /// Points the startup checks at another session. The engine itself is
    /// replaced by the caller.
    pub fn set_session(&mut self, session: Option<String>) {
        self.target = match &session {
            Some(name) => ConnectTarget::Session {
                name: name.clone(),
                development: false,
            },
            None => ConnectTarget::Local,
        };
        self.session = session;
        self.diagnostics = None;
        self.herdr = HerdrState::Missing;
        self.retry();
    }

    /// Returns whether anything the window shows changed.
    pub fn poll(&mut self) -> bool {
        let mut changed = false;
        while let Ok(task) = self.tasks.try_recv() {
            self.apply(task);
            changed = true;
        }
        changed
    }

    fn apply(&mut self, task: UiTask) {
        match task {
            UiTask::Herdr(Ok(())) => self.herdr = HerdrState::Running,
            UiTask::Herdr(Err(error)) => self.herdr = HerdrState::Failed(error),
            UiTask::Doctor(result) => {
                let Some(diagnostics) = self.diagnostics.as_mut() else {
                    return;
                };
                diagnostics.doctor_running = false;
                match result {
                    Ok(health) => {
                        diagnostics.report = Some(if health.report.trim().is_empty() {
                            "doctor returned no report.".to_owned()
                        } else {
                            health.report
                        });
                    }
                    Err(error) => diagnostics.error = Some(error),
                }
            }
            UiTask::Service(result) => {
                let Some(diagnostics) = self.diagnostics.as_mut() else {
                    return;
                };
                diagnostics.service = match result {
                    Ok(output) if output.ok() => ServiceState::Done(or_default(
                        output.combined(),
                        "The service is running.".to_owned(),
                    )),
                    Ok(output) => ServiceState::Failed(or_default(
                        output.combined(),
                        format!("pairfob service exited with {:?}.", output.status),
                    )),
                    Err(error) => ServiceState::Failed(error),
                };
            }
            UiTask::Setup(result) => {
                let Some(diagnostics) = self.diagnostics.as_mut() else {
                    return;
                };
                diagnostics.setup = match result {
                    Ok(output) if output.ok() => SetupState::Done(or_default(
                        output.combined(),
                        "Setup finished.".to_owned(),
                    )),
                    Ok(output) => SetupState::Failed(or_default(
                        output.combined(),
                        format!("pairfob setup exited with {:?}.", output.status),
                    )),
                    Err(error) => SetupState::Failed(error),
                };
            }
        }
    }

    pub fn open_diagnostics(&mut self) {
        self.diagnostics = Some(Diagnostics {
            report: None,
            error: None,
            doctor_running: self.tools.is_some(),
            setup: SetupState::Idle,
            service: ServiceState::Idle,
            copied: false,
        });
        let Some(tools) = self.tools.clone() else {
            if let Some(diagnostics) = self.diagnostics.as_mut() {
                diagnostics.error = Some(
                    "Pairfob is not installed yet. Run the install command, then Retry.".into(),
                );
            }
            return;
        };
        self.spawn_doctor(tools);
    }

    pub fn close_diagnostics(&mut self) {
        self.diagnostics = None;
    }

    pub fn mark_copied(&mut self) {
        if let Some(diagnostics) = self.diagnostics.as_mut() {
            diagnostics.copied = true;
        }
    }

    /// The block behind `Copy diagnostics`: what this build is, what it is
    /// attached to, and the log and doctor output that explain a failure.
    pub fn diagnostics_text(&self) -> String {
        let version = crate::update::VERSION;
        let mut text = format!(
            "Pairfob Desktop {version}\nOS: {} ({})\nHerdr: {}\n",
            std::env::consts::OS,
            std::env::consts::ARCH,
            herdr_label(&self.herdr),
        );
        let socket = process::socket_for(&self.target)
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "unknown".to_owned());
        text.push_str(&format!("Session socket: {socket}\n"));
        let log = crate::log::path()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "unavailable".to_owned());
        text.push_str(&format!("Log: {log}\n"));

        text.push_str("\nRecent log:\n");
        let lines = crate::log::recent(40);
        if lines.is_empty() {
            text.push_str("(no entries)\n");
        }
        for line in lines {
            text.push_str(&line);
            text.push('\n');
        }

        text.push_str("\nDoctor:\n");
        match &self.diagnostics {
            Some(diagnostics) if diagnostics.doctor_running => text.push_str("(still running)\n"),
            Some(diagnostics) => match (&diagnostics.report, &diagnostics.error) {
                (_, Some(error)) => {
                    text.push_str(error);
                    text.push('\n');
                }
                (Some(report), None) => {
                    text.push_str(report);
                    if !report.ends_with('\n') {
                        text.push('\n');
                    }
                }
                (None, None) => text.push_str("(no report)\n"),
            },
            None => text.push_str("(diagnostics closed)\n"),
        }
        text
    }

    pub fn rerun_doctor(&mut self) {
        let Some(diagnostics) = self.diagnostics.as_ref() else {
            return;
        };
        if diagnostics.doctor_running {
            return;
        }
        let Some(tools) = self.tools.clone() else {
            return;
        };
        if let Some(diagnostics) = self.diagnostics.as_mut() {
            diagnostics.report = None;
            diagnostics.error = None;
            diagnostics.doctor_running = true;
        }
        self.spawn_doctor(tools);
    }

    fn spawn_doctor(&mut self, tools: Tools) {
        let tx = self.tx.clone();
        let target = self.target.clone();
        thread::spawn(move || {
            let result = process::doctor_target(&tools, &target).map_err(|error| error.to_string());
            let _ = tx.send(UiTask::Doctor(result));
        });
    }

    /// Start or restart the pairfob daemon. The daemon owns its own service,
    /// so the window never runs it in the foreground.
    pub fn run_service(&mut self, action: crate::process::ServiceAction) {
        let Some(diagnostics) = self.diagnostics.as_ref() else {
            return;
        };
        if matches!(diagnostics.service, ServiceState::Running) {
            return;
        }
        let Some(tools) = self.tools.clone() else {
            return;
        };
        if let Some(diagnostics) = self.diagnostics.as_mut() {
            diagnostics.service = ServiceState::Running;
        }
        let tx = self.tx.clone();
        thread::spawn(move || {
            let result = crate::process::service(&tools, action).map_err(|error| error.to_string());
            let _ = tx.send(UiTask::Service(result));
        });
    }

    /// Setup can take minutes, so the panel shows progress and stays usable.
    pub fn run_setup(&mut self) {
        let Some(diagnostics) = self.diagnostics.as_ref() else {
            return;
        };
        if matches!(diagnostics.setup, SetupState::Running) {
            return;
        }
        let Some(tools) = self.tools.clone() else {
            return;
        };
        if let Some(diagnostics) = self.diagnostics.as_mut() {
            diagnostics.setup = SetupState::Running;
        }
        let tx = self.tx.clone();
        thread::spawn(move || {
            let result = process::setup(&tools).map_err(|error| error.to_string());
            let _ = tx.send(UiTask::Setup(result));
        });
    }
}

fn or_default(text: String, fallback: String) -> String {
    if text.trim().is_empty() {
        fallback
    } else {
        text
    }
}

fn herdr_label(state: &HerdrState) -> String {
    match state {
        HerdrState::Missing => "missing".to_owned(),
        HerdrState::Starting => "starting".to_owned(),
        HerdrState::Running => "running".to_owned(),
        HerdrState::Failed(message) => format!("failed: {message}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_install_command_is_the_published_one_liner() {
        assert_eq!(
            INSTALL_COMMAND,
            "curl -fsSL https://pairfob.com/install.sh | sh"
        );
    }

    #[test]
    fn empty_setup_output_gets_a_readable_message() {
        assert_eq!(or_default(String::new(), "done".into()), "done");
        assert_eq!(or_default("  \n".into(), "done".into()), "done");
        assert_eq!(or_default("installed".into(), "done".into()), "installed");
    }

    fn test_boot() -> Boot {
        let (tx, tasks) = unbounded();
        Boot {
            tools: None,
            target: ConnectTarget::Session {
                name: "pffixture".to_owned(),
                development: false,
            },
            session: Some("pffixture".to_owned()),
            herdr: HerdrState::Running,
            diagnostics: None,
            tasks,
            tx,
        }
    }

    #[test]
    fn diagnostics_text_carries_the_build_herdr_and_doctor_state() {
        let text = test_boot().diagnostics_text();
        assert!(text.contains(&format!("Pairfob Desktop {}", crate::update::VERSION)));
        assert!(text.contains("Herdr: running"));
        assert!(text.contains("pffixture"));
        assert!(text.contains("Recent log:"));
        assert!(text.contains("Doctor:"));
    }

    #[test]
    fn copying_is_cleared_when_diagnostics_reopens() {
        let mut boot = test_boot();
        boot.open_diagnostics();
        boot.mark_copied();
        assert!(boot.diagnostics.as_ref().unwrap().copied);
        boot.open_diagnostics();
        assert!(!boot.diagnostics.as_ref().unwrap().copied);
    }
}
