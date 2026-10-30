//! The desktop release manifest: one version, one commit, and a checksum for
//! each published platform. Every value is checked before a download starts.

use std::collections::BTreeMap;

use serde::Deserialize;

use super::version::Version;

/// The desktop binaries are small; a larger file is not one of ours.
pub const MAX_ARTIFACT: u64 = 64 * 1024 * 1024;

pub const TARGETS: [&str; 4] = ["darwin-amd64", "darwin-arm64", "linux-amd64", "linux-arm64"];

#[derive(Clone, Debug, Deserialize)]
pub struct File {
    #[serde(deserialize_with = "deserialize_sha256")]
    pub sha256: String,
    pub size: u64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Manifest {
    pub schema: u32,
    pub version: String,
    pub commit: String,
    pub files: BTreeMap<String, File>,
}

impl Manifest {
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        let manifest: Self = serde_json::from_slice(bytes)
            .map_err(|error| format!("invalid release manifest: {error}"))?;
        if manifest.schema != 1 {
            return Err(format!(
                "unsupported release manifest schema {}",
                manifest.schema
            ));
        }
        if Version::parse(&manifest.version).is_none() {
            return Err("release manifest has no three-part version".into());
        }
        if manifest.commit.len() != 40 || !manifest.commit.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("release manifest has no source commit".into());
        }
        if manifest.files.is_empty() {
            return Err("release manifest lists no builds".into());
        }
        for (target, file) in &manifest.files {
            if !TARGETS.contains(&target.as_str()) {
                return Err(format!(
                    "release manifest names an unknown target: {target}"
                ));
            }
            if file.size == 0 || file.size > MAX_ARTIFACT {
                return Err(format!("release manifest has an invalid size for {target}"));
            }
        }
        Ok(manifest)
    }

    pub fn version(&self) -> Option<Version> {
        Version::parse(&self.version)
    }

    pub fn file(&self, target: &str) -> Option<&File> {
        self.files.get(target)
    }
}

/// The target name this executable was built for, or `None` on a platform the
/// channel does not publish.
pub fn host_target() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("macos", "x86_64") => Some("darwin-amd64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        ("linux", "x86_64") => Some("linux-amd64"),
        _ => None,
    }
}

fn deserialize_sha256<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(serde::de::Error::custom("invalid SHA-256"));
    }
    Ok(value.to_ascii_lowercase())
}
