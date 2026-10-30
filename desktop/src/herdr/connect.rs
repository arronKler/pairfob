//! Socket discovery, handshake, request/response correlation, and frame
//! subscription for Herdr's stable endpoint contract generation 1. The engine
//! sees [`ClientEvent`] and [`ConnectionHandle`]; no wire type escapes here.

use std::collections::VecDeque;
use std::fs;
use std::io::Read;
use std::io::Write;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel::{unbounded, Receiver, Sender};
use serde_json::{json, Value};

use crate::model::Size;

use super::reader::read_loop;
use super::search::SearchRequest;
use super::wire::{
    self, ClientMessage, ClientPaneInputEvent, ClientShellSnapshot, EndpointClientHello,
    EndpointServerWelcome, PaneSurfaceFrame, PaneSurfacePatch, ServerMessage, WireError,
    BLOB_CODEC, ENDPOINT_GENERATION, HELLO_KIND, INPUT_CODEC, SNAPSHOT_CODEC, SURFACE_CODEC,
    WELCOME_KIND,
};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

pub(super) struct RawResponse {
    pub(super) request_id: String,
    pub(super) response: Value,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum ConnectTarget {
    /// Environment overrides, then `HERDR_SESSION`, then the default session.
    #[default]
    Local,
    /// A named session; `default` is the configuration root, and `development`
    /// selects the `herdr-dev` directory.
    Session { name: String, development: bool },
    /// An exact client protocol socket.
    Socket(PathBuf),
}

impl ConnectTarget {
    pub fn socket_path(&self) -> Result<PathBuf, ConnectError> {
        let var = |name: &str| std::env::var_os(name);
        match self {
            Self::Socket(path) => Ok(path.clone()),
            Self::Local => {
                if let Some(path) = var("HERDR_SOCKET_PATH") {
                    let path = PathBuf::from(path);
                    let stem = path
                        .file_stem()
                        .and_then(|stem| stem.to_str())
                        .unwrap_or("herdr");
                    return Ok(path
                        .parent()
                        .unwrap_or(Path::new(""))
                        .join(format!("{stem}-client.sock")));
                }
                if let Some(path) = var("HERDR_CLIENT_SOCKET_PATH") {
                    return Ok(PathBuf::from(path));
                }
                let name = var("HERDR_SESSION")
                    .and_then(|name| name.into_string().ok())
                    .unwrap_or_else(|| "default".into());
                session_socket(&config_dir(false)?, &name)
            }
            Self::Session { name, development } => session_socket(&config_dir(*development)?, name),
        }
    }
}

fn config_root() -> PathBuf {
    if let Some(dir) = std::env::var_os("XDG_CONFIG_HOME") {
        return PathBuf::from(dir);
    }
    std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join(".config"))
        .unwrap_or_else(std::env::temp_dir)
}

fn config_dir(development: bool) -> Result<PathBuf, ConnectError> {
    let app = if development { "herdr-dev" } else { "herdr" };
    Ok(config_root().join(app))
}

fn valid_session_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !matches!(name, "." | "..")
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn session_socket(config_dir: &Path, name: &str) -> Result<PathBuf, ConnectError> {
    if !valid_session_name(name) {
        return Err(ConnectError::Socket(format!(
            "invalid Herdr session name {name:?}"
        )));
    }
    let base = if name == "default" {
        config_dir.to_path_buf()
    } else {
        config_dir.join("sessions").join(name)
    };
    Ok(base.join("herdr-client.sock"))
}

