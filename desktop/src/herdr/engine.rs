//! Connection ownership: one worker thread drains Herdr events, applies them
//! to the engine's copy of [`App`], and runs commands from the window. The
//! window never touches the endpoint socket directly.

use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel::{unbounded, Receiver, RecvTimeoutError, Sender, TryRecvError};
use serde_json::Value;

use super::connect::{
    self, ClientEvent, ConnectError, ConnectOptions, ConnectTarget, ConnectionHandle,
};
use super::keys::wire_inputs;
use super::search::{self, SearchRequest};
use super::surface_patch;
use super::wire::{ClientPaneInputEvent, PaneSurfaceFrame};
use crate::app::input::{GateOutcome, InputGate, KeyInput, Submit};
use crate::app::{App, AppEvent, Connection, Notice, ServerInfo};
use crate::herdr::map;
use crate::model::{PaneId, Size, SplitDirection, TabId, WorkspaceId};

// The command vocabulary lives in the model; re-exported so callers keep
// naming it through the engine.
pub use crate::model::{Direction, ZoomMode};

/// The longest the worker sleeps when neither Herdr nor the window has
/// anything. It only bounds how late a stuck focus request expires; both
/// channels wake it immediately.
const POLL: Duration = Duration::from_millis(16);

/// Wakeup while offline and waiting for a manual reconnect. Nothing can arrive
/// on its own, so this only bounds how late queued input expires.
const IDLE_POLL: Duration = Duration::from_millis(250);

/// A connection that lived this long counts as healthy, so the next failure
/// starts again from the shortest delay. One that dies sooner keeps
/// escalating, so a server that accepts and immediately drops cannot turn
/// into a reconnect storm.
const STABLE_CONNECTION: Duration = Duration::from_secs(3);

/// Reconnect delays by attempt; the last one repeats.
const BACKOFF: [Duration; 5] = [
    Duration::from_millis(250),
    Duration::from_millis(500),
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
];

#[derive(Clone, Debug)]
pub struct Config {
    pub target: ConnectTarget,
    /// The surface size asked for at connect time. The window resizes later.
    pub surface: Size,
    pub cell_width_px: u32,
    pub cell_height_px: u32,
    /// How long a pane may take to become focused before queued keys are
    /// dropped with a notice instead of arriving in the wrong place.
    pub focus_timeout: Duration,
}

impl Config {
    pub fn local() -> Self {
        Self {
            target: ConnectTarget::Local,
            surface: Size::new(80, 24),
            cell_width_px: 9,
            cell_height_px: 18,
            focus_timeout: Duration::from_secs(2),
        }
    }

    /// The connect options for a given surface, reused on every retry.
    pub(crate) fn connect_options(&self, surface: Size) -> ConnectOptions {
        ConnectOptions {
            target: self.target.clone(),
            surface,
            cell_width_px: self.cell_width_px,
            cell_height_px: self.cell_height_px,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("the Herdr event stream closed")]
    Closed,
    #[error("{0}")]
    Herdr(String),
}

/// What the window asks the engine to do.
#[derive(Clone, Debug)]
pub enum Command {
    Focus(PaneId),
    FocusTab(TabId),
    FocusWorkspace(WorkspaceId),
    Split {
        pane: PaneId,
        direction: SplitDirection,
        focus: bool,
    },
    /// Drag a splitter; `path` is the split's position in the layout tree.
    SetSplitRatio {
        tab: TabId,
        path: Vec<bool>,
        ratio: f32,
    },
    Zoom {
        pane: PaneId,
        mode: ZoomMode,
    },
    ClosePane(PaneId),
    RenamePane {
        pane: PaneId,
        label: String,
    },
    SwapPane {
        pane: PaneId,
        direction: Direction,
    },
    ResizePane {
        pane: PaneId,
        direction: Direction,
    },
    FocusDirection {
        pane: PaneId,
        direction: Direction,
    },
    /// Put the viewport `offset_from_bottom` lines above the newest output.
    ScrollTo {
        pane: PaneId,
        offset_from_bottom: u64,
    },
    /// `request_id` comes back on [`AppEvent::Search`] with the reply.
    Search {
        request_id: u64,
        request: SearchRequest,
    },
    SendKeys {
        pane: PaneId,
        inputs: Vec<KeyInput>,
    },
    /// Wheel lines over `column`/`row` inside the pane, positive being up.
    Scroll {
        pane: PaneId,
        column: u16,
        row: u16,
        lines: i32,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
    /// Try again after a version mismatch, once the user has updated one side.
    Reconnect,
    Shutdown,
}

#[derive(Clone)]
pub struct EngineHandle {
    commands: crossbeam_channel::Sender<Command>,
}

impl EngineHandle {
    pub fn send(&self, command: Command) -> Result<(), EngineError> {
        self.commands.send(command).map_err(|_| EngineError::Closed)
    }

