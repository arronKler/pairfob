//! Wire to model. Everything here is pure: no sockets, no threads, no GPUI.

use smol_str::SmolStr;

use crate::herdr::wire::{
    AgentStatus as WireStatus, ClientShellSnapshot, PaneSurfaceFrame, PaneSurfaceSplitDirection,
    SurfaceRect,
};
use crate::model::{
    AgentStatus, Cell, Cursor, CursorShape, Frame, Modifier, Pane, PaneId, PaneRect, Rect, Scroll,
    Session, Size, SplitDirection, SplitRect, Tab, TabId, Workspace, WorkspaceId,
};
use crate::terminal::color;

pub fn session(snapshot: &ClientShellSnapshot) -> Session {
    let workspaces = snapshot
        .workspaces
        .iter()
        .map(|workspace| Workspace {
            id: WorkspaceId::new(&workspace.workspace_id),
            number: workspace.number,
            label: workspace.label.clone(),
            branch: workspace.branch.clone(),
            focused: workspace.focused,
            status: status(workspace.agent_status),
            tabs: snapshot
                .tabs
                .iter()
                .filter(|tab| tab.workspace_id == workspace.workspace_id)
                .map(|tab| Tab {
                    id: TabId::new(&tab.tab_id),
                    number: tab.number,
                    label: tab.label.clone(),
                    focused: tab.focused,
                    zoomed: tab.zoomed,
                    status: status(tab.agent_status),
                    panes: snapshot
                        .panes
                        .iter()
                        .filter(|pane| pane.tab_id == tab.tab_id)
                        .map(|pane| {
                            let agent = snapshot
                                .agents
                                .iter()
                                .find(|agent| agent.pane_id == pane.pane_id);
                            Pane {
                                id: PaneId::new(&pane.pane_id),
                                label: pane.label.clone(),
                                cwd: pane.foreground_cwd.clone().or_else(|| pane.cwd.clone()),
                                focused: pane.focused,
                                status: agent.map_or(AgentStatus::Unknown, |agent| {
                                    status(agent.agent_status)
                                }),
                                agent: agent.and_then(|agent| agent.agent.clone()),
                                tokens: agent.map(|agent| agent.tokens.clone()).unwrap_or_default(),
                            }
                        })
                        .collect(),
                })
                .collect(),
        })
        .collect();
    Session {
        workspaces,
        focused_workspace: snapshot.focused_workspace_id.as_ref().map(WorkspaceId::new),
        focused_tab: snapshot.focused_tab_id.as_ref().map(TabId::new),
        focused_pane: snapshot.focused_pane_id.as_ref().map(PaneId::new),
    }
}

pub fn frame(surface: &PaneSurfaceFrame) -> Frame {
    let data = &surface.frame;
    Frame {
        size: Size::new(data.width, data.height),
        cells: data
            .cells
            .iter()
            .map(|cell| Cell {
                symbol: SmolStr::new(&cell.symbol),
                fg: color::from_wire(cell.fg),
                bg: color::from_wire(cell.bg),
                modifier: Modifier(cell.modifier),
                skip: cell.skip,
                link: cell.hyperlink,
            })
            .collect(),
        cursor: data.cursor.as_ref().map(|cursor| Cursor {
            x: cursor.x,
            y: cursor.y,
            visible: cursor.visible,
            shape: cursor_shape(cursor.shape),
        }),
        panes: surface
            .panes
            .iter()
            .map(|pane| PaneRect {
                id: PaneId::new(&pane.pane_id),
                rect: rect(pane.rect),
                focused: pane.focused,
                alternate_screen: pane.alternate_screen_active,
                mouse_reporting: pane.mouse_reporting,
                content_revision: pane.content_revision,
                scroll: pane.scroll.map(|scroll| Scroll {
                    offset_from_bottom: scroll.offset_from_bottom,
                    max_offset_from_bottom: scroll.max_offset_from_bottom,
                    viewport_rows: scroll.viewport_rows.min(u64::from(u16::MAX)) as u16,
                }),
            })
            .collect(),
        splits: surface
            .splits
            .iter()
            .map(|split| SplitRect {
                direction: match split.direction {
                    PaneSurfaceSplitDirection::Horizontal => SplitDirection::Horizontal,
                    PaneSurfaceSplitDirection::Vertical => SplitDirection::Vertical,
                },
                pos: split.pos,
                area: rect(split.area),
                hit_rect: rect(split.hit_rect),
                path: split.path.clone(),
            })
            .collect(),
        links: data.hyperlinks.clone(),
    }
}

pub fn cursor_shape(raw: u8) -> CursorShape {
    match raw {
        3 | 4 => CursorShape::Underline,
        5 | 6 => CursorShape::Bar,
        _ => CursorShape::Block,
    }
}

fn status(status: WireStatus) -> AgentStatus {
    match status {
        WireStatus::Idle => AgentStatus::Idle,
        WireStatus::Working => AgentStatus::Working,
        WireStatus::Blocked => AgentStatus::Blocked,
        WireStatus::Done => AgentStatus::Done,
        WireStatus::Unknown => AgentStatus::Unknown,
    }
}

fn rect(rect: SurfaceRect) -> Rect {
    Rect {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
    }
}