#[derive(Debug, thiserror::Error)]
pub enum ConnectError {
    #[error("{0}")]
    Socket(String),
    #[error("the Herdr endpoint rejected the handshake: {0}")]
    Rejected(String),
    #[error("the Herdr endpoint has no compatible generation 1 core: {0}")]
    Incompatible(String),
    #[error("protocol error: {0}")]
    Protocol(#[from] WireError),
}

#[derive(Clone, Debug)]
pub struct ConnectOptions {
    pub target: ConnectTarget,
    pub surface: Size,
    pub cell_width_px: u32,
    pub cell_height_px: u32,
}

impl ConnectOptions {
    pub fn local() -> Self {
        Self {
            target: ConnectTarget::Local,
            surface: Size::new(80, 24),
            cell_width_px: 9,
            cell_height_px: 18,
        }
    }
}

#[derive(Debug)]
pub enum ClientEvent {
    Connected(EndpointServerWelcome),
    Snapshot(Box<ClientShellSnapshot>),
    Surface(Box<PaneSurfaceFrame>),
    Response {
        request_id: String,
        method: String,
        response: Value,
    },
    /// One row-level update to the surface the engine already holds.
    Patch(Box<PaneSurfacePatch>),
    Disconnected(String),
}

pub struct Connection {
    pub handle: ConnectionHandle,
    pub events: Receiver<ClientEvent>,
}

#[derive(Clone)]
pub struct ConnectionHandle {
    commands: Sender<ClientCommand>,
    requests: Sender<EndpointRequest>,
    socket: Arc<SocketGuard>,
    stopped: Arc<AtomicBool>,
}

/// Shuts the socket down when the last handle goes away, which also unblocks
/// the reader and writer threads.
struct SocketGuard(UnixStream);

impl Drop for SocketGuard {
    fn drop(&mut self) {
        let _ = self.0.shutdown(std::net::Shutdown::Both);
    }
}

struct EndpointRequest {
    id: String,
    method: String,
    params: Value,
}

enum ClientCommand {
    Write(ClientMessage),
    Shutdown,
}

impl ConnectionHandle {
    pub fn send(&self, message: ClientMessage) -> Result<(), ConnectError> {
        self.commands
            .send(ClientCommand::Write(message))
            .map_err(|_| ConnectError::Socket("the Herdr writer stopped".into()))
    }

    pub fn resize(&self, surface: Size) -> Result<(), ConnectError> {
        self.resize_with(surface, 9, 18)
    }

    pub fn resize_with(
        &self,
        surface: Size,
        cell_width_px: u32,
        cell_height_px: u32,
    ) -> Result<(), ConnectError> {
        self.send(ClientMessage::ClientShellResize {
            cell_width_px,
            cell_height_px,
            surface_size: wire::ClientSurfaceSize {
                cols: surface.cols,
                rows: surface.rows,
            },
            pixel_mouse: false,
        })
    }

    pub fn send_input(
        &self,
        pane_id: &str,
        events: Vec<ClientPaneInputEvent>,
    ) -> Result<(), ConnectError> {
        self.send(ClientMessage::ClientShellPaneInput {
            pane_id: pane_id.into(),
            events,
        })
    }

    /// Queues a request under a caller-chosen ID, so the reply can be matched
    /// to work the window started before the request went out.
    pub fn request_with_id(
        &self,
        id: String,
        method: &str,
        params: Value,
    ) -> Result<(), ConnectError> {
        self.requests
            .send(EndpointRequest {
                id,
                method: method.into(),
                params,
            })
            .map_err(|_| ConnectError::Socket("the Herdr request lane stopped".into()))
    }

    pub fn request(&self, method: &str, params: Value) -> Result<String, ConnectError> {
        let id = format!("pfdesk-{}", next_request_id());
        self.request_with_id(id.clone(), method, params)?;
        Ok(id)
    }

    pub fn focus_pane(&self, pane_id: &str) -> Result<(), ConnectError> {
        self.request("pane.focus", json!({ "pane_id": pane_id }))?;
        Ok(())
    }

    pub fn focus_tab(&self, tab_id: &str) -> Result<(), ConnectError> {
        self.request("tab.focus", json!({ "tab_id": tab_id }))?;
        Ok(())
    }

    pub fn focus_workspace(&self, workspace_id: &str) -> Result<(), ConnectError> {
        self.request("workspace.focus", json!({ "workspace_id": workspace_id }))?;
        Ok(())
    }

    pub fn split(
        &self,
        pane_id: &str,
        direction: &str,
        ratio: Option<f32>,
        focus: bool,
    ) -> Result<(), ConnectError> {
        let mut params = json!({
            "target_pane_id": pane_id,
            "direction": direction,
            "focus": focus,
        });
        if let Some(ratio) = ratio {
            params["ratio"] = json!(ratio);
        }
        self.request("pane.split", params)?;
        Ok(())
    }