    pub fn focus(&self, pane: PaneId) -> Result<(), EngineError> {
        self.send(Command::Focus(pane))
    }

    pub fn focus_tab(&self, tab: TabId) -> Result<(), EngineError> {
        self.send(Command::FocusTab(tab))
    }

    pub fn focus_workspace(&self, workspace: WorkspaceId) -> Result<(), EngineError> {
        self.send(Command::FocusWorkspace(workspace))
    }

    pub fn split(
        &self,
        pane: PaneId,
        direction: SplitDirection,
        focus: bool,
    ) -> Result<(), EngineError> {
        self.send(Command::Split {
            pane,
            direction,
            focus,
        })
    }

    pub fn set_split_ratio(
        &self,
        tab: TabId,
        path: Vec<bool>,
        ratio: f32,
    ) -> Result<(), EngineError> {
        self.send(Command::SetSplitRatio { tab, path, ratio })
    }

    pub fn zoom(&self, pane: PaneId, mode: ZoomMode) -> Result<(), EngineError> {
        self.send(Command::Zoom { pane, mode })
    }

    pub fn close_pane(&self, pane: PaneId) -> Result<(), EngineError> {
        self.send(Command::ClosePane(pane))
    }

    pub fn rename_pane(&self, pane: PaneId, label: String) -> Result<(), EngineError> {
        self.send(Command::RenamePane { pane, label })
    }

    pub fn swap_pane(&self, pane: PaneId, direction: Direction) -> Result<(), EngineError> {
        self.send(Command::SwapPane { pane, direction })
    }

    pub fn resize_pane(&self, pane: PaneId, direction: Direction) -> Result<(), EngineError> {
        self.send(Command::ResizePane { pane, direction })
    }

    pub fn focus_direction(&self, pane: PaneId, direction: Direction) -> Result<(), EngineError> {
        self.send(Command::FocusDirection { pane, direction })
    }

    pub fn scroll_to(&self, pane: PaneId, offset_from_bottom: u64) -> Result<(), EngineError> {
        self.send(Command::ScrollTo {
            pane,
            offset_from_bottom,
        })
    }

    pub fn search(&self, request_id: u64, request: SearchRequest) -> Result<(), EngineError> {
        self.send(Command::Search {
            request_id,
            request,
        })
    }

    pub fn send_keys(&self, pane: PaneId, inputs: Vec<KeyInput>) -> Result<(), EngineError> {
        self.send(Command::SendKeys { pane, inputs })
    }

    pub fn scroll(
        &self,
        pane: PaneId,
        column: u16,
        row: u16,
        lines: i32,
    ) -> Result<(), EngineError> {
        self.send(Command::Scroll {
            pane,
            column,
            row,
            lines,
        })
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), EngineError> {
        self.send(Command::Resize { cols, rows })
    }

    pub fn reconnect(&self) -> Result<(), EngineError> {
        self.send(Command::Reconnect)
    }

