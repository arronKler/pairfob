//! The socket view of one `pairfob-chat` process. The view is an observer: it
//! sends commands with fresh ids and applies snapshots and changes. Nothing
//! here touches the relay or the daemon.

use std::fmt;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;

use crossbeam_channel::{unbounded, Receiver, Sender};

use super::wire::{
    Attachment, Change, ClientFrame, Command, Cursor, FrameError, ServerFrame, State, MAX_LINE,
    VERSION,
};

/// Frames that arrive before the command that caused them are already in the
/// channel; 128 is far more than one prompt produces between two reads.
const EVENT_BACKLOG: usize = 128;

#[derive(Clone, Debug)]
pub enum ChatEvent {
    Welcome {
        epoch: String,
        seq: i64,
    },
    Snapshot {
        epoch: String,
        seq: i64,
        state: Box<State>,
    },
    Changes {
        epoch: String,
        changes: Vec<Change>,
    },
    Result {
        id: String,
        ok: bool,
        error: Option<FrameError>,
    },
    Closed(String),
}

#[derive(Debug)]
pub enum AttachError {
    InvalidId,
    NoSocket(PathBuf),
    Unsafe(String),
    Connect(String),
    Unsupported,
}

impl fmt::Display for AttachError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidId => write!(f, "the chat id is not 16 lowercase hex characters"),
            Self::NoSocket(path) => write!(f, "no chat socket at {}", path.display()),
            Self::Unsafe(reason) => write!(f, "refusing the chat socket: {reason}"),
            Self::Connect(reason) => write!(f, "could not connect: {reason}"),
            Self::Unsupported => write!(f, "chat sockets are not supported on this platform"),
        }
    }
}

pub struct ChatConnection {
    pub handle: ChatHandle,
    pub events: Receiver<ChatEvent>,
}

/// Commands go through one writer thread, so a frame is written whole even
/// while the reader is blocked on the next line.
pub struct ChatHandle {
    commands: Sender<Vec<u8>>,
    stop: Arc<AtomicBool>,
    socket: Arc<UnixStream>,
    next_id: AtomicU64,
}

impl ChatHandle {
    pub fn prompt(&self, text: &str) -> bool {
        self.send_prompt_with(text, Vec::new())
    }

    /// Send a turn with its already-encoded attachments. A prompt carrying
    /// only images is valid, so the empty check covers both fields.
    pub fn send_prompt_with(&self, text: &str, attachments: Vec<Attachment>) -> bool {
        if text.trim().is_empty() && attachments.is_empty() {
            return false;
        }
        self.command(Command::Prompt {
            text: text.to_owned(),
            attachments,
        })
    }

    pub fn cancel(&self) -> bool {
        self.command(Command::Cancel)
    }

    pub fn answer(&self, request_id: &str, option_id: &str) -> bool {
        self.command(Command::Answer {
            request_id: request_id.to_owned(),
            option_id: option_id.to_owned(),
        })
    }

    pub fn set_mode(&self, mode_id: &str) -> bool {
        self.command(Command::SetMode {
            mode_id: mode_id.to_owned(),
        })
    }

    pub fn set_option(&self, option_id: &str, value: &str) -> bool {
        self.command(Command::SetOption {
            option_id: option_id.to_owned(),
            value: value.to_owned(),
        })
    }

    pub fn unqueue(&self, queue_id: &str) -> bool {
        self.command(Command::Unqueue {
            queue_id: queue_id.to_owned(),
        })
    }

    pub fn set_auto_accept(&self, enabled: bool) -> bool {
        self.command(Command::SetAutoAccept { enabled })
    }

    fn command(&self, command: Command) -> bool {
        let id = format!(
            "pfdesk-chat-{}",
            self.next_id.fetch_add(1, Ordering::Relaxed) + 1
        );
        self.send(ClientFrame::Command {
            v: VERSION,
            id,
            command,
        })
    }

    fn send(&self, frame: ClientFrame) -> bool {
        let Ok(mut line) = serde_json::to_vec(&frame) else {
            return false;
        };
        if line.len() > MAX_LINE {
            return false;
        }
        line.push(b'\n');
        self.commands.send(line).is_ok()
    }

    fn close(&self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = self.socket.shutdown(std::net::Shutdown::Both);
    }
}

impl Drop for ChatHandle {
    fn drop(&mut self) {
        self.close();
    }
}