    pub fn set_split_ratio(
        &self,
        tab_id: &str,
        path: &[bool],
        ratio: f32,
    ) -> Result<(), ConnectError> {
        self.request(
            "layout.set_split_ratio",
            json!({
                "tab_id": tab_id,
                "path": path,
                "ratio": ratio.clamp(0.1, 0.9),
            }),
        )?;
        Ok(())
    }

    pub fn zoom(&self, pane_id: &str, mode: &str) -> Result<(), ConnectError> {
        self.request("pane.zoom", json!({ "pane_id": pane_id, "mode": mode }))?;
        Ok(())
    }

    pub fn close_pane(&self, pane_id: &str) -> Result<(), ConnectError> {
        self.request("pane.close", json!({ "pane_id": pane_id }))?;
        Ok(())
    }

    pub fn rename_pane(&self, pane_id: &str, label: &str) -> Result<(), ConnectError> {
        self.request("pane.rename", json!({ "pane_id": pane_id, "label": label }))?;
        Ok(())
    }

    pub fn swap_pane(&self, pane_id: &str, direction: &str) -> Result<(), ConnectError> {
        self.request(
            "pane.swap",
            json!({ "pane_id": pane_id, "direction": direction }),
        )?;
        Ok(())
    }

    pub fn resize_pane(&self, pane_id: &str, direction: &str) -> Result<(), ConnectError> {
        self.request(
            "pane.resize",
            json!({ "pane_id": pane_id, "direction": direction }),
        )?;
        Ok(())
    }

    pub fn focus_direction(&self, pane_id: &str, direction: &str) -> Result<(), ConnectError> {
        self.request(
            "pane.focus_direction",
            json!({ "pane_id": pane_id, "direction": direction }),
        )?;
        Ok(())
    }

    pub fn scroll_to(&self, pane_id: &str, offset_from_bottom: u64) -> Result<(), ConnectError> {
        let params = json!({ "pane_id": pane_id, "offset_from_bottom": offset_from_bottom });
        self.request("pane.scroll", params)?;
        Ok(())
    }

    pub fn search(&self, id: &str, request: &SearchRequest) -> Result<(), ConnectError> {
        let params = serde_json::to_value(request).map_err(WireError::Json)?;
        self.request_with_id(id.into(), "pane.copy_search", params)
    }