    pub fn shutdown(&self) {
        let _ = self.send(Command::Shutdown);
    }
}

pub struct Desktop {
    pub handle: EngineHandle,
    pub events: Receiver<AppEvent>,
}

/// Starts the connection worker. Returns immediately; connection state arrives
/// as [`AppEvent::Connection`].
pub fn start(config: Config) -> Result<Desktop, EngineError> {
    let (events_out, events) = unbounded();
    let (handle, commands) = unbounded();
    thread::Builder::new()
        .name("pairfob-herdr".into())
        .spawn(move || Worker::new(config, events_out, commands).run())
        .map_err(|error| EngineError::Herdr(error.to_string()))?;
    Ok(Desktop {
        handle: EngineHandle { commands: handle },
        events,
    })
}

struct Worker {
    config: Config,
    out: Sender<AppEvent>,
    commands: Receiver<Command>,
    app: App,
    handle: Option<ConnectionHandle>,
    events: Option<Receiver<ClientEvent>>,
    boot: Option<String>,
    /// The last full surface, patched in place as the focused pane repaints.
    wire_surface: Option<Box<PaneSurfaceFrame>>,
    /// When the current connection was established, for the backoff reset.
    connected_at: Option<Instant>,
    gate: InputGate,
    /// The size the window asked for last, reused when reconnecting.
    surface: Size,
    resize_pending: bool,
    focus_pending: Option<PaneId>,
    attempt: u32,
    retry_at: Option<Instant>,
    /// A version mismatch cannot heal by retrying; wait for [`Command::Reconnect`].
    offline: bool,
    stopped: bool,
}

impl Worker {
    fn new(config: Config, out: Sender<AppEvent>, commands: Receiver<Command>) -> Self {
        let surface = config.surface;
        let gate = InputGate::new(config.focus_timeout);
        Self {
            config,
            out,
            commands,
            app: App::default(),
            handle: None,
            events: None,
            boot: None,
            wire_surface: None,
            connected_at: None,
            gate,
            surface,
            resize_pending: false,
            focus_pending: None,
            attempt: 0,
            retry_at: None,
            offline: false,
            stopped: false,
        }
    }

    fn run(mut self) {
        while !self.stopped {
            if self.handle.is_none() {
                if self.offline {
                    self.wait_reconnect();
                } else {
                    self.wait_retry();
                }
                if self.stopped {
                    break;
                }
                if !self.offline {
                    self.connect();
                }
                continue;
            }
            self.pump();
        }
    }

    /// Blocks until the window asks to reconnect. Input queued in the meantime
    /// still expires instead of arriving after an unrelated reconnect.
    fn wait_reconnect(&mut self) {
        while !self.stopped && self.offline {
            match self.commands.recv_timeout(IDLE_POLL) {
                Ok(command) => self.run_command(command),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    self.stopped = true;
                    return;
                }
            }
            self.poll_gate();
        }
    }

    /// Waits out the backoff while still answering commands, so a shutdown or
    /// a resize does not wait for the timer.
    fn wait_retry(&mut self) {
        while let Some(at) = self.retry_at {
            let now = Instant::now();
            if now >= at {
                return;
            }
            let wait = at.saturating_duration_since(now).min(POLL);
            match self.commands.recv_timeout(wait) {
                Ok(command) => self.run_command(command),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    self.stopped = true;
                    return;
                }
            }
            self.poll_gate();
        }
    }

    fn connect(&mut self) {
        let options = self.config.connect_options(self.surface);
        match connect::connect(options) {
            Ok(client) => {
                self.handle = Some(client.handle);
                self.events = Some(client.events);
                self.wire_surface = None;
                self.connected_at = Some(Instant::now());
                self.retry_at = None;
            }
            Err(error) => {
                // A version or codec refusal cannot heal by retrying; wait for
                // the user to update one side and ask to reconnect.
                self.offline = matches!(
                    error,
                    ConnectError::Incompatible(_) | ConnectError::Rejected(_)
                );
                self.emit(AppEvent::Connection(Connection::Offline {
                    reason: error.to_string(),
                }));
                if !self.offline {
                    self.schedule_retry();
                }
            }
        }
    }

