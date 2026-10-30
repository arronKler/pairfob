//! Wire values in, model out. The fixtures are JSON so the test exercises the
//! same serde path the endpoint uses, including its defaults.

use pairfob_desktop::herdr::map;
use pairfob_desktop::herdr::wire::{ClientShellSnapshot, PaneSurfaceFrame};
use pairfob_desktop::model::{AgentStatus, CursorShape, PaneId, Rect, Size, SplitDirection};
use serde_json::{json, Value};

fn workspace(
    id: &str,
    number: usize,
    label: &str,
    branch: Option<&str>,
    focused: bool,
    status: &str,
) -> Value {
    json!({
        "workspace_id": id,
        "active_tab_id": format!("{id}:t1"),
        "new_workspace_cwd": "/work",
        "number": number,
        "label": label,
        "custom_label": false,
        "branch": branch,
        "git_ahead_behind": null,
        "tokens": [],
        "worktree": null,
        "focused": focused,
        "agent_status": status,
    })
}

fn tab(
    id: &str,
    workspace: &str,
    number: usize,
    label: &str,
    focused: bool,
    status: &str,
) -> Value {
    json!({
        "tab_id": id,
        "workspace_id": workspace,
        "number": number,
        "label": label,
        "custom_label": false,
        "zoomed": false,
        "focused": focused,
        "agent_status": status,
    })
}

fn pane(
    id: &str,
    workspace: &str,
    tab: &str,
    label: Option<&str>,
    cwd: Option<&str>,
    foreground_cwd: Option<&str>,
    focused: bool,
) -> Value {
    json!({
        "pane_id": id,
        "workspace_id": workspace,
        "tab_id": tab,
        "label": label,
        "cwd": cwd,
        "foreground_cwd": foreground_cwd,
        "focused": focused,
        "right_click_passthrough": false,
    })
}

fn agent(pane: &str, workspace: &str, tab: &str, name: Option<&str>, status: &str) -> Value {
    json!({
        "pane_id": pane,
        "workspace_id": workspace,
        "tab_id": tab,
        "name": null,
        "display_agent": null,
        "agent": name,
        "title": null,
        "terminal_title": null,
        "terminal_title_stripped": null,
        "agent_status": status,
        "state_change_seq": 1,
        "state_labels": [],
        "tokens": [],
        "focused": false,
    })
}

fn snapshot(value: Value) -> ClientShellSnapshot {
    serde_json::from_value(value).expect("snapshot fixture")
}

fn surface(value: Value) -> PaneSurfaceFrame {
    serde_json::from_value(value).expect("surface fixture")
}

fn fixture_snapshot() -> ClientShellSnapshot {
    snapshot(json!({
        "boot_id": "boot-1",
        "revision": 12,
        "config_diagnostic": null,
        "product_announcement": null,
        "update_available": null,
        "update_install_command": "",
        "server_keybindings_toml": null,
        "latest_release_notes_available": false,
        "integration_updates_available": false,
        "worktree_directory": "/work",
        "release_notes": null,
        "focused_workspace_id": "w1",
        "focused_tab_id": "w1:t1",
        "focused_pane_id": "p1",
        "tab_bar_right": [],
        "tab_bar_right_separator": " ",
        "agent_view_label": null,
        "agent_order": [],
        "workspaces": [
            workspace("w1", 1, "repo", Some("main"), true, "working"),
            workspace("w2", 2, "docs", None, false, "idle")
        ],
        "tabs": [
            tab("w1:t1", "w1", 1, "shell", true, "working"),
            tab("w1:t2", "w1", 2, "tests", false, "idle"),
            tab("w2:t1", "w2", 1, "docs", false, "idle")
        ],
        "panes": [
            pane("p1", "w1", "w1:t1", Some("build"), Some("/repo"), None, true),
            pane("p2", "w1", "w1:t1", None, Some("/repo"), Some("/repo/sub"), false),
            pane("p3", "w1", "w1:t2", None, None, None, false)
        ],
        "agents": [
            agent("p1", "w1", "w1:t1", Some("claude"), "working"),
            agent("p2", "w1", "w1:t1", Some("codex"), "blocked")
        ],
        "commands": []
    }))
}