/// Attach to `<id>` at `cursor`, or from scratch when the cursor is absent.
pub fn attach(id: &str, cursor: Option<Cursor>) -> Result<ChatConnection, AttachError> {
    if !is_valid_id(id) {
        return Err(AttachError::InvalidId);
    }
    let path = socket_path(id).ok_or(AttachError::InvalidId)?;
    check_socket(&path)?;
    let stream =
        UnixStream::connect(&path).map_err(|error| AttachError::Connect(error.to_string()))?;
    let reader = stream
        .try_clone()
        .map_err(|error| AttachError::Connect(error.to_string()))?;
    let socket = Arc::new(stream);
    let stop = Arc::new(AtomicBool::new(false));
    let (command_tx, command_rx) = unbounded::<Vec<u8>>();
    let (event_tx, event_rx) = crossbeam_channel::bounded(EVENT_BACKLOG);

    let hello = ClientFrame::Hello {
        v: VERSION,
        client: "pairfob-desktop",
        cursor,
    };
    let mut line =
        serde_json::to_vec(&hello).map_err(|error| AttachError::Connect(error.to_string()))?;
    line.push(b'\n');
    let mut writer = socket
        .try_clone()
        .map_err(|error| AttachError::Connect(error.to_string()))?;
    writer
        .write_all(&line)
        .map_err(|error| AttachError::Connect(error.to_string()))?;

    let write_socket = Arc::clone(&socket);
    let write_stop = Arc::clone(&stop);
    thread::spawn(move || write_loop(writer, command_rx, &write_socket, &write_stop));
    let read_stop = Arc::clone(&stop);
    thread::spawn(move || read_loop(reader, event_tx, &read_stop));

    Ok(ChatConnection {
        handle: ChatHandle {
            commands: command_tx,
            stop,
            socket,
            next_id: AtomicU64::new(0),
        },
        events: event_rx,
    })
}

fn write_loop(
    mut writer: UnixStream,
    commands: Receiver<Vec<u8>>,
    socket: &UnixStream,
    stop: &AtomicBool,
) {
    while let Ok(line) = commands.recv() {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        if writer
            .write_all(&line)
            .and_then(|_| writer.flush())
            .is_err()
        {
            stop.store(true, Ordering::SeqCst);
            let _ = socket.shutdown(std::net::Shutdown::Both);
            return;
        }
    }
}

fn read_loop(stream: UnixStream, events: Sender<ChatEvent>, stop: &AtomicBool) {
    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        if line.len() > MAX_LINE + 1 {
            let _ = events.send(ChatEvent::Closed("a frame exceeded 4 MiB".into()));
            return;
        }
        let frame = match serde_json::from_slice::<ServerFrame>(trim_newline(&line)) {
            Ok(frame) => frame,
            Err(error) => {
                let _ = events.send(ChatEvent::Closed(format!("invalid frame: {error}")));
                return;
            }
        };
        if frame.version() != VERSION {
            let _ = events.send(ChatEvent::Closed(format!(
                "unsupported chat protocol version {}",
                frame.version()
            )));
            return;
        }
        let event = match frame {
            ServerFrame::Welcome { epoch, seq, .. } => ChatEvent::Welcome { epoch, seq },
            ServerFrame::Snapshot {
                epoch, seq, state, ..
            } => ChatEvent::Snapshot { epoch, seq, state },
            ServerFrame::Changes { epoch, changes, .. } => ChatEvent::Changes { epoch, changes },
            ServerFrame::Result { id, ok, error, .. } => ChatEvent::Result { id, ok, error },
            ServerFrame::Ping { .. } => continue,
            ServerFrame::Pong { .. } => continue,
        };
        if events.send(event).is_err() {
            break;
        }
    }
    if !stop.load(Ordering::SeqCst) {
        let _ = events.send(ChatEvent::Closed(
            "the chat process closed the socket".into(),
        ));
    }
}

fn trim_newline(line: &[u8]) -> &[u8] {
    let line = line.strip_suffix(b"\n").unwrap_or(line);
    line.strip_suffix(b"\r").unwrap_or(line)
}

/// The contract's id is 16 lowercase hex characters, nothing else.
pub fn is_valid_id(id: &str) -> bool {
    id.len() == 16
        && id
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn socket_path(id: &str) -> Option<PathBuf> {
    let state = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local").join("state"))
        })?;
    Some(
        state
            .join("pairfob")
            .join("chat")
            .join(format!("{id}.sock")),
    )
}