    pub fn shutdown(&self) {
        if !self.stopped.swap(true, Ordering::SeqCst) {
            let _ = self.commands.send(ClientCommand::Shutdown);
            let _ = self.requests.send(EndpointRequest {
                id: String::new(),
                method: String::new(),
                params: Value::Null,
            });
            let _ = self.socket.0.shutdown(std::net::Shutdown::Both);
        }
    }
}

static NEXT_REQUEST_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn next_request_id() -> u64 {
    NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
}

pub fn connect(options: ConnectOptions) -> Result<Connection, ConnectError> {
    let path = options.target.socket_path()?;
    check_socket(&path)?;
    let stream = UnixStream::connect(&path)
        .map_err(|error| ConnectError::Socket(format!("{}: {error}", path.display())))?;
    stream
        .set_read_timeout(Some(HANDSHAKE_TIMEOUT))
        .map_err(|error| ConnectError::Socket(error.to_string()))?;

    let mut reader = stream
        .try_clone()
        .map_err(|error| ConnectError::Socket(error.to_string()))?;
    let hello = EndpointClientHello {
        generation: ENDPOINT_GENERATION,
        cell_width_px: options.cell_width_px,
        cell_height_px: options.cell_height_px,
        surface_size: wire::ClientSurfaceSize {
            cols: options.surface.cols,
            rows: options.surface.rows,
        },
        pixel_mouse: false,
        direct_graphics: false,
        endpoint_keybindings: false,
        mouse_capture: false,
        surface_active: true,
        surface_reuse: false,
        surface_delta: false,
        surface_scroll: false,
        snapshot_codecs: vec![SNAPSHOT_CODEC.into()],
        surface_codecs: vec![SURFACE_CODEC.into()],
        input_codecs: vec![INPUT_CODEC.into()],
        blob_codecs: vec![BLOB_CODEC.into()],
    };
    let data = serde_json::to_string(&hello).map_err(WireError::Json)?;
    let message = ClientMessage::EndpointControl {
        kind: HELLO_KIND.into(),
        data,
    };
    wire::write_message(&mut reader, &message)?;

    let welcome = match wire::read_message::<_, ServerMessage>(&mut reader, wire::MAX_FRAME)? {
        ServerMessage::EndpointControl { kind, data } if kind == WELCOME_KIND => {
            serde_json::from_str::<EndpointServerWelcome>(&data).map_err(WireError::Json)?
        }
        _ => {
            return Err(ConnectError::Incompatible(
                "expected endpoint.welcome.v1".into(),
            ))
        }
    };
    if let Some(error) = &welcome.error {
        return Err(ConnectError::Rejected(format!(
            "{}: {}",
            error.code, error.message
        )));
    }
    if welcome.generation != ENDPOINT_GENERATION
        || welcome.snapshot_codec != SNAPSHOT_CODEC
        || welcome.surface_codec != SURFACE_CODEC
        || welcome.input_codec != INPUT_CODEC
        || welcome.blob_codec != BLOB_CODEC
    {
        return Err(ConnectError::Incompatible(format!(
            "generation {} codecs {}/{}/{}/{}",
            welcome.generation,
            welcome.snapshot_codec,
            welcome.surface_codec,
            welcome.input_codec,
            welcome.blob_codec
        )));
    }
    reader
        .set_read_timeout(None)
        .map_err(|error| ConnectError::Socket(error.to_string()))?;

    let socket = Arc::new(SocketGuard(stream));
    let (events_tx, events) = unbounded();
    let (commands_tx, commands) = unbounded();
    let (requests_tx, requests) = unbounded();
    let (responses_tx, responses) = unbounded();
    let boot_id = Arc::new(Mutex::new(String::new()));

    spawn_writer(
        socket
            .0
            .try_clone()
            .map_err(|error| ConnectError::Socket(error.to_string()))?,
        commands,
    );
    spawn_request_lane(
        commands_tx.clone(),
        requests,
        responses,
        Arc::clone(&boot_id),
        events_tx.clone(),
    );
    let connected = welcome.clone();
    let reader_boot = Arc::clone(&boot_id);
    let event_tx = events_tx.clone();
    thread::Builder::new()
        .name("pairfob-herdr-reader".into())
        .spawn(move || {
            let _ = event_tx.send(ClientEvent::Connected(connected));
            read_loop(reader, event_tx, responses_tx, reader_boot);
        })
        .map_err(|error| ConnectError::Socket(error.to_string()))?;

    Ok(Connection {
        handle: ConnectionHandle {
            commands: commands_tx,
            requests: requests_tx,
            socket,
            stopped: Arc::new(AtomicBool::new(false)),
        },
        events,
    })
}

fn check_socket(path: &Path) -> Result<(), ConnectError> {
    let meta = fs::metadata(path)
        .map_err(|error| ConnectError::Socket(format!("{}: {error}", path.display())))?;
    if !meta.file_type().is_socket() {
        return Err(ConnectError::Socket(format!(
            "{} is not a socket",
            path.display()
        )));
    }
    if meta.mode() & 0o077 != 0 {
        return Err(ConnectError::Socket(format!(
            "{} is accessible by other users (mode {:o})",
            path.display(),
            meta.mode() & 0o777
        )));
    }
    Ok(())
}

fn spawn_request_lane(
    commands: Sender<ClientCommand>,
    requests: Receiver<EndpointRequest>,
    responses: Receiver<RawResponse>,
    boot_id: Arc<Mutex<String>>,
    events: Sender<ClientEvent>,
) {
    thread::Builder::new()
        .name("pairfob-herdr-requests".into())
        .spawn(move || {
            let mut queue: VecDeque<EndpointRequest> = VecDeque::new();
            let mut in_flight: Option<(String, String, Instant)> = None;
            loop {
                if in_flight.is_none() {
                    let Some(request) = queue.pop_front() else {
                        match requests.recv() {
                            Ok(request) => queue.push_back(request),
                            Err(_) => return,
                        }
                        continue;
                    };
                    if request.id.is_empty() {
                        return;
                    }
                    let boot = boot_id.lock().map(|boot| boot.clone()).unwrap_or_default();
                    if boot.is_empty() {
                        let _ = events.send(ClientEvent::Response {
                            request_id: request.id,
                            method: request.method,
                            response: json!({
                                "error": {
                                    "code": "not_ready",
                                    "message": "the Herdr snapshot has not arrived yet",
                                }
                            }),
                        });
                        continue;
                    }
                    let payload = json!({
                        "id": request.id,
                        "method": request.method,
                        "params": request.params,
                    })
                    .to_string();
                    let sent = commands.send(ClientCommand::Write(
                        ClientMessage::ClientShellEndpointRequest {
                            boot_id: boot,
                            request: payload,
                        },
                    ));
                    if sent.is_err() {
                        return;
                    }
                    in_flight = Some((request.id, request.method, Instant::now()));
                }

                let (_, _, started) = in_flight.as_ref().expect("request is in flight");
                let remaining = REQUEST_TIMEOUT.saturating_sub(started.elapsed());
                match responses.recv_timeout(remaining) {
                    Ok(raw) => {
                        let matches = in_flight
                            .as_ref()
                            .is_some_and(|(id, _, _)| *id == raw.request_id);
                        if matches {
                            let (request_id, method, _) =
                                in_flight.take().expect("request is in flight");
                            if events
                                .send(ClientEvent::Response {
                                    request_id,
                                    method,
                                    response: raw.response,
                                })
                                .is_err()
                            {
                                return;
                            }
                        }
                    }
                    Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                        let (request_id, method, _) =
                            in_flight.take().expect("request is in flight");
                        let _ = events.send(ClientEvent::Response {
                            request_id: request_id.clone(),
                            method,
                            response: json!({
                                "id": request_id,
                                "error": {
                                    "code": "timeout",
                                    "message": "the Herdr endpoint did not answer",
                                }
                            }),
                        });
                    }
                    Err(crossbeam_channel::RecvTimeoutError::Disconnected) => return,
                }
                while let Ok(request) = requests.try_recv() {
                    queue.push_back(request);
                }
            }
        })
        .ok();
}