    /// Waits for whichever comes first, a Herdr event or a window command, so
    /// a keystroke does not sit behind the event poll's timeout. `POLL` only
    /// bounds the focus gate's expiry check when neither side has anything.
    fn pump(&mut self) {
        // Copies of the receivers, so the handlers can take `&mut self` while
        // the await is still in scope.
        let events = self.events.as_ref().expect("connected").clone();
        let commands = self.commands.clone();
        crossbeam_channel::select! {
            recv(events) -> message => match message {
                Ok(event) => self.on_event(event),
                Err(_) => self.disconnected("the Herdr event stream closed".into()),
            },
            recv(commands) -> message => match message {
                Ok(command) => self.run_command(command),
                Err(_) => self.stopped = true,
            },
            default(POLL) => {}
        }
        self.poll_gate();
        self.drain_commands();
    }

    fn on_event(&mut self, event: ClientEvent) {
        match event {
            ClientEvent::Connected(welcome) => {
                self.emit(AppEvent::Server(ServerInfo {
                    version: welcome.server_version,
                    generation: welcome.generation.min(u32::from(u16::MAX)) as u16,
                    snapshot_codec: welcome.snapshot_codec,
                    surface_codec: welcome.surface_codec,
                    methods: welcome.methods,
                    capabilities: welcome.capabilities,
                }));
            }
            ClientEvent::Snapshot(snapshot) => {
                self.boot = Some(snapshot.boot_id.clone());
                if self.resize_pending {
                    self.resize_pending = false;
                    self.resize_request();
                }
                self.emit(AppEvent::Session(map::session(&snapshot)));
                self.emit(AppEvent::Connection(Connection::Ready));
                if let Some(pane) = self.focus_pending.take() {
                    self.focus_request(&pane);
                }
            }
            ClientEvent::Surface(surface) => {
                self.wire_surface = Some(surface);
                self.emit_frame();
            }
            ClientEvent::Patch(patch) => {
                let Some(surface) = self.wire_surface.as_mut() else {
                    return;
                };
                if !surface_patch::fits(surface, &patch) {
                    self.disconnected("the surface updates fell out of step".into());
                    return;
                }
                surface_patch::apply(surface, *patch);
                self.emit_frame();
            }
            ClientEvent::Response {
                request_id,
                method,
                response,
            } => {
                // A search reply is not an error report: its outcome goes back
                // to the window under the ID it chose.
                if method == "pane.copy_search" {
                    self.emit(AppEvent::Search {
                        request_id: search::request_id(&request_id),
                        outcome: search::parse_response(&response),
                    });
                } else {
                    self.on_response(&method, &response);
                }
            }
            ClientEvent::Disconnected(reason) => self.disconnected(reason),
        }
    }

    fn on_response(&mut self, method: &str, response: &Value) {
        let Some(error) = response.get("error") else {
            return;
        };
        let code = error.get("code").and_then(Value::as_str).unwrap_or("error");
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("no detail");
        self.emit(AppEvent::Notice(Notice::warning(format!(
            "{method} failed ({code}): {message}"
        ))));
    }

    fn disconnected(&mut self, reason: String) {
        if self
            .connected_at
            .take()
            .is_some_and(|at| at.elapsed() >= STABLE_CONNECTION)
        {
            self.attempt = 0;
        }
        self.wire_surface = None;
        self.gate.cancel();
        self.boot = None;
        self.handle = None;
        self.events = None;
        // The next connection negotiates `surface` itself.
        self.resize_pending = false;
        self.schedule_retry();
        self.emit(AppEvent::Connection(Connection::Reconnecting {
            attempt: self.attempt,
            reason,
        }));
    }

