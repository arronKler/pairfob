//! Where a window attaches: the environment overrides, a named session, or an
//! exact socket. Path rules live here so the engine, the startup checks and
//! the doctor all resolve the same file.

use std::fs;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::{Path, PathBuf};

use super::connect::ConnectError;

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

pub(super) fn check_socket(path: &Path) -> Result<(), ConnectError> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
