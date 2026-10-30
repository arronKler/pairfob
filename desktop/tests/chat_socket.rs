//! The desktop side of pairfob-chat.v1 against a real socket. The unit tests
//! cover framing and the reducer; this checks the handshake, a command, and a
//! change arriving over the transport the window actually uses.

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant};

use pairfob_desktop::chat::{attach, Applied, ChatEvent};

const ID: &str = "0123456789abcdef";

struct PinnedState {
    previous: Option<std::ffi::OsString>,
}

impl PinnedState {
    fn set(path: &PathBuf) -> Self {
        let previous = std::env::var_os("XDG_STATE_HOME");
        std::env::set_var("XDG_STATE_HOME", path);
        Self { previous }
    }
}

impl Drop for PinnedState {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(value) => std::env::set_var("XDG_STATE_HOME", value),
            None => std::env::remove_var("XDG_STATE_HOME"),
        }
    }
}

fn wait_for<T>(mut read: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if let Some(value) = read() {
            return value;
        }
        thread::sleep(Duration::from_millis(10));
    }
    panic!("timed out waiting for the chat event");
}

#[test]
fn a_view_handshakes_reads_a_snapshot_and_sends_a_prompt() {
    let root = tempfile::tempdir().unwrap();
    let _pinned = PinnedState::set(&root.path().to_path_buf());
    let chat_dir = root.path().join("pairfob").join("chat");
    fs::create_dir_all(&chat_dir).unwrap();
    fs::set_permissions(&chat_dir, fs::Permissions::from_mode(0o700)).unwrap();
    let socket = chat_dir.join(format!("{ID}.sock"));
    let listener = UnixListener::bind(&socket).unwrap();
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).unwrap();

    let server = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut writer = stream.try_clone().unwrap();
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let hello: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(hello["type"], "hello");
        assert_eq!(hello["v"], 1);
        assert_eq!(hello["client"], "pairfob-desktop");
        assert!(hello["cursor"].is_null());

        writer
            .write_all(b"{\"v\":1,\"type\":\"welcome\",\"epoch\":\"e1\",\"seq\":7}\n")
            .unwrap();
        writer
            .write_all(
                b"{\"v\":1,\"type\":\"snapshot\",\"epoch\":\"e1\",\"seq\":7,\"state\":{\"id\":\"0123456789abcdef\",\"title\":\"claude\",\"agent\":\"claude\",\"status\":\"idle\",\"entries\":[{\"id\":\"user-1\",\"kind\":\"user\",\"text\":\"hello\",\"at\":1}],\"plan\":[],\"modes\":[],\"options\":[],\"queue\":[],\"auto_accept\":false}}\n",
            )
            .unwrap();

        let mut command = String::new();
        reader.read_line(&mut command).unwrap();
        let frame: serde_json::Value = serde_json::from_str(&command).unwrap();
        assert_eq!(frame["type"], "command");
        assert_eq!(frame["command"]["kind"], "prompt");
        assert_eq!(frame["command"]["text"], "fix the test");
        let id = frame["id"].as_str().unwrap().to_owned();
        writer
            .write_all(
                format!("{{\"v\":1,\"type\":\"result\",\"id\":\"{id}\",\"ok\":true}}\n").as_bytes(),
            )
            .unwrap();
        writer
            .write_all(
                b"{\"v\":1,\"type\":\"changes\",\"epoch\":\"e1\",\"seq\":8,\"changes\":[{\"seq\":8,\"ops\":[{\"op\":\"append_entry\",\"entry\":{\"id\":\"agent-1\",\"kind\":\"agent\",\"text\":\"on it\",\"streaming\":true,\"at\":2}}]}]}\n",
            )
            .unwrap();
        // Keep the socket open until the view has read both frames.
        thread::sleep(Duration::from_millis(200));
    });

    let connection = attach(ID, None).expect("attach");
    assert!(connection.handle.prompt("fix the test"));

    let mut state = pairfob_desktop::chat::ChatState::default();
    let mut saw_result = false;
    let mut hydrate = false;
    let mut change = false;
    while !(saw_result && hydrate && change) {
        let event = wait_for(|| connection.events.try_recv().ok());
        match event {
            ChatEvent::Welcome { epoch, seq } => {
                assert_eq!(epoch, "e1");
                assert_eq!(seq, 7);
            }
            ChatEvent::Snapshot {
                epoch,
                seq,
                state: snapshot,
            } => {
                state.apply_snapshot(&epoch, seq, *snapshot);
                assert_eq!(state.state.entries[0].text, "hello");
                hydrate = true;
            }
            ChatEvent::Changes {
                epoch,
                changes: deltas,
            } => {
                for delta in &deltas {
                    assert_eq!(state.apply_change(&epoch, delta), Ok(Applied::Applied));
                }
                change = true;
            }
            ChatEvent::Result { ok, .. } => {
                assert!(ok);
                saw_result = true;
            }
            ChatEvent::Closed(reason) => panic!("closed early: {reason}"),
        }
    }
    assert_eq!(state.state.entries.len(), 2);
    assert_eq!(state.state.entries[1].text, "on it");
    assert!(state.state.entries[1].streaming);
    server.join().unwrap();
}
