//! Herdr sends one full surface when a client attaches, then row-level
//! patches as the focused pane repaints. A client that only understands the
//! full frame would have to reconnect on every keystroke, so patches are
//! applied to the surface held in memory. Validation runs before any write,
//! and a patch that fails is rejected whole.

use std::fmt;

use super::wire::{CursorState, FrameData, PaneSurfaceFrame, PaneSurfacePatch};

/// Why a patch cannot continue the held surface. Each variant names one check
/// from the wire contract, so a reconnect reason tells the operator which
/// field went out of step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PatchError {
    BootMismatch,
    ProjectionMismatch,
    BaseRevisionMismatch,
    RevisionGap,
    PopupOpen,
    FrameCellCount,
    FrameHyperlinkIndex,
    FrameCursorBounds,
    RowBounds,
    RowHyperlinkIndex,
    PaneGeometry,
    CursorBounds,
}

impl fmt::Display for PatchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::BootMismatch => "it names another boot",
            Self::ProjectionMismatch => "it names another projection",
            Self::BaseRevisionMismatch => "its base is not the held revision",
            Self::RevisionGap => "its revision is not the next one",
            Self::PopupOpen => "a popup is open",
            Self::FrameCellCount => "the held frame has the wrong cell count",
            Self::FrameHyperlinkIndex => "the held frame names a missing hyperlink",
            Self::FrameCursorBounds => "the held cursor is outside the frame",
            Self::RowBounds => "a row is outside the frame",
            Self::RowHyperlinkIndex => "a row names a missing hyperlink",
            Self::PaneGeometry => "a pane does not match the held geometry",
            Self::CursorBounds => "the cursor is outside the frame",
        };
        formatter.write_str(message)
    }
}

/// Apply `patch` to `surface` only when it continues the held revision and
/// matches the held frame. Nothing is written on failure, so the surface never
/// moves to a revision some update skipped. A patch that carries no panes
/// keeps every held pane.
pub fn apply_patch(
    surface: &mut PaneSurfaceFrame,
    patch: PaneSurfacePatch,
) -> Result<(), PatchError> {
    validate(surface, &patch)?;
    commit(surface, patch);
    Ok(())
}

fn validate(surface: &PaneSurfaceFrame, patch: &PaneSurfacePatch) -> Result<(), PatchError> {
    if surface.boot_id != patch.boot_id {
        return Err(PatchError::BootMismatch);
    }
    if surface.projection_revision != patch.projection_revision {
        return Err(PatchError::ProjectionMismatch);
    }
    if surface.surface_revision != patch.base_surface_revision {
        return Err(PatchError::BaseRevisionMismatch);
    }
    if surface.surface_revision.checked_add(1) != Some(patch.surface_revision) {
        return Err(PatchError::RevisionGap);
    }
    if surface.popup.is_some() {
        return Err(PatchError::PopupOpen);
    }
    validate_frame(&surface.frame)?;
    for row in &patch.rows {
        if row.y >= surface.frame.height
            || usize::from(row.x) + row.cells.len() > usize::from(surface.frame.width)
        {
            return Err(PatchError::RowBounds);
        }
        if row
            .cells
            .iter()
            .any(|cell| hyperlink_out_of_bounds(&surface.frame, cell.hyperlink))
        {
            return Err(PatchError::RowHyperlinkIndex);
        }
    }
    for pane in &patch.panes {
        if !surface.panes.iter().any(|held| {
            held.pane_id == pane.pane_id
                && held.rect == pane.rect
                && held.inner_rect == pane.inner_rect
        }) {
            return Err(PatchError::PaneGeometry);
        }
    }
    if patch
        .cursor
        .as_ref()
        .is_some_and(|cursor| cursor_out_of_bounds(&surface.frame, cursor))
    {
        return Err(PatchError::CursorBounds);
    }
    Ok(())
}

fn validate_frame(frame: &FrameData) -> Result<(), PatchError> {
    if frame.cells.len() != usize::from(frame.width) * usize::from(frame.height) {
        return Err(PatchError::FrameCellCount);
    }
    if frame
        .cells
        .iter()
        .any(|cell| hyperlink_out_of_bounds(frame, cell.hyperlink))
    {
        return Err(PatchError::FrameHyperlinkIndex);
    }
    if frame
        .cursor
        .as_ref()
        .is_some_and(|cursor| cursor_out_of_bounds(frame, cursor))
    {
        return Err(PatchError::FrameCursorBounds);
    }
    Ok(())
}

fn hyperlink_out_of_bounds(frame: &FrameData, hyperlink: Option<u32>) -> bool {
    hyperlink.is_some_and(|index| index as usize >= frame.hyperlinks.len())
}