#[test]
fn nests_tabs_and_panes_under_their_owners() {
    let session = map::session(&fixture_snapshot());
    assert_eq!(session.workspaces.len(), 2);
    assert_eq!(session.workspaces[0].label, "repo");
    assert_eq!(session.workspaces[1].label, "docs");

    let repo = &session.workspaces[0];
    assert_eq!(repo.id.as_str(), "w1");
    assert_eq!(repo.number, 1);
    assert_eq!(repo.branch.as_deref(), Some("main"));
    assert_eq!(repo.tabs.len(), 2);
    assert_eq!(repo.tabs[0].id.as_str(), "w1:t1");
    assert_eq!(repo.tabs[0].panes.len(), 2);
    assert_eq!(repo.tabs[1].id.as_str(), "w1:t2");
    assert_eq!(repo.tabs[1].panes.len(), 1);

    let docs = &session.workspaces[1];
    assert_eq!(docs.id.as_str(), "w2");
    assert_eq!(docs.tabs.len(), 1);
    assert!(docs.tabs[0].panes.is_empty());
    assert_eq!(session.pane_count(), 3);
}

#[test]
fn carries_focus_and_agent_status_from_the_wire() {
    let session = map::session(&fixture_snapshot());
    assert_eq!(session.focused_workspace, Some("w1".into()));
    assert_eq!(session.focused_tab, Some("w1:t1".into()));
    assert_eq!(session.focused_pane, Some("p1".into()));

    let (workspace, _, first) = session.find_pane(&"p1".into()).expect("p1");
    assert_eq!(workspace.id.as_str(), "w1");
    assert!(first.focused);
    assert_eq!(first.label.as_deref(), Some("build"));
    assert_eq!(first.status, AgentStatus::Working);
    assert_eq!(first.agent.as_deref(), Some("claude"));

    let second = session.pane(&"p2".into()).expect("p2");
    assert_eq!(second.status, AgentStatus::Blocked);
    assert_eq!(second.agent.as_deref(), Some("codex"));

    let third = session.pane(&"p3".into()).expect("p3");
    assert_eq!(third.status, AgentStatus::Unknown);
    assert!(third.agent.is_none());

    assert_eq!(session.workspaces[0].status, AgentStatus::Working);
    assert_eq!(session.workspaces[0].tabs[0].status, AgentStatus::Working);
}

#[test]
fn cwd_prefers_the_foreground_process_and_falls_back() {
    let session = map::session(&fixture_snapshot());
    assert_eq!(
        session.pane(&"p1".into()).unwrap().cwd.as_deref(),
        Some("/repo")
    );
    assert_eq!(
        session.pane(&"p2".into()).unwrap().cwd.as_deref(),
        Some("/repo/sub")
    );
    assert!(session.pane(&"p3".into()).unwrap().cwd.is_none());
}

