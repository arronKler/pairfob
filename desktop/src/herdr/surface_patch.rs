//! Herdr sends one full surface when a client attaches, then row-level
//! patches as the focused pane repaints. A client that only understands the
//! full frame would have to reconnect on every keystroke, so patches are
//! applied to the surface held in memory.

use super::wire::{PaneSurfaceFrame, PaneSurfacePatch};

/// Whether `patch` continues exactly the surface the engine holds. A patch
/// for another boot, or one whose base revision is not the held revision,
/// means at least one update was missed; the engine reconnects to resync.
pub fn fits(surface: &PaneSurfaceFrame, patch: &PaneSurfacePatch) -> bool {
    surface.boot_id == patch.boot_id && surface.surface_revision == patch.base_surface_revision
}

/// Apply `patch` in place. Rows outside the frame and cells past its right
/// edge are dropped instead of growing the buffer, so a bad patch cannot
/// change the screen geometry.
pub fn apply(surface: &mut PaneSurfaceFrame, patch: PaneSurfacePatch) {
    let width = usize::from(surface.frame.width);
    let height = usize::from(surface.frame.height);
    for row in &patch.rows {
        let y = usize::from(row.y);
        if y >= height {
            continue;
        }
        let start = usize::from(row.x);
        for (offset, cell) in row.cells.iter().enumerate() {
            let column = start + offset;
            if column >= width {
                break;
            }
            let index = y * width + column;
            if let Some(slot) = surface.frame.cells.get_mut(index) {
                *slot = cell.clone();
            }
        }
    }
    surface.panes = patch.panes;
    surface.frame.cursor = patch.cursor;
    surface.projection_revision = patch.projection_revision;
    surface.surface_revision = patch.surface_revision;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::herdr::wire::{
        CellData, CursorState, FrameData, PaneSurfacePane, PaneSurfacePatchRow,
        SurfaceGraphicsScene, SurfaceRect,
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
                cells: vec![cell("a"); 6],
                width: 3,
                height: 2,
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

    fn patch(base: u64, revision: u64, rows: Vec<PaneSurfacePatchRow>) -> PaneSurfacePatch {
        PaneSurfacePatch {
            boot_id: "boot".into(),
            projection_revision: revision,
            base_surface_revision: base,
            surface_revision: revision,
            rows,
            panes: vec![PaneSurfacePane {
                pane_id: "w1:p1".into(),
                content_revision: revision,
                rect: SurfaceRect {
                    x: 0,
                    y: 0,
                    width: 3,
                    height: 2,
                },
                inner_rect: SurfaceRect {
                    x: 0,
                    y: 0,
                    width: 3,
                    height: 2,
                },
                scrollbar_rect: None,
                scroll: None,
                focused: true,
                mouse_reporting: false,
                sgr_pixel_mouse: false,
                alternate_screen_active: false,
                pixel_width: 27,
                pixel_height: 36,
            }],
            cursor: Some(CursorState {
                x: 2,
                y: 1,
                visible: true,
                shape: 0,
            }),
        }
    }

    #[test]
    fn a_patch_continues_the_held_revision() {
        let held = surface(1);
        assert!(fits(&held, &patch(1, 2, Vec::new())));
        assert!(!fits(&held, &patch(2, 3, Vec::new())));
        let mut other = surface(1);
        other.boot_id = "another".into();
        assert!(!fits(&other, &patch(1, 2, Vec::new())));
    }

    #[test]
    fn rows_replace_cells_at_their_offset_and_keep_the_rest() {
        let mut held = surface(1);
        apply(
            &mut held,
            patch(
                1,
                2,
                vec![PaneSurfacePatchRow {
                    x: 1,
                    y: 1,
                    cells: vec![cell("x"), cell("y")],
                }],
            ),
        );
        let symbols: Vec<&str> = held
            .frame
            .cells
            .iter()
            .map(|cell| cell.symbol.as_str())
            .collect();
        assert_eq!(symbols, ["a", "a", "a", "a", "x", "y"]);
        assert_eq!(held.surface_revision, 2);
        assert_eq!(held.projection_revision, 2);
        assert_eq!(held.panes.len(), 1);
        assert_eq!(
            held.frame.cursor.map(|cursor| (cursor.x, cursor.y)),
            Some((2, 1))
        );
    }

    #[test]
    fn cells_past_the_edge_are_dropped_without_resizing() {
        let mut held = surface(1);
        apply(
            &mut held,
            patch(
                1,
                2,
                vec![
                    PaneSurfacePatchRow {
                        x: 2,
                        y: 0,
                        cells: vec![cell("x"), cell("y")],
                    },
                    PaneSurfacePatchRow {
                        x: 0,
                        y: 5,
                        cells: vec![cell("z")],
                    },
                ],
            ),
        );
        assert_eq!(held.frame.width, 3);
        assert_eq!(held.frame.height, 2);
        assert_eq!(held.frame.cells.len(), 6);
        assert_eq!(held.frame.cells[2].symbol, "x");
        assert!(held.frame.cells.iter().all(|cell| cell.symbol != "y"));
    }
}
