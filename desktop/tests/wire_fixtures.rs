//! The independent endpoint decoder against bytes Herdr itself produced.
//! `testdata/endpoint` was captured from the `pffixture` session; regenerate
//! with `cargo test --test capture_endpoint -- --ignored` before removing the
//! old client dependency.

use std::fs;
use std::io::Cursor;
use std::path::PathBuf;

use pairfob_desktop::herdr::wire::{
    self, ClientMessage, EndpointServerWelcome, PaneSurfaceFrame, ServerMessage,
};

fn fixture(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("testdata/endpoint")
        .join(name);
    fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

#[test]
fn decodes_a_live_snapshot() {
    let bytes = fixture("snapshot.bin");
    let snapshot: wire::ClientShellSnapshot =
        bincode::serde::decode_from_slice(&bytes, bincode::config::standard())
            .expect("snapshot decodes")
            .0;
    assert!(!snapshot.boot_id.is_empty());
    assert!(!snapshot.workspaces.is_empty());
    assert!(!snapshot.panes.is_empty());
    assert!(snapshot.revision > 0);
    let ids: Vec<&str> = snapshot
        .panes
        .iter()
        .map(|pane| pane.pane_id.as_str())
        .collect();
    assert!(ids.contains(&"w1:p1"), "fixture panes: {ids:?}");
    assert!(snapshot.tabs.iter().all(|tab| snapshot
        .workspaces
        .iter()
        .any(|ws| ws.workspace_id == tab.workspace_id)));
}

#[test]
fn decodes_a_live_surface() {
    let bytes = fixture("surface.bin");
    let surface: PaneSurfaceFrame =
        bincode::serde::decode_from_slice(&bytes, bincode::config::standard())
            .expect("surface decodes")
            .0;
    assert!(!surface.boot_id.is_empty());
    assert!(surface.surface_revision > 0);
    assert!(!surface.panes.is_empty());
    let expected = usize::from(surface.frame.width) * usize::from(surface.frame.height);
    assert_eq!(surface.frame.cells.len(), expected);
    assert!(surface
        .frame
        .cells
        .iter()
        .any(|cell| !cell.symbol.is_empty()));
    assert_eq!(surface.frame.cells.len(), expected);
}

#[test]
fn framing_round_trips_and_rejects_an_oversized_length() {
    let message = ServerMessage::EndpointControl {
        kind: "endpoint.welcome.v1".into(),
        data: "{\"generation\":1}".into(),
    };
    let mut bytes = Vec::new();
    wire::write_message(&mut bytes, &message).unwrap();
    let decoded: ServerMessage =
        wire::read_message(&mut Cursor::new(bytes), wire::MAX_FRAME).expect("round trip");
    assert_eq!(decoded, message);

    let mut oversized = (u32::MAX).to_le_bytes().to_vec();
    oversized.extend_from_slice(&[0; 8]);
    let error =
        wire::read_message::<_, ServerMessage>(&mut Cursor::new(oversized), wire::MAX_FRAME)
            .unwrap_err();
    assert!(matches!(error, wire::WireError::Oversized { .. }));
}

#[test]
fn the_hello_is_json_and_the_welcome_reads_its_optional_fields() {
    let hello = wire::EndpointClientHello {
        generation: wire::ENDPOINT_GENERATION,
        cell_width_px: 9,
        cell_height_px: 18,
        surface_size: wire::ClientSurfaceSize {
            cols: 100,
            rows: 30,
        },
        pixel_mouse: false,
        direct_graphics: false,
        endpoint_keybindings: false,
        mouse_capture: false,
        surface_active: true,
        surface_reuse: true,
        surface_delta: true,
        surface_scroll: true,
        snapshot_codecs: vec![wire::SNAPSHOT_CODEC.into()],
        surface_codecs: vec![wire::SURFACE_CODEC.into()],
        input_codecs: vec![wire::INPUT_CODEC.into()],
        blob_codecs: vec![wire::BLOB_CODEC.into()],
    };
    let json = serde_json::to_string(&hello).unwrap();
    assert!(json.contains("\"generation\":1"));
    assert!(json.contains("\"surface_active\":true"));

    let welcome: EndpointServerWelcome = serde_json::from_str(
        r#"{"generation":1,"server_version":"0.9.5","snapshot_codec":"shell.snapshot.v1","surface_codec":"shell.surface.v1","input_codec":"shell.input.semantic.v1","blob_codec":"shell.blob.v1","methods":["pane.split"],"capabilities":[]}"#,
    )
    .unwrap();
    assert_eq!(welcome.generation, 1);
    assert_eq!(welcome.methods, vec!["pane.split"]);
    assert!(welcome.error.is_none());
}

#[test]
fn client_input_events_encode_in_contract_order() {
    let event = wire::ClientMessage::ClientShellPaneInput {
        pane_id: "w1:p1".into(),
        events: vec![wire::ClientPaneInputEvent::Key {
            code: wire::ClientKeyCode::Char('x'),
            modifiers: 1,
            kind: wire::ClientKeyKind::Press,
            repeat_count: 1,
            shifted_codepoint: None,
            generated_text: None,
            tracks_release: false,
            physical_key_id: None,
            windows_record: None,
        }],
    };
    let mut bytes = Vec::new();
    wire::write_message(&mut bytes, &event).unwrap();
    let decoded: ClientMessage = wire::read_message(&mut Cursor::new(bytes), wire::MAX_FRAME)
        .expect("client message round trip");
    let wire::ClientMessage::ClientShellPaneInput { pane_id, events } = decoded else {
        panic!("wrong variant");
    };
    assert_eq!(pane_id, "w1:p1");
    assert!(matches!(
        &events[0],
        wire::ClientPaneInputEvent::Key {
            code: wire::ClientKeyCode::Char('x'),
            modifiers: 1,
            kind: wire::ClientKeyKind::Press,
            ..
        }
    ));
}