fn fixture_surface() -> PaneSurfaceFrame {
    let cells: Vec<Value> = (0..120)
        .map(|_| {
            json!({
                "symbol": "x",
                "fg": 0,
                "bg": 0,
                "modifier": 0,
                "skip": false,
                "hyperlink": null,
            })
        })
        .collect();
    surface(json!({
        "boot_id": "boot-1",
        "projection_revision": 7,
        "surface_revision": 9,
        "frame": {
            "cells": cells,
            "width": 20,
            "height": 6,
            "cursor": {"x": 3, "y": 2, "visible": true, "shape": 3},
            "hyperlinks": ["https://example.test"],
            "graphics": []
        },
        "panes": [
            {
                "pane_id": "p1",
                "content_revision": 1,
                "rect": {"x": 0, "y": 0, "width": 10, "height": 6},
                "inner_rect": {"x": 0, "y": 0, "width": 10, "height": 6},
                "scrollbar_rect": null,
                "scroll": {
                    "offset_from_bottom": 3,
                    "max_offset_from_bottom": 30,
                    "viewport_rows": 6
                },
                "focused": true,
                "mouse_reporting": true,
                "sgr_pixel_mouse": false,
                "alternate_screen_active": false,
                "pixel_width": 0,
                "pixel_height": 0
            },
            {
                "pane_id": "p2",
                "content_revision": 2,
                "rect": {"x": 10, "y": 0, "width": 10, "height": 6},
                "inner_rect": {"x": 10, "y": 0, "width": 10, "height": 6},
                "scrollbar_rect": null,
                "scroll": null,
                "focused": false,
                "mouse_reporting": false,
                "sgr_pixel_mouse": false,
                "alternate_screen_active": true,
                "pixel_width": 0,
                "pixel_height": 0
            }
        ],
        "splits": [
            {
                "direction": "Vertical",
                "pos": 10,
                "area": {"x": 0, "y": 0, "width": 20, "height": 6},
                "hit_rect": {"x": 9, "y": 0, "width": 2, "height": 6},
                "path": [false]
            }
        ],
        "popup": null,
        "graphics": {"assets": [], "placements": [], "retained_assets": []}
    }))
}

#[test]
fn maps_a_surface_to_size_cells_panes_and_cursor() {
    let frame = map::frame(&fixture_surface());
    assert_eq!(frame.size, Size::new(20, 6));
    assert_eq!(frame.cells.len(), 120);
    assert_eq!(frame.cells[0].symbol.as_str(), "x");
    assert_eq!(frame.links, vec!["https://example.test".to_string()]);

    let cursor = frame.cursor.expect("cursor");
    assert_eq!((cursor.x, cursor.y), (3, 2));
    assert!(cursor.visible);
    assert_eq!(cursor.shape, CursorShape::Underline);

    assert_eq!(frame.panes.len(), 2);
    assert_eq!(frame.panes[0].id, PaneId::from("p1"));
    assert_eq!(
        frame.panes[0].rect,
        Rect {
            x: 0,
            y: 0,
            width: 10,
            height: 6
        }
    );
    assert!(frame.panes[0].focused);
    assert!(frame.panes[0].mouse_reporting);
    let scroll = frame.panes[0].scroll.expect("scroll");
    assert_eq!(scroll.offset_from_bottom, 3);
    assert_eq!(scroll.max_offset_from_bottom, 30);
    assert_eq!(scroll.viewport_rows, 6);

    assert_eq!(
        frame.panes[1].rect,
        Rect {
            x: 10,
            y: 0,
            width: 10,
            height: 6
        }
    );
    assert!(!frame.panes[1].focused);
    assert!(frame.panes[1].alternate_screen);

    assert_eq!(frame.splits.len(), 1);
    assert_eq!(frame.splits[0].direction, SplitDirection::Vertical);
    assert_eq!(frame.splits[0].pos, 10);
    assert_eq!(
        frame.splits[0].area,
        Rect {
            x: 0,
            y: 0,
            width: 20,
            height: 6
        }
    );
    assert_eq!(frame.focused_pane(), Some(&PaneId::from("p1")));
}

#[test]
fn cursor_shapes_follow_the_painters_rule() {
    assert_eq!(map::cursor_shape(0), CursorShape::Block);
    assert_eq!(map::cursor_shape(1), CursorShape::Block);
    assert_eq!(map::cursor_shape(2), CursorShape::Block);
    assert_eq!(map::cursor_shape(3), CursorShape::Underline);
    assert_eq!(map::cursor_shape(4), CursorShape::Underline);
    assert_eq!(map::cursor_shape(5), CursorShape::Bar);
    assert_eq!(map::cursor_shape(6), CursorShape::Bar);
    assert_eq!(map::cursor_shape(7), CursorShape::Block);
}
