//! The endpoint reader: reads frames off the socket, answers the handshake
//! messages the engine cares about, and turns every stream-ending condition
//! into one [`ClientEvent::Disconnected`] with a readable reason.

use std::collections::HashMap;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};

use crossbeam_channel::Sender;
use serde_json::Value;

use super::connect::{ClientEvent, RawResponse};
use super::wire::{self, ClientShellSnapshot, ServerMessage, WireError, SNAPSHOT_CODEC};

/// One endpoint response may not exceed this; a larger one would mean the
/// chunk stream is not the response we asked for.
const RESPONSE_LIMIT: usize = 8 * 1024 * 1024;

pub(super) fn read_loop(
    mut reader: UnixStream,
    events: Sender<ClientEvent>,
    responses: Sender<RawResponse>,
    boot_id: Arc<Mutex<String>>,
) {
    let mut pending: HashMap<String, Vec<u8>> = HashMap::new();
    loop {
        let message = match wire::read_message::<_, ServerMessage>(&mut reader, wire::MAX_FRAME) {
            Ok(message) => message,
            Err(WireError::Closed) => {
                let _ = events.send(ClientEvent::Disconnected("the Herdr socket closed".into()));
                return;
            }
            Err(error) => {
                let _ = events.send(ClientEvent::Disconnected(error.to_string()));
                return;
            }
        };
        match message {
            ServerMessage::ClientShellSnapshot(snapshot) => {
                if let Ok(mut boot) = boot_id.lock() {
                    boot.clone_from(&snapshot.boot_id);
                }
                if events.send(ClientEvent::Snapshot(snapshot)).is_err() {
                    return;
                }
            }
            ServerMessage::PaneSurface(surface) => {
                if let Ok(mut boot) = boot_id.lock() {
                    if boot.is_empty() {
                        boot.clone_from(&surface.boot_id);
                    }
                }
                if events
                    .send(ClientEvent::Surface(Box::new(surface)))
                    .is_err()
                {
                    return;
                }
            }
            ServerMessage::PaneSurfacePatch(patch) => {
                if events.send(ClientEvent::Patch(Box::new(patch))).is_err() {
                    return;
                }
            }
            ServerMessage::ClientShellEndpointResponseChunk {
                request_id,
                final_chunk,
                data,
                ..
            } => {
                let buffer = pending.entry(request_id.clone()).or_default();
                if buffer.len() + data.len() > RESPONSE_LIMIT {
                    let _ = events.send(ClientEvent::Disconnected(
                        "a response exceeded the size limit".into(),
                    ));
                    return;
                }
                buffer.extend_from_slice(&data);
                if final_chunk {
                    let bytes = pending.remove(&request_id).unwrap_or_default();
                    match serde_json::from_slice::<Value>(&bytes) {
                        Ok(response) => {
                            if responses
                                .send(RawResponse {
                                    request_id,
                                    response,
                                })
                                .is_err()
                            {
                                return;
                            }
                        }
                        Err(error) => {
                            let _ = events.send(ClientEvent::Disconnected(format!(
                                "invalid endpoint response: {error}"
                            )));
                            return;
                        }
                    }
                }
            }
            ServerMessage::ServerShutdown { reason } => {
                let reason = reason.unwrap_or_else(|| "the Herdr server shut down".into());
                let _ = events.send(ClientEvent::Disconnected(reason));
                return;
            }
            ServerMessage::ClientShellError { message } => {
                let _ = events.send(ClientEvent::Disconnected(message));
                return;
            }
            ServerMessage::EndpointControl { kind, data } if kind == SNAPSHOT_CODEC => {
                match serde_json::from_str::<ClientShellSnapshot>(&data) {
                    Ok(snapshot) => {
                        if let Ok(mut boot) = boot_id.lock() {
                            boot.clone_from(&snapshot.boot_id);
                        }
                        if events
                            .send(ClientEvent::Snapshot(Box::new(snapshot)))
                            .is_err()
                        {
                            return;
                        }
                    }
                    Err(error) => {
                        let _ = events.send(ClientEvent::Disconnected(format!(
                            "invalid endpoint snapshot: {error}"
                        )));
                        return;
                    }
                }
            }
            ServerMessage::EndpointControl { .. } => {}
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use crossbeam_channel::unbounded;

    use super::*;
    use crate::herdr::wire::{
        CellData, CursorState, FrameData, PaneSurfaceFrame, PaneSurfacePatch, PaneSurfacePatchRow,
        SurfaceGraphicsScene,
    };

    fn cell(symbol: &str) -> CellData {
        CellData {
            symbol: symbol.into(),
            fg: 1,
            bg: 2,
            modifier: 0,
            skip: false,
            hyperlink: None,
        }
    }

    fn surface(revision: u64) -> PaneSurfaceFrame {
        PaneSurfaceFrame {
            boot_id: "boot".into(),
            projection_revision: revision,
            surface_revision: revision,
            frame: FrameData {
                cells: vec![cell("a"); 3],
                width: 3,
                height: 1,
                cursor: None,
                hyperlinks: Vec::new(),
                graphics: Vec::new(),
            },
            panes: Vec::new(),
            splits: Vec::new(),
            popup: None,
            graphics: SurfaceGraphicsScene {
                assets: Vec::new(),
                placements: Vec::new(),
                retained_assets: Vec::new(),
            },
        }
    }

    fn patch(base: u64, revision: u64) -> PaneSurfacePatch {
        PaneSurfacePatch {
            boot_id: "boot".into(),
            projection_revision: revision,
            base_surface_revision: base,
            surface_revision: revision,
            rows: vec![PaneSurfacePatchRow {
                x: 1,
                y: 0,
                cells: vec![cell("x")],
            }],
            panes: Vec::new(),
            cursor: Some(CursorState {
                x: 2,
                y: 0,
                visible: true,
                shape: 0,
            }),
        }
    }

    #[test]
    fn a_patch_is_forwarded_and_the_stream_stays_open() {
        let (mut peer, reader) = UnixStream::pair().unwrap();
        let (events, received) = unbounded();
        let (responses, _response_rx) = unbounded();
        let boot = Arc::new(Mutex::new(String::new()));
        let handle = std::thread::spawn(move || read_loop(reader, events, responses, boot));

        wire::write_message(&mut peer, &ServerMessage::PaneSurface(surface(1))).unwrap();
        wire::write_message(&mut peer, &ServerMessage::PaneSurfacePatch(patch(1, 2))).unwrap();
        drop(peer);

        match received.recv_timeout(Duration::from_secs(5)).unwrap() {
            ClientEvent::Surface(full) => assert_eq!(full.surface_revision, 1),
            other => panic!("expected the full surface, got {other:?}"),
        }
        match received.recv_timeout(Duration::from_secs(5)).unwrap() {
            ClientEvent::Patch(patch) => {
                assert_eq!(patch.surface_revision, 2);
                assert_eq!(patch.rows[0].cells[0].symbol, "x");
            }
            other => panic!("expected a patch, got {other:?}"),
        }
        match received.recv_timeout(Duration::from_secs(5)).unwrap() {
            ClientEvent::Disconnected(reason) => {
                assert!(reason.contains("closed") || !reason.is_empty());
            }
            other => panic!("expected the close, got {other:?}"),
        }
        handle.join().unwrap();
    }
}
