//! Images carried with a chat prompt: the file pick, the 8 MiB cap, and the
//! base64 wire shape. The bytes decide the mime; an extension never does.

use std::fs;
use std::path::Path;

use base64::Engine as _;

use super::wire::{Attachment, MAX_LINE};

/// The server rejects a decoded attachment above this size.
pub const MAX_ATTACHMENT_BYTES: usize = 8 * 1024 * 1024;

const PNG_MAGIC: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

/// One image the composer will send with the next prompt. It stays local
/// until Send, so removing a chip costs nothing on the wire.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingAttachment {
    pub name: String,
    pub mime: String,
    pub bytes: Vec<u8>,
}

impl PendingAttachment {
    pub fn size(&self) -> usize {
        self.bytes.len()
    }

    pub fn to_wire(&self) -> Attachment {
        Attachment {
            name: self.name.clone(),
            mime: self.mime.clone(),
            data: base64::engine::general_purpose::STANDARD.encode(&self.bytes),
        }
    }
}

/// Read one dropped or picked file. The length check keeps an oversize file
/// from being read at all; `from_encoded` repeats it if the file grew meanwhile.
pub fn from_path(path: &Path) -> Result<PendingAttachment, String> {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| format!("{} has no file name", path.display()))?;
    let metadata = fs::metadata(path).map_err(|error| format!("could not read {name}: {error}"))?;
    if !metadata.is_file() {
        return Err(format!("{name} is not a file"));
    }
    if metadata.len() > MAX_ATTACHMENT_BYTES as u64 {
        return Err(over_limit(&name, metadata.len() as usize));
    }
    let bytes = fs::read(path).map_err(|error| format!("could not read {name}: {error}"))?;
    from_encoded(name, bytes)
}

/// A pasted image. GPUI hands clipboard images as encoded bytes, so the name
/// comes from the view and the mime still comes from the bytes.
pub fn from_encoded(name: String, bytes: Vec<u8>) -> Result<PendingAttachment, String> {
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(over_limit(&name, bytes.len()));
    }
    let mime = sniff(&bytes).ok_or_else(|| not_an_image(&name))?;
    Ok(PendingAttachment {
        name,
        mime: mime.to_owned(),
        bytes,
    })
}

/// A pasted image the clipboard declared as PNG. The magic still decides.
pub fn from_png(name: String, png: Vec<u8>) -> Result<PendingAttachment, String> {
    let attachment = from_encoded(name, png)?;
    if attachment.mime != "image/png" {
        return Err(format!("{} is not a PNG image", attachment.name));
    }
    Ok(attachment)
}

/// Whether a prompt still fits the contract's 4 MiB line. Base64 grows the
/// bytes by a third, so this limits an image on this transport well before
/// the server's 8 MiB decoded cap would.
pub fn fits_frame(text: &str, attachments: &[PendingAttachment]) -> bool {
    let mut length = 128 + escaped(text);
    for attachment in attachments {
        length = length
            .saturating_add(escaped(&attachment.name))
            .saturating_add(escaped(&attachment.mime))
            .saturating_add(attachment.bytes.len().div_ceil(3) * 4)
            .saturating_add(32);
    }
    length <= MAX_LINE
}

/// A JSON string can grow by one byte per quote or backslash; twice the raw
/// length is a safe bound for the text a composer carries.
fn escaped(value: &str) -> usize {
    value.len().saturating_mul(2)
}

fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(PNG_MAGIC) {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn over_limit(name: &str, bytes: usize) -> String {
    format!(
        "{name} is {:.1} MiB; attachments are limited to {} MiB",
        bytes as f64 / (1024. * 1024.),
        MAX_ATTACHMENT_BYTES / (1024 * 1024)
    )
}

fn not_an_image(name: &str) -> String {
    format!("{name} is not an image; only PNG, JPEG, GIF and WebP can be attached")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
    const JPEG: &[u8] = &[0xff, 0xd8, 0xff, 0xe0, 0, 0];

    fn write(dir: &Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = dir.join(name);
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(bytes).unwrap();
        path
    }

    #[test]
    fn magic_bytes_decide_the_mime_not_the_extension() {
        let dir = tempfile::tempdir().unwrap();
        let png = from_path(&write(dir.path(), "shot.txt", PNG)).unwrap();
        assert_eq!(png.mime, "image/png");
        assert_eq!(png.name, "shot.txt");
        let jpeg = from_path(&write(dir.path(), "shot.png", JPEG)).unwrap();
        assert_eq!(jpeg.mime, "image/jpeg");
    }

    #[test]
    fn a_text_file_is_refused_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let error = from_path(&write(dir.path(), "notes.txt", b"hello")).unwrap_err();
        assert!(error.contains("notes.txt"), "{error}");
        assert!(error.contains("only PNG, JPEG, GIF and WebP"), "{error}");
    }

    #[test]
    fn an_oversize_file_is_refused_from_its_length_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("huge.png");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len((MAX_ATTACHMENT_BYTES + 1) as u64).unwrap();
        let error = from_path(&path).unwrap_err();
        assert!(error.contains("huge.png"), "{error}");
        assert!(error.contains("8 MiB"), "{error}");
    }

    #[test]
    fn a_pasted_image_still_has_to_be_an_image() {
        assert!(from_png("paste.png".into(), PNG.to_vec()).is_ok());
        assert!(from_png("paste.png".into(), JPEG.to_vec()).is_err());
        let jpeg = from_encoded("paste.png".into(), JPEG.to_vec()).unwrap();
        assert_eq!(jpeg.mime, "image/jpeg");
    }

    #[test]
    fn the_wire_attachment_is_named_and_base64_encoded() {
        let attachment = from_encoded("shot.png".into(), PNG.to_vec()).unwrap();
        let wire = attachment.to_wire();
        assert_eq!(wire.name, "shot.png");
        assert_eq!(wire.mime, "image/png");
        assert_eq!(
            wire.data,
            base64::engine::general_purpose::STANDARD.encode(PNG)
        );
        assert_eq!(attachment.size(), PNG.len());
    }

    #[test]
    fn a_prompt_that_cannot_fit_one_line_is_refused_before_sending() {
        let small = PendingAttachment {
            name: "a.png".into(),
            mime: "image/png".into(),
            bytes: vec![0; 1024],
        };
        assert!(fits_frame("hello", &[]));
        assert!(fits_frame("hello", std::slice::from_ref(&small)));
        let big = PendingAttachment {
            bytes: vec![0; 3 * 1024 * 1024],
            ..small
        };
        assert!(!fits_frame("", &[big]));
    }
}
