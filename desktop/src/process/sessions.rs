//! The Herdr sessions on this computer: the default session plus every named
//! one that has a directory. `alive` only means its client socket accepts a
//! connection, not that a handshake would succeed.

use std::fs;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::herdr::ConnectTarget;

const SOCKET: &str = "herdr-client.sock";
const PROBE_TIMEOUT: Duration = Duration::from_millis(200);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HerdrSession {
    /// `None` is the default session.
    pub name: Option<String>,
    pub socket: PathBuf,
    pub alive: bool,
}

/// The default session first, then named sessions in name order.
pub fn list() -> Vec<HerdrSession> {
    config_dir()
        .map(|config_dir| list_in(&config_dir))
        .unwrap_or_default()
}

/// The Herdr configuration root, taken from the endpoint client so XDG
/// resolution stays in one place.
fn config_dir() -> Option<PathBuf> {
    ConnectTarget::Session {
        name: "default".to_owned(),
        development: false,
    }
    .socket_path()
    .ok()
    .and_then(|socket| socket.parent().map(Path::to_path_buf))
}

fn list_in(config_dir: &Path) -> Vec<HerdrSession> {
    let sessions_dir = config_dir.join("sessions");
    let mut names: Vec<String> = fs::read_dir(&sessions_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            if !entry.file_type().ok()?.is_dir() {
                return None;
            }
            let name = entry.file_name().into_string().ok()?;
            valid_name(&name).then_some(name)
        })
        .collect();
    names.sort();

    let socket = config_dir.join(SOCKET);
    let mut sessions = vec![HerdrSession {
        name: None,
        alive: alive(&socket),
        socket,
    }];
    for name in names {
        let socket = sessions_dir.join(&name).join(SOCKET);
        sessions.push(HerdrSession {
            name: Some(name),
            alive: alive(&socket),
            socket,
        });
    }
    sessions
}

/// The same rule as `herdr::connect`: a name is only usable when it cannot
/// escape the sessions directory.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !matches!(name, "." | "..")
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// A connect on a dead or missing unix socket fails at once. The timeouts
/// bound the probe if a listener accepts but never answers a later exchange.
fn alive(socket: &Path) -> bool {
    match UnixStream::connect(socket) {
        Ok(stream) => {
            let _ = stream.set_read_timeout(Some(PROBE_TIMEOUT));
            let _ = stream.set_write_timeout(Some(PROBE_TIMEOUT));
            true
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    fn tempdir() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("pf-sessions-")
            .tempdir_in("/tmp")
            .unwrap()
    }

    #[test]
    fn the_default_comes_first_and_named_sessions_follow_in_order() {
        let root = tempdir();
        fs::create_dir_all(root.path().join("sessions/beta")).unwrap();
        fs::create_dir_all(root.path().join("sessions/alpha")).unwrap();
        fs::create_dir_all(root.path().join("sessions/.hidden")).unwrap();
        fs::create_dir_all(root.path().join("sessions/bad name")).unwrap();
        fs::write(root.path().join("sessions/not-a-session"), b"").unwrap();

        let sessions = list_in(root.path());
        let names: Vec<Option<&str>> = sessions
            .iter()
            .map(|session| session.name.as_deref())
            .collect();
        assert_eq!(
            names,
            vec![None, Some(".hidden"), Some("alpha"), Some("beta")]
        );
        assert_eq!(sessions[0].socket, root.path().join("herdr-client.sock"));
        assert_eq!(
            sessions[1].socket,
            root.path().join("sessions/.hidden/herdr-client.sock")
        );
        assert!(sessions.iter().all(|session| !session.alive));
    }

    #[test]
    fn a_listening_socket_is_alive_and_a_stale_one_is_not() {
        let root = tempdir();
        let socket = root.path().join("herdr-client.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        assert!(list_in(root.path())[0].alive);
        drop(listener);
        assert!(!list_in(root.path())[0].alive);
    }

    #[test]
    fn names_follow_the_connect_rule() {
        assert!(valid_name("pffixture"));
        assert!(valid_name(".hidden"));
        assert!(valid_name("a.b_c-d"));
        assert!(!valid_name(""));
        assert!(!valid_name("."));
        assert!(!valid_name(".."));
        assert!(!valid_name("bad name"));
        assert!(!valid_name("slash/name"));
        assert!(!valid_name(&"x".repeat(65)));
    }
}
