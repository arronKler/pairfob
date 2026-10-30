//! A frame becomes a flat list of ops in paint order: backgrounds, then
//! decorations, then glyphs, then the cursor. The window maps cell coordinates
//! to pixels and draws them; it makes no terminal decisions of its own.

use std::rc::Rc;
use std::sync::Arc;

use smol_str::SmolStr;

use super::theme::{Rgb, Theme};
use super::width;
use crate::model::{Cell, CursorShape, Frame, Modifier, PaneId};

/// What a highlighted range is for; the window chooses the fill.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum HighlightKind {
    #[default]
    Selection,
    FindMatch,
    FindCurrent,
}

/// A highlighted range inside one pane, as the window tracks it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Highlight {
    pub pane: PaneId,
    pub start: (u16, u16),
    pub end: (u16, u16),
    pub kind: HighlightKind,
}

impl Highlight {
    fn contains(&self, x: u16, y: u16) -> bool {
        let (start, end) = if (self.start.1, self.start.0) <= (self.end.1, self.end.0) {
            (self.start, self.end)
        } else {
            (self.end, self.start)
        };
        let after_start = y > start.1 || (y == start.1 && x >= start.0);
        let before_end = y < end.1 || (y == end.1 && x <= end.0);
        after_start && before_end
    }

    /// A cell is highlighted only inside the pane the highlight belongs to, so a
    /// range never bleeds into a neighbour.
    fn covers(&self, frame: &Frame, x: u16, y: u16) -> bool {
        self.contains(x, y) && frame.pane_at(x, y).is_some_and(|pane| pane.id == self.pane)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BgRun {
    pub x: u16,
    pub y: u16,
    pub cells: u16,
    pub color: Rgb,
    /// The highlight drawn over `color`, if any. The window picks the fill.
    pub highlight: Option<HighlightKind>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GlyphOp {
    pub x: u16,
    pub y: u16,
    /// Columns the glyph covers. A wide grapheme covers the continuation cell,
    /// which is not painted separately even though the daemon reports it as a
    /// plain space.
    pub cells: u16,
    pub symbol: SmolStr,
    pub color: Rgb,
    pub modifier: Modifier,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecorationKind {
    Underline(u8),
    Strikethrough,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecorationOp {
    pub x: u16,
    pub y: u16,
    pub cells: u16,
    pub color: Rgb,
    pub kind: DecorationKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CursorOp {
    pub x: u16,
    pub y: u16,
    pub shape: CursorShape,
    pub color: Rgb,
    /// The glyph the cursor covers and the ink that stays readable on it.
    pub ink: Option<(SmolStr, Rgb)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DrawOp {
    Background(BgRun),
    Decoration(DecorationOp),
    Glyph(GlyphOp),
    Cursor(CursorOp),
}

/// Returns ops in paint order.
pub fn paint(frame: &Frame, theme: &Theme, highlights: &[Highlight]) -> Vec<DrawOp> {
    let rows = frame.size.rows;
    let mut backgrounds = Vec::new();
    let mut decorations = Vec::new();
    let mut glyphs = Vec::new();

    for y in 0..rows {
        backgrounds_in_row(frame, theme, highlights, y, &mut backgrounds);
    }
    for y in 0..rows {
        decorations_in_row(frame, theme, y, &mut decorations);
    }
    for y in 0..rows {
        glyphs_in_row(frame, theme, y, &mut glyphs);
    }

    let mut ops = Vec::with_capacity(backgrounds.len() + decorations.len() + glyphs.len() + 1);
    ops.extend(backgrounds.into_iter().map(DrawOp::Background));
    ops.extend(decorations.into_iter().map(DrawOp::Decoration));
    ops.extend(glyphs.into_iter().map(DrawOp::Glyph));
    if let Some(cursor) = cursor_op(frame, theme) {
        ops.push(DrawOp::Cursor(cursor));
    }
    ops
}

/// Columns the cell at `x` covers. A wide glyph owns its continuation column,
/// clamped at the last column of the row.
fn cover(cell: &Cell, x: u16, cols: u16) -> u16 {
    if width::columns(&cell.symbol) > 1 && x + 1 < cols {
        2
    } else {
        1
    }
}

fn resolved_colors(cell: &Cell, theme: &Theme) -> (Rgb, Rgb) {
    (theme.resolve(cell.fg, false), theme.resolve(cell.bg, true))
}

/// The host renderer dims by halving each component of the color and of the
/// background it sits on, rather than blending against a fixed black.
fn dim(color: Rgb, background: Rgb) -> Rgb {
    Rgb(((color.0 & 0xFE_FE_FE) >> 1) + ((background.0 & 0xFE_FE_FE) >> 1))
}

/// The color of a glyph, and of the decoration drawn under it.
fn ink(cell: &Cell, theme: &Theme) -> Rgb {
    let (foreground, background) = resolved_colors(cell, theme);
    if cell.modifier.contains(Modifier::DIM) {
        dim(foreground, background)
    } else {
        foreground
    }
}

fn backgrounds_in_row(
    frame: &Frame,
    theme: &Theme,
    highlights: &[Highlight],
    y: u16,
    out: &mut Vec<BgRun>,
) {
    let cols = frame.size.cols;
    let mut run: Option<BgRun> = None;
    let mut x = 0;
    while x < cols {
        let Some(cell) = frame.cell(x, y) else {
            flush_background(&mut run, out);
            x += 1;
            continue;
        };
        let cells = cover(cell, x, cols);
        match cell_background(frame, theme, highlights, cell, x, y) {
            Some((color, highlight)) => match &mut run {
                Some(run)
                    if run.color == color
                        && run.highlight == highlight
                        && run.x + run.cells == x =>
                {
                    run.cells += cells
                }
                _ => {
                    flush_background(&mut run, out);
                    run = Some(BgRun {
                        x,
                        y,
                        cells,
                        color,
                        highlight,
                    });
                }
            },
            None => flush_background(&mut run, out),
        }
        x += cells;
    }
    flush_background(&mut run, out);
}

/// The fill behind one cell: the program's own background, plus the highlight
/// the window should draw over it. A highlight boundary therefore splits a run
/// even between two default cells.
fn cell_background(
    frame: &Frame,
    theme: &Theme,
    highlights: &[Highlight],
    cell: &Cell,
    x: u16,
    y: u16,
) -> Option<(Rgb, Option<HighlightKind>)> {
    let resolved = theme.resolve(cell.bg, true);
    if let Some(kind) = highlight_at(frame, highlights, x, y) {
        return Some((resolved, Some(kind)));
    }
    (!cell.bg.is_default()).then_some((resolved, None))
}

/// A find hit outranks the selection, and the current hit outranks the other
/// matches, so overlapping ranges keep the result the user is looking at.
fn highlight_at(frame: &Frame, highlights: &[Highlight], x: u16, y: u16) -> Option<HighlightKind> {
    highlights
        .iter()
        .filter(|highlight| highlight.covers(frame, x, y))
        .map(|highlight| highlight.kind)
        .max_by_key(|kind| match kind {
            HighlightKind::Selection => 0,
            HighlightKind::FindMatch => 1,
            HighlightKind::FindCurrent => 2,
        })
}

fn flush_background(run: &mut Option<BgRun>, out: &mut Vec<BgRun>) {
    if let Some(run) = run.take() {
        out.push(run);
    }
}

fn decorations_in_row(frame: &Frame, theme: &Theme, y: u16, out: &mut Vec<DecorationOp>) {
    let cols = frame.size.cols;
    let mut underline: Option<DecorationOp> = None;
    let mut strikethrough: Option<DecorationOp> = None;
    let mut x = 0;
    while x < cols {
        let Some(cell) = frame.cell(x, y) else {
            flush_decoration(&mut underline, out);
            flush_decoration(&mut strikethrough, out);
            x += 1;
            continue;
        };
        let cells = cover(cell, x, cols);
        let color = ink(cell, theme);

        if cell.modifier.has_underline() {
            // Level zero is the plain SGR underline; levels 1..=5 come from
            // the style bits the daemon adds.
            let kind = DecorationKind::Underline(cell.modifier.underline_level());
            extend_decoration(&mut underline, x, y, cells, color, kind, out);
        } else {
            flush_decoration(&mut underline, out);
        }

        if cell.modifier.contains(Modifier::STRIKETHROUGH) {
            let kind = DecorationKind::Strikethrough;
            extend_decoration(&mut strikethrough, x, y, cells, color, kind, out);
        } else {
            flush_decoration(&mut strikethrough, out);
        }

        x += cells;
    }
    flush_decoration(&mut underline, out);
    flush_decoration(&mut strikethrough, out);
}

fn extend_decoration(
    run: &mut Option<DecorationOp>,
    x: u16,
    y: u16,
    cells: u16,
    color: Rgb,
    kind: DecorationKind,
    out: &mut Vec<DecorationOp>,
) {
    match run {
        Some(run) if run.color == color && run.kind == kind && run.x + run.cells == x => {
            run.cells += cells;
        }
        _ => {
            flush_decoration(run, out);
            *run = Some(DecorationOp {
                x,
                y,
                cells,
                color,
                kind,
            });
        }
    }
}

fn flush_decoration(run: &mut Option<DecorationOp>, out: &mut Vec<DecorationOp>) {
    if let Some(run) = run.take() {
        out.push(run);
    }
}

fn glyphs_in_row(frame: &Frame, theme: &Theme, y: u16, out: &mut Vec<GlyphOp>) {
    let cols = frame.size.cols;
    let mut x = 0;
    while x < cols {
        let Some(cell) = frame.cell(x, y) else {
            x += 1;
            continue;
        };
        // Advancing by the symbol width also steps over a wide glyph's
        // continuation column, so it never produces an op.
        let cells = cover(cell, x, cols);
        if !cell.skip && !cell.symbol.is_empty() && cell.symbol != " " {
            out.push(GlyphOp {
                x,
                y,
                cells,
                symbol: cell.symbol.clone(),
                color: ink(cell, theme),
                modifier: cell.modifier,
            });
        }
        x += cells;
    }
}

fn cursor_op(frame: &Frame, theme: &Theme) -> Option<CursorOp> {
    let cursor = frame.cursor?;
    if !cursor.visible || !frame.size.contains(cursor.x, cursor.y) {
        return None;
    }
    // A block covers the cell, so the window has to redraw the glyph in the
    // background color on top of it. Bars and underlines leave the glyph alone.
    let ink = (cursor.shape == CursorShape::Block)
        .then(|| frame.cell(cursor.x, cursor.y))
        .flatten()
        .filter(|cell| !cell.symbol.is_empty() && cell.symbol != " ")
        .map(|cell| (cell.symbol.clone(), theme.background));
    Some(CursorOp {
        x: cursor.x,
        y: cursor.y,
        shape: cursor.shape,
        color: theme.cursor,
        ink,
    })
}

/// Ops for the frame they were built from. Scrolling a list repaints the
/// terminal even though its surface did not change, and walking every cell to
/// rebuild the same list is the most expensive part of that frame; the cache
/// hands the previous list back until one of its inputs differs.
#[derive(Default)]
pub struct OpsCache {
    last: Option<CachedOps>,
}

struct CachedOps {
    frame: Arc<Frame>,
    theme: Theme,
    highlights: Vec<Highlight>,
    ops: Rc<Vec<DrawOp>>,
}

impl OpsCache {
    pub fn get(
        &mut self,
        frame: &Arc<Frame>,
        theme: &Theme,
        highlights: &[Highlight],
    ) -> Rc<Vec<DrawOp>> {
        if let Some(cached) = self.last.as_ref() {
            if Arc::ptr_eq(&cached.frame, frame)
                && &cached.theme == theme
                && cached.highlights.as_slice() == highlights
            {
                return Rc::clone(&cached.ops);
            }
        }
        let ops = Rc::new(paint(frame, theme, highlights));
        self.last = Some(CachedOps {
            frame: Arc::clone(frame),
            theme: theme.clone(),
            highlights: highlights.to_vec(),
            ops: Rc::clone(&ops),
        });
        ops
    }
}