    fn schedule_retry(&mut self) {
        self.attempt = self.attempt.saturating_add(1);
        let index = usize::try_from(self.attempt.saturating_sub(1))
            .unwrap_or(usize::MAX)
            .min(BACKOFF.len() - 1);
        self.retry_at = Some(Instant::now() + BACKOFF[index]);
    }

    fn drain_commands(&mut self) {
        while !self.stopped {
            match self.commands.try_recv() {
                Ok(command) => self.run_command(command),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => self.stopped = true,
            }
        }
    }

    fn run_command(&mut self, command: Command) {
        match command {
            Command::Shutdown => self.stopped = true,
            Command::Focus(pane) => self.focus_request(&pane),
            Command::FocusTab(tab) => {
                self.with_handle(|handle| handle.focus_tab(tab.as_str()));
            }
            Command::FocusWorkspace(workspace) => {
                self.with_handle(|handle| handle.focus_workspace(workspace.as_str()));
            }
            Command::Split {
                pane,
                direction,
                focus,
            } => {
                let direction = match direction {
                    SplitDirection::Horizontal => "down",
                    SplitDirection::Vertical => "right",
                };
                self.with_handle(|handle| handle.split(pane.as_str(), direction, None, focus));
            }
            Command::SetSplitRatio { tab, path, ratio } => {
                self.with_handle(|handle| handle.set_split_ratio(tab.as_str(), &path, ratio));
            }
            Command::Zoom { pane, mode } => {
                self.with_handle(|handle| handle.zoom(pane.as_str(), mode.as_str()));
            }
            Command::ClosePane(pane) => {
                self.with_handle(|handle| handle.close_pane(pane.as_str()));
            }
            Command::RenamePane { pane, label } => {
                self.with_handle(|handle| handle.rename_pane(pane.as_str(), &label));
            }
            Command::SwapPane { pane, direction } => {
                self.with_handle(|handle| handle.swap_pane(pane.as_str(), direction.as_str()));
            }
            Command::ResizePane { pane, direction } => {
                self.with_handle(|handle| handle.resize_pane(pane.as_str(), direction.as_str()));
            }
            Command::FocusDirection { pane, direction } => {
                self.with_handle(|handle| {
                    handle.focus_direction(pane.as_str(), direction.as_str())
                });
            }
            Command::ScrollTo {
                pane,
                offset_from_bottom,
            } => {
                self.with_handle(|handle| handle.scroll_to(pane.as_str(), offset_from_bottom));
            }
            Command::Search {
                request_id,
                request,
            } => {
                self.with_handle(|handle| handle.search(&search::wire_id(request_id), &request));
            }
            Command::SendKeys { pane, inputs } => {
                let submit = self.gate.submit(&pane, inputs, Instant::now());
                self.on_submit(submit);
            }
            // Scrolling never moves focus, so it skips the gate entirely.
            Command::Scroll {
                pane,
                column,
                row,
                lines,
            } => self.scroll_request(&pane, column, row, lines),
            Command::Resize { cols, rows } => self.resize_request_to(Size::new(cols, rows)),
            Command::Reconnect => {
                self.offline = false;
                self.attempt = 0;
                self.retry_at = None;
            }
        }
    }

    /// A pane request goes out only while connected; a dropped one is not an
    /// error the window could act on.
    fn with_handle(&self, run: impl FnOnce(&ConnectionHandle) -> Result<(), ConnectError>) {
        if let Some(handle) = self.handle.as_ref() {
            let _ = run(handle);
        }
    }

    fn on_submit(&mut self, submit: Submit) {
        match submit {
            Submit::SendNow { pane, inputs } => self.send_inputs(&pane, inputs),
            Submit::FocusThenSend { pane, .. } => self.focus_request(&pane),
            Submit::Queued => {}
        }
    }

    fn on_gate(&mut self, outcome: GateOutcome) {
        match outcome {
            GateOutcome::Flush { pane, inputs } => self.send_inputs(&pane, inputs),
            GateOutcome::TimedOut { dropped, .. } => {
                self.emit(AppEvent::Notice(Notice::warning(format!(
                    "focus switch timed out; {dropped} keys dropped"
                ))));
            }
            GateOutcome::Idle => {}
        }
    }