/// The process refuses a peer with another uid; this is the same check made
/// from this side, plus the mode. A socket group- or world-accessible could be
/// answered by another user's process, so it is refused before connecting.
fn check_socket(path: &Path) -> Result<(), AttachError> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| AttachError::NoSocket(path.to_path_buf()))?;
    if !metadata.file_type().is_socket() {
        return Err(AttachError::Unsafe(format!(
            "{} is not a socket",
            path.display()
        )));
    }
    let uid = unsafe { libc::geteuid() };
    if metadata.uid() != uid {
        return Err(AttachError::Unsafe("it belongs to another user".into()));
    }
    if metadata.mode() & 0o077 != 0 {
        return Err(AttachError::Unsafe(format!(
            "its mode {:o} is open to other users",
            metadata.mode() & 0o777
        )));
    }
    let Some(parent) = path.parent() else {
        return Err(AttachError::Unsafe("it has no parent directory".into()));
    };
    if let Ok(directory) = fs::metadata(parent) {
        if directory.uid() != uid || directory.mode() & 0o077 != 0 {
            return Err(AttachError::Unsafe(
                "its directory is open to other users".into(),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_exactly_sixteen_lowercase_hex_characters() {
        assert!(is_valid_id("0123456789abcdef"));
        assert!(!is_valid_id("0123456789ABCDEF"));
        assert!(!is_valid_id("0123456789abcde"));
        assert!(!is_valid_id("0123456789abcdef0"));
        assert!(!is_valid_id("../etc/passwd000"));
    }

    #[test]
    fn the_socket_lives_under_the_state_directory() {
        let id = "0123456789abcdef";
        let path = socket_path(id).unwrap();
        assert!(path.ends_with(format!("pairfob/chat/{id}.sock")));
    }

    #[test]
    fn a_missing_socket_is_reported_before_connecting() {
        let error = check_socket(Path::new("/nonexistent/pairfob/chat/x.sock")).unwrap_err();
        assert!(matches!(error, AttachError::NoSocket(_)));
    }

    #[test]
    fn a_world_writable_socket_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(
            dir.path(),
            std::os::unix::fs::PermissionsExt::from_mode(0o700),
        )
        .unwrap();
        let path = dir.path().join("view.sock");
        let _listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o666))
            .unwrap();
        let error = check_socket(&path).unwrap_err();
        assert!(matches!(error, AttachError::Unsafe(reason) if reason.contains("mode")));
    }

    #[test]
    fn a_private_socket_is_accepted() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(
            dir.path(),
            std::os::unix::fs::PermissionsExt::from_mode(0o700),
        )
        .unwrap();
        let path = dir.path().join("view.sock");
        let _listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600))
            .unwrap();
        check_socket(&path).unwrap();
    }

    /// The reader is a plain thread over a real socketpair, so framing is
    /// checked against bytes rather than a parser mock.
    #[test]
    fn the_reader_turns_lines_into_events_and_closes_on_a_bad_frame() {
        let (mut server, client) = UnixStream::pair().unwrap();
        let (events, received) = crossbeam_channel::bounded(8);
        let stop = AtomicBool::new(false);
        let handle = thread::spawn(move || read_loop(client, events, &stop));
        server
            .write_all(b"{\"v\":1,\"type\":\"welcome\",\"epoch\":\"e\",\"seq\":3}\n")
            .unwrap();
        let first = received.recv().unwrap();
        assert!(matches!(first, ChatEvent::Welcome { seq: 3, .. }));
        server.write_all(b"not json\n").unwrap();
        let second = received.recv().unwrap();
        assert!(matches!(second, ChatEvent::Closed(reason) if reason.contains("invalid frame")));
        drop(server);
        handle.join().unwrap();
    }

    #[test]
    fn a_ping_is_not_surfaced_to_the_view() {
        let (mut server, client) = UnixStream::pair().unwrap();
        let (events, received) = crossbeam_channel::bounded(8);
        let stop = AtomicBool::new(false);
        let handle = thread::spawn(move || read_loop(client, events, &stop));
        server.write_all(b"{\"v\":1,\"type\":\"ping\"}\n").unwrap();
        server
            .write_all(b"{\"v\":1,\"type\":\"welcome\",\"epoch\":\"e\",\"seq\":1}\n")
            .unwrap();
        assert!(matches!(
            received.recv().unwrap(),
            ChatEvent::Welcome { seq: 1, .. }
        ));
        drop(server);
        handle.join().unwrap();
    }

    #[test]
    fn a_long_line_closes_instead_of_being_parsed() {
        let (mut server, client) = UnixStream::pair().unwrap();
        let (events, received) = crossbeam_channel::bounded(8);
        let stop = AtomicBool::new(false);
        let handle = thread::spawn(move || read_loop(client, events, &stop));
        server.write_all(&vec![b'x'; MAX_LINE + 2]).unwrap();
        server.write_all(b"\n").unwrap();
        assert!(matches!(
            received.recv().unwrap(),
            ChatEvent::Closed(reason) if reason.contains("4 MiB")
        ));
        drop(server);
        handle.join().unwrap();
    }

    #[test]
    fn a_connection_that_ends_without_a_close_event_is_reported_once() {
        let (server, client) = UnixStream::pair().unwrap();
        let (events, received) = crossbeam_channel::bounded(8);
        let stop = AtomicBool::new(false);
        let handle = thread::spawn(move || read_loop(client, events, &stop));
        drop(server);
        assert!(matches!(received.recv().unwrap(), ChatEvent::Closed(_)));
        handle.join().unwrap();
    }
}