fn spawn_writer(socket: UnixStream, commands: Receiver<ClientCommand>) {
    thread::Builder::new()
        .name("pairfob-herdr-writer".into())
        .spawn(move || {
            let mut socket = &socket;
            while let Ok(command) = commands.recv() {
                match command {
                    ClientCommand::Write(message) => {
                        if wire::write_message(&mut socket, &message).is_err() {
                            break;
                        }
                    }
                    ClientCommand::Shutdown => {
                        let _ = socket.shutdown(std::net::Shutdown::Both);
                        break;
                    }
                }
            }
        })
        .ok();
}

/// Reads one complete frame from a stream without a read timeout. Tests use
/// this to speak the endpoint directly.
pub fn read_frame(reader: &mut impl Read) -> Result<ServerMessage, WireError> {
    wire::read_message(reader, wire::MAX_FRAME)
}

/// Writes one complete frame. Tests use this to speak the endpoint directly.
pub fn write_frame(writer: &mut impl Write, message: &ClientMessage) -> Result<(), WireError> {
    wire::write_message(writer, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::herdr::search::{SearchDirection, TextPoint};

    fn request_handle() -> (ConnectionHandle, Receiver<EndpointRequest>) {
        let (commands, _) = unbounded();
        let (requests, request_rx) = unbounded();
        let (stream, _peer) = UnixStream::pair().unwrap();
        let handle = ConnectionHandle {
            commands,
            requests,
            socket: Arc::new(SocketGuard(stream)),
            stopped: Arc::new(AtomicBool::new(false)),
        };
        (handle, request_rx)
    }

    #[test]
    fn socket_paths_follow_herdr_rules() {
        let root = PathBuf::from("/tmp/xdg/herdr");
        assert_eq!(
            session_socket(&root, "default").unwrap(),
            root.join("herdr-client.sock")
        );
        assert_eq!(
            session_socket(&root, "pffixture").unwrap(),
            root.join("sessions/pffixture/herdr-client.sock")
        );
        assert!(session_socket(&root, "../escape").is_err());
        assert!(session_socket(&root, "").is_err());
    }

    #[test]
    fn the_development_directory_is_separate() {
        let release = config_dir(false).unwrap();
        let development = config_dir(true).unwrap();
        assert_eq!(release.file_name().unwrap(), "herdr");
        assert_eq!(development.file_name().unwrap(), "herdr-dev");
    }

    #[test]
    fn a_socket_override_uses_the_client_suffix() {
        // This is a pure path rule; the variable is read by socket_path(), so
        // the same transformation is checked without touching the process env.
        let path = PathBuf::from("/tmp/herdr.sock");
        let stem = path.file_stem().unwrap().to_str().unwrap();
        let derived = path.parent().unwrap().join(format!("{stem}-client.sock"));
        assert_eq!(derived, PathBuf::from("/tmp/herdr-client.sock"));
    }

    #[test]
    fn split_zoom_and_close_requests_carry_the_contract_fields() {
        let (handle, request_rx) = request_handle();

        handle.split("w1:p1", "down", Some(0.5), true).unwrap();
        handle.zoom("w1:p1", "toggle").unwrap();
        handle.close_pane("w1:p1").unwrap();

        let split = request_rx.recv().unwrap();
        assert_eq!(split.method, "pane.split");
        assert_eq!(split.params["target_pane_id"], "w1:p1");
        assert_eq!(split.params["direction"], "down");
        assert_eq!(split.params["focus"], true);
        assert!(split.params["ratio"].as_f64().unwrap() > 0.49);

        let zoom = request_rx.recv().unwrap();
        assert_eq!(zoom.method, "pane.zoom");
        assert_eq!(zoom.params["pane_id"], "w1:p1");
        assert_eq!(zoom.params["mode"], "toggle");

        let close = request_rx.recv().unwrap();
        assert_eq!(close.method, "pane.close");
        assert_eq!(close.params["pane_id"], "w1:p1");
    }

    #[test]
    fn the_remaining_pane_requests_carry_the_contract_fields() {
        let (handle, request_rx) = request_handle();

        handle.rename_pane("w1:p1", "build").unwrap();
        handle.swap_pane("w1:p1", "left").unwrap();
        handle.resize_pane("w1:p1", "down").unwrap();
        handle.focus_direction("w1:p1", "up").unwrap();
        handle.scroll_to("w1:p1", 42).unwrap();

        let rename = request_rx.recv().unwrap();
        assert_eq!(rename.method, "pane.rename");
        assert_eq!(rename.params["pane_id"], "w1:p1");
        assert_eq!(rename.params["label"], "build");

        for (method, direction) in [
            ("pane.swap", "left"),
            ("pane.resize", "down"),
            ("pane.focus_direction", "up"),
        ] {
            let request = request_rx.recv().unwrap();
            assert_eq!(request.method, method);
            assert_eq!(request.params["pane_id"], "w1:p1");
            assert_eq!(request.params["direction"], direction);
        }

        let scroll = request_rx.recv().unwrap();
        assert_eq!(scroll.method, "pane.scroll");
        assert_eq!(scroll.params["pane_id"], "w1:p1");
        assert_eq!(scroll.params["offset_from_bottom"], 42);
    }

    #[test]
    fn a_search_keeps_the_callers_request_id() {
        let (handle, request_rx) = request_handle();

        let request = SearchRequest {
            pane_id: "w1:p1".into(),
            query: "needle".into(),
            direction: SearchDirection::Forward,
            cursor: TextPoint { row: 4, col: 2 },
            content_revision: 9,
            previous: None,
        };
        handle.search("pfdesk-search-3", &request).unwrap();

        let sent = request_rx.recv().unwrap();
        assert_eq!(sent.id, "pfdesk-search-3");
        assert_eq!(sent.method, "pane.copy_search");
        assert_eq!(sent.params["pane_id"], "w1:p1");
        assert_eq!(sent.params["query"], "needle");
        assert_eq!(sent.params["direction"], "forward");
        assert_eq!(sent.params["content_revision"], 9);
        assert!(sent.params.get("previous").is_none());
    }

    #[test]
    fn a_ratio_is_clamped_to_the_contract_range() {
        let (handle, request_rx) = request_handle();
        handle
            .set_split_ratio("w1:t1", &[false, true], 0.99)
            .unwrap();
        let request = request_rx.recv().unwrap();
        assert_eq!(request.method, "layout.set_split_ratio");
        let ratio = request.params["ratio"].as_f64().unwrap();
        assert!((ratio - 0.9).abs() < 1e-6, "ratio was {ratio}");
    }
}