    /// Frames drive the gate's expiry; a quiet connection still needs ticks.
    fn poll_gate(&mut self) {
        let outcome = self.gate.tick(Instant::now());
        self.on_gate(outcome);
    }

    fn focus_request(&mut self, pane: &PaneId) {
        match (self.handle.as_ref(), self.boot.as_deref()) {
            (Some(handle), Some(_)) => {
                let _ = handle.focus_pane(pane.as_str());
            }
            // Without a snapshot there is no boot ID to act on yet.
            _ => self.focus_pending = Some(pane.clone()),
        }
    }

    fn resize_request_to(&mut self, size: Size) {
        if size.cols == 0 || size.rows == 0 {
            return;
        }
        self.surface = size;
        if self.boot.is_some() {
            self.resize_request();
        } else {
            self.resize_pending = true;
        }
    }

    fn resize_request(&mut self) {
        let Some(handle) = self.handle.as_ref() else {
            return;
        };
        if self.boot.is_none() {
            return;
        }
        let _ = handle.resize_with(
            self.surface,
            self.config.cell_width_px,
            self.config.cell_height_px,
        );
    }

    fn send_inputs(&mut self, pane: &PaneId, inputs: Vec<KeyInput>) {
        let events = wire_inputs(&inputs);
        self.send_events(pane, events);
    }

    fn send_events(&mut self, pane: &PaneId, events: Vec<ClientPaneInputEvent>) {
        if events.is_empty() {
            return;
        }
        let result = match (self.handle.as_ref(), self.boot.as_deref()) {
            (Some(handle), Some(_)) => handle.send_input(pane.as_str(), events),
            _ => Ok(()),
        };
        if let Err(error) = result {
            self.emit(AppEvent::Notice(Notice::warning(format!(
                "could not send keys: {error}"
            ))));
        }
    }

    /// The pane decides the shape: one event for the scrollback, or one event
    /// per step for a program that reads the wheel itself.
    fn scroll_request(&mut self, pane: &PaneId, column: u16, row: u16, lines: i32) {
        let stepwise = self
            .app
            .frame
            .as_ref()
            .and_then(|frame| frame.panes.iter().find(|rect| &rect.id == pane))
            .is_some_and(|rect| rect.mouse_reporting || rect.alternate_screen);
        let events = super::scroll_events(stepwise, lines, column, row);
        self.send_events(pane, events);
    }

    /// The surface is the only source of the frame; both full frames and
    /// patches end here.
    fn emit_frame(&mut self) {
        let Some(surface) = self.wire_surface.as_ref() else {
            return;
        };
        let frame = Arc::new(map::frame(surface));
        let focused = frame.focused_pane().cloned();
        self.emit(AppEvent::Frame(frame));
        let outcome = self.gate.observe(focused.as_ref(), Instant::now());
        self.on_gate(outcome);
    }

    fn emit(&mut self, event: AppEvent) {
        self.app.apply(event.clone());
        if self.out.send(event).is_err() {
            self.stopped = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossbeam_channel::unbounded;

    #[test]
    fn a_window_command_does_not_wait_for_the_event_poll() {
        // Nothing is connected, so only the command channel can wake the
        // worker; the old event-first wait made every command take `POLL`.
        let (out, _app_events) = unbounded();
        let (commands_tx, commands) = unbounded();
        let mut worker = Worker::new(Config::local(), out, commands);
        let (_client_tx, client_events) = unbounded();
        worker.events = Some(client_events);

        commands_tx
            .send(Command::Shutdown)
            .expect("the worker listens");
        let started = Instant::now();
        worker.pump();
        let waited = started.elapsed();

        assert!(worker.stopped, "the shutdown command ran");
        assert!(waited < POLL, "the command waited {waited:?} for an event");
    }
}
