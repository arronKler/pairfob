//! Herdr's stable endpoint contract, generation 1. The shapes and field order
//! are the contract; bincode encodes them positionally. Nothing in this module
//! knows about the window, the engine, or the Pairfob model.
//!
//! Split by duty: `messages` is the handshake and frame variants, `snapshot`
//! is the workspace tree, and `surface` is the rendered screen.

#![allow(dead_code)]

use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize};

mod messages;
mod snapshot;
mod surface;

pub use messages::*;
pub use snapshot::*;
pub use surface::*;

pub const ENDPOINT_GENERATION: u32 = 1;
pub const HELLO_KIND: &str = "endpoint.hello.v1";
pub const WELCOME_KIND: &str = "endpoint.welcome.v1";
pub const SNAPSHOT_CODEC: &str = "shell.snapshot.v1";
pub const SURFACE_CODEC: &str = "shell.surface.v1";
pub const INPUT_CODEC: &str = "shell.input.semantic.v1";
pub const BLOB_CODEC: &str = "shell.blob.v1";
pub const PROTOCOL_VERSION: u32 = 22;
pub const MAX_FRAME: usize = 2 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum WireError {
    #[error("io: {0}")]
    Io(#[from] io::Error),
    #[error("frame too large: {claimed} bytes, limit {limit}")]
    Oversized { claimed: usize, limit: usize },
    #[error("bincode: {0}")]
    Bincode(#[from] bincode::error::EncodeError),
    #[error("decode: {0}")]
    Decode(#[from] bincode::error::DecodeError),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("connection closed")]
    Closed,
}

pub fn write_message<W: Write, M: Serialize>(writer: &mut W, message: &M) -> Result<(), WireError> {
    let payload = bincode::serde::encode_to_vec(message, bincode::config::standard())?;
    if payload.len() > u32::MAX as usize {
        return Err(WireError::Oversized {
            claimed: payload.len(),
            limit: u32::MAX as usize,
        });
    }
    writer.write_all(&(payload.len() as u32).to_le_bytes())?;
    writer.write_all(&payload)?;
    writer.flush()?;
    Ok(())
}

pub fn read_message<R: Read, M: for<'de> Deserialize<'de>>(
    reader: &mut R,
    limit: usize,
) -> Result<M, WireError> {
    let mut prefix = [0u8; 4];
    let mut read = 0;
    while read < prefix.len() {
        match reader.read(&mut prefix[read..])? {
            0 if read == 0 => return Err(WireError::Closed),
            0 => {
                return Err(WireError::Io(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "short frame prefix",
                )))
            }
            count => read += count,
        }
    }
    let claimed = u32::from_le_bytes(prefix) as usize;
    if claimed > limit {
        return Err(WireError::Oversized { claimed, limit });
    }
    let mut payload = vec![0u8; claimed];
    reader.read_exact(&mut payload)?;
    let (message, consumed) =
        bincode::serde::decode_from_slice(&payload, bincode::config::standard())?;
    if consumed != payload.len() {
        return Err(WireError::Io(io::Error::new(
            io::ErrorKind::InvalidData,
            "trailing bytes after frame",
        )));
    }
    Ok(message)
}
