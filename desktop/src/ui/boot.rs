//! What the desktop needs before it can show a session: the two programs, a
//! running Herdr, and the answers from `doctor` / `setup`. Every call that can
//! block runs on its own thread and reports back through [`UiTask`].

use std::thread;

use crossbeam_channel::{unbounded, Receiver, Sender};

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

pub struct Diagnostics {
    pub report: Option<String>,
    pub error: Option<String>,
    pub doctor_running: bool,
    pub setup: SetupState,
    /// The last copy of this report succeeded; the footer says so.
    pub copied: bool,
}

pub enum UiTask {
    Herdr(Result<(), String>),
    Doctor(Result<Health, String>),
    Setup(Result<CommandOutput, String>),
}

pub struct Boot {
    tools: Option<Tools>,
    /// The Herdr session the window attaches to; `None` is the default one.
    session: Option<String>,
    pub herdr: HerdrState,
    pub diagnostics: Option<Diagnostics>,
    tasks: Receiver<UiTask>,
    tx: Sender<UiTask>,
}

impl Boot {
    pub fn start(session: Option<String>) -> Self {
        let (tx, tasks) = unbounded();
        let mut boot = Self {
            tools: process::detect(),
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

    fn socket_present(&self) -> bool {
        process::client_socket(self.session.as_deref()).is_some_and(|path| path.exists())
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
        let socket = process::client_socket(self.session.as_deref())
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
        let session = self.session.clone();
        thread::spawn(move || {
            let result =
                process::doctor_for(&tools, session.as_deref()).map_err(|error| error.to_string());
            let _ = tx.send(UiTask::Doctor(result));
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