fn cursor_out_of_bounds(frame: &FrameData, cursor: &CursorState) -> bool {
    cursor.visible && (cursor.x >= frame.width || cursor.y >= frame.height)
}

fn commit(surface: &mut PaneSurfaceFrame, patch: PaneSurfacePatch) {
    let width = usize::from(surface.frame.width);
    for row in patch.rows {
        let start = usize::from(row.y) * width + usize::from(row.x);
        surface.frame.cells[start..start + row.cells.len()].clone_from_slice(&row.cells);
    }
    for pane in patch.panes {
        if let Some(existing) = surface
            .panes
            .iter_mut()
            .find(|held| held.pane_id == pane.pane_id)
        {
            *existing = pane;
        }
    }
    surface.frame.cursor = patch.cursor;
    surface.surface_revision = patch.surface_revision;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::herdr::wire::{
        CellData, CursorState, FrameData, PaneSurfacePane, PaneSurfacePatch, PaneSurfacePatchRow,
        PaneSurfaceScrollMetrics, PaneSurfaceSplit, PaneSurfaceSplitDirection,
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

    fn rect(width: u16, height: u16) -> SurfaceRect {
        SurfaceRect {
            x: 0,
            y: 0,
            width,
            height,
        }
    }

    fn pane(id: &str, revision: u64) -> PaneSurfacePane {
        PaneSurfacePane {
            pane_id: id.into(),
            content_revision: revision,
            rect: rect(3, 2),
            inner_rect: rect(3, 2),
            scrollbar_rect: None,
            scroll: None,
            focused: id == "w1:p1",
            mouse_reporting: false,
            sgr_pixel_mouse: false,
            alternate_screen_active: false,
            pixel_width: 27,
            pixel_height: 36,
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
            panes: vec![pane("w1:p1", revision), pane("w1:p2", revision)],
            splits: vec![PaneSurfaceSplit {
                direction: PaneSurfaceSplitDirection::Vertical,
                pos: 2,
                area: rect(3, 2),
                hit_rect: rect(3, 2),
                path: vec![true],
            }],
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
            projection_revision: base,
            base_surface_revision: base,
            surface_revision: revision,
            rows,
            panes: Vec::new(),
            cursor: None,
        }
    }

    fn row(y: u16, x: u16, symbols: &[&str]) -> PaneSurfacePatchRow {
        PaneSurfacePatchRow {
            x,
            y,
            cells: symbols.iter().map(|symbol| cell(symbol)).collect(),
        }
    }

    fn assert_rejected(held: &mut PaneSurfaceFrame, patch: PaneSurfacePatch) {
        let before = held.clone();
        assert!(
            apply_patch(held, patch).is_err(),
            "expected the patch to be rejected"
        );
        assert_eq!(
            *held, before,
            "a rejected patch must not change the surface"
        );
    }

    #[test]
    fn a_row_patch_keeps_panes_it_does_not_name() {
        let mut held = surface(1);
        let mut patch = patch(1, 2, vec![row(1, 1, &["x", "y"])]);
        patch.panes = vec![pane("w1:p1", 2)];
        patch.cursor = Some(CursorState {
            x: 2,
            y: 1,
            visible: true,
            shape: 0,
        });

        apply_patch(&mut held, patch).expect("the patch continues the held surface");

        let symbols: Vec<&str> = held
            .frame
            .cells
            .iter()
            .map(|cell| cell.symbol.as_str())
            .collect();
        assert_eq!(symbols, ["a", "a", "a", "a", "x", "y"]);
        assert_eq!(held.panes.len(), 2);
        assert_eq!(held.panes[0], pane("w1:p1", 2));
        assert_eq!(held.panes[1], pane("w1:p2", 1));
        assert_eq!(
            held.frame.cursor.map(|cursor| (cursor.x, cursor.y)),
            Some((2, 1))
        );
        assert_eq!(held.surface_revision, 2);
        assert_eq!(held.projection_revision, 1);
        assert_eq!(held.splits.len(), 1);
    }

    #[test]
    fn an_empty_pane_list_keeps_every_pane() {
        let mut held = surface(1);
        let panes = held.panes.clone();

        apply_patch(&mut held, patch(1, 2, vec![row(0, 0, &["x"])]))
            .expect("the patch continues the held surface");

        assert_eq!(held.panes, panes);
        assert_eq!(held.frame.cells[0].symbol, "x");
    }

    #[test]
    fn a_patch_updates_only_the_pane_it_names() {
        let mut held = surface(1);
        let untouched = held.panes[0].clone();
        let mut changed = pane("w1:p2", 2);
        changed.focused = true;
        changed.scroll = Some(PaneSurfaceScrollMetrics {
            offset_from_bottom: 3,
            max_offset_from_bottom: 9,
            viewport_rows: 2,
        });
        let mut patch = patch(1, 2, Vec::new());
        patch.panes = vec![changed.clone()];

        apply_patch(&mut held, patch).expect("the patch continues the held surface");

        assert_eq!(held.panes, vec![untouched, changed]);
    }

    #[test]
    fn a_patch_for_another_boot_is_rejected() {
        let mut held = surface(1);
        let mut patch = patch(1, 2, Vec::new());
        patch.boot_id = "another".into();
        assert_rejected(&mut held, patch);
    }

    #[test]
    fn a_patch_for_another_projection_is_rejected() {
        let mut held = surface(1);
        let mut patch = patch(1, 2, Vec::new());
        patch.projection_revision = 7;
        assert_rejected(&mut held, patch);
    }

    #[test]
    fn a_patch_whose_base_is_not_the_held_revision_is_rejected() {
        let mut held = surface(1);
        let mut patch = patch(1, 2, Vec::new());
        patch.base_surface_revision = 0;
        assert_rejected(&mut held, patch);
    }

    #[test]
    fn a_patch_that_skips_a_revision_is_rejected() {
        let mut held = surface(1);
        assert_rejected(&mut held, patch(1, 3, Vec::new()));
    }

    #[test]
    fn a_patch_while_a_popup_is_open_is_rejected() {
        let mut held = surface(1);
        held.popup = Some(Box::new(crate::herdr::wire::ClientShellPopupSurface {
            terminal_id: "popup".into(),
            title: "popup".into(),
            width: None,
            height: None,
            frame: FrameData {
                cells: vec![cell("p")],
                width: 1,
                height: 1,
                cursor: None,
                hyperlinks: Vec::new(),
                graphics: Vec::new(),
            },
            mouse_reporting: false,
            sgr_pixel_mouse: false,
            pixel_width: 9,
            pixel_height: 18,
        }));
        assert_rejected(&mut held, patch(1, 2, Vec::new()));
    }

    #[test]
    fn a_malformed_held_frame_is_rejected() {
        let mut held = surface(1);
        held.frame.cells.pop();
        assert_rejected(&mut held, patch(1, 2, Vec::new()));
    }

    #[test]
    fn a_pane_with_changed_geometry_is_rejected() {
        let mut held = surface(1);

        let mut moved = pane("w1:p1", 2);
        moved.rect.x = 1;
        let mut bad_rect = patch(1, 2, Vec::new());
        bad_rect.panes = vec![moved];
        assert_rejected(&mut held, bad_rect);

        let mut resized = pane("w1:p1", 2);
        resized.inner_rect.width = 2;
        let mut bad_inner = patch(1, 2, Vec::new());
        bad_inner.panes = vec![resized];
        assert_rejected(&mut held, bad_inner);

        let mut unknown = patch(1, 2, Vec::new());
        unknown.panes = vec![pane("w9:p9", 2)];
        assert_rejected(&mut held, unknown);
    }

    #[test]
    fn a_row_outside_the_frame_is_rejected_whole() {
        let mut held = surface(1);

        assert_rejected(
            &mut held,
            patch(1, 2, vec![row(0, 0, &["x"]), row(0, 2, &["y", "z"])]),
        );
        assert_rejected(&mut held, patch(1, 2, vec![row(2, 0, &["x"])]));
    }

    #[test]
    fn a_row_hyperlink_past_the_table_is_rejected() {
        let mut held = surface(1);
        let mut linked = cell("x");
        linked.hyperlink = Some(0);
        assert_rejected(
            &mut held,
            patch(
                1,
                2,
                vec![PaneSurfacePatchRow {
                    x: 0,
                    y: 0,
                    cells: vec![linked],
                }],
            ),
        );
    }

    #[test]
    fn an_out_of_bounds_cursor_is_rejected() {
        let mut held = surface(1);

        let mut past_right = patch(1, 2, vec![row(0, 0, &["x"])]);
        past_right.cursor = Some(CursorState {
            x: 3,
            y: 0,
            visible: true,
            shape: 0,
        });
        assert_rejected(&mut held, past_right);

        let mut past_bottom = patch(1, 2, Vec::new());
        past_bottom.cursor = Some(CursorState {
            x: 0,
            y: 2,
            visible: true,
            shape: 0,
        });
        assert_rejected(&mut held, past_bottom);
    }
}
