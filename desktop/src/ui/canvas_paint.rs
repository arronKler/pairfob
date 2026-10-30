//! Drawing one frame's ops onto the canvas. Backgrounds, decorations and
//! glyphs go inside one paint layer, so the scene assigns a single z-order to
//! the whole grid instead of walking the bounds tree for every glyph. The
//! cursor, the split preview and the scrollbars stay outside the layer: they
//! draw above text, and a layer would sort their quads under it.

use std::cell::RefCell;
use std::rc::Rc;

use gpui::{fill, point, px, size, Bounds, Hsla, Pixels, SharedString, TextRun, Window};
use smol_str::SmolStr;

use crate::model::{CursorShape, Frame, Modifier, PaneRect, SplitRect};
use crate::terminal::{CursorOp, DecorationKind, DrawOp, HighlightKind, Rgb, Theme};

use super::glyphs::{self, GlyphCache};
use super::layout;
use super::terminal::CellMetrics;
use super::theme::{tone, Chrome};

const SCROLLBAR_WIDTH: f32 = 3.;
/// Distance from the pane's right edge to the thumb.
const SCROLLBAR_INSET: f32 = 3.;
/// The track keeps this much clearance inside the pane's top and bottom.
const SCROLLBAR_MARGIN: f32 = 6.;
const SCROLLBAR_MIN_THUMB: f32 = 24.;

/// Paints the frame inside one layer and hands back the cursor op, which the
/// caller draws after the layer so it lands on top of the text it covers.
pub(crate) fn ops<'a>(
    ops: &'a [DrawOp],
    bounds: Bounds<Pixels>,
    cell: &CellMetrics,
    cache: &Rc<RefCell<GlyphCache>>,
    theme: &Theme,
    chrome: &Chrome,
    window: &mut Window,
) -> Vec<&'a CursorOp> {
    window.paint_quad(fill(bounds, tone(theme.background)));
    let origin = bounds.origin;
    let mut cursors = Vec::new();
    for op in ops {
        match op {
            DrawOp::Background(run) => {
                let rect = cell_rect(origin, cell, run.x, run.y, run.cells, 1);
                let color = match run.highlight {
                    Some(kind) => highlight_fill(kind, run.color, theme, chrome),
                    None => run.color,
                };
                window.paint_quad(fill(rect, tone(color)));
            }
            DrawOp::Decoration(op) => paint_decoration(origin, cell, op, window),
            DrawOp::Glyph(op) => paint_glyph(
                window,
                origin,
                cell,
                cache,
                op.x,
                op.y,
                &op.symbol,
                op.modifier,
                tone(op.color).into(),
            ),
            DrawOp::Cursor(op) => cursors.push(op),
        }
    }
    cursors
}

/// The selection wash keeps the terminal's own palette; find hits use the
/// chrome's search washes. All three sit over the program's background at the
/// same strength so text stays readable on either scheme.
fn highlight_fill(kind: HighlightKind, base: Rgb, theme: &Theme, chrome: &Chrome) -> Rgb {
    let wash = match kind {
        HighlightKind::Selection => theme.selection,
        HighlightKind::FindMatch => chrome.find_match,
        HighlightKind::FindCurrent => chrome.find_current,
    };
    wash.blend(base, 60)
}

fn paint_decoration(
    origin: gpui::Point<Pixels>,
    cell: &CellMetrics,
    op: &crate::terminal::DecorationOp,
    window: &mut Window,
) {
    let width = f32::from(op.cells) * cell.width;
    let top = f32::from(op.y) * cell.height;
    let (y, thickness) = match op.kind {
        DecorationKind::Underline(level) => {
            let thickness = 1. + f32::from(level.min(3)) * 0.5;
            (top + cell.height - thickness - 1., thickness)
        }
        DecorationKind::Strikethrough => (top + cell.height * 0.55, 1.),
    };
    let rect = Bounds::new(
        origin + point(px(f32::from(op.x) * cell.width), px(y)),
        size(px(width), px(thickness)),
    );
    window.paint_quad(fill(rect, tone(op.color)));
}

pub(crate) fn cursor(
    bounds: Bounds<Pixels>,
    cell: &CellMetrics,
    cache: &Rc<RefCell<GlyphCache>>,
    op: &CursorOp,
    window: &mut Window,
) {
    let origin = bounds.origin;
    let rect = cell_rect(origin, cell, op.x, op.y, 1, 1);
    match op.shape {
        CursorShape::Bar => {
            let bar = Bounds::new(rect.origin, size(px(2.), rect.size.height));
            window.paint_quad(fill(bar, tone(op.color)));
        }
        CursorShape::Underline => {
            let bar = Bounds::new(
                point(rect.origin.x, rect.origin.y + rect.size.height - px(2.)),
                size(rect.size.width, px(2.)),
            );
            window.paint_quad(fill(bar, tone(op.color)));
        }
        CursorShape::Block | CursorShape::Unknown => {
            window.paint_quad(fill(rect, tone(op.color)));
            if let Some((symbol, ink)) = &op.ink {
                paint_glyph(
                    window,
                    origin,
                    cell,
                    cache,
                    op.x,
                    op.y,
                    symbol,
                    Modifier::default(),
                    tone(*ink).into(),
                );
            }
        }
    }
}

/// The accent line that follows a split being dragged.
pub(crate) fn preview(
    bounds: Bounds<Pixels>,
    cell: &CellMetrics,
    split: &SplitRect,
    ratio: f32,
    theme: &Theme,
    window: &mut Window,
) {
    for (x, y, cells) in layout::split_preview(split, ratio) {
        let rect = cell_rect(bounds.origin, cell, x, y, cells, 1);
        window.paint_quad(fill(rect, tone(theme.accent)));
    }
}

/// A macOS-style overlay thumb for every pane scrolled away from the bottom.
pub(crate) fn scrollbars(
    frame: &Frame,
    bounds: Bounds<Pixels>,
    cell: &CellMetrics,
    color: Rgb,
    window: &mut Window,
) {
    for pane in &frame.panes {
        let Some(rect) = scrollbar_rect(pane, bounds, cell) else {
            continue;
        };
        window.paint_quad(fill(rect, tone(color)));
    }
}

fn scrollbar_rect(
    pane: &PaneRect,
    bounds: Bounds<Pixels>,
    cell: &CellMetrics,
) -> Option<Bounds<Pixels>> {
    let scroll = pane.scroll?;
    if scroll.offset_from_bottom == 0
        || scroll.max_offset_from_bottom == 0
        || scroll.viewport_rows == 0
    {
        return None;
    }
    let pane_top = f32::from(bounds.origin.y) + f32::from(pane.rect.y) * cell.height;
    let pane_right = f32::from(bounds.origin.x) + f32::from(pane.rect.right()) * cell.width;
    let track_height = f32::from(pane.rect.height) * cell.height - 2. * SCROLLBAR_MARGIN;
    if track_height <= 0. {
        return None;
    }
    let viewport = f32::from(scroll.viewport_rows);
    let max = scroll.max_offset_from_bottom as f32;
    let offset = (scroll.offset_from_bottom as f32).min(max);
    let thumb_height = (track_height * viewport / (max + viewport))
        .max(SCROLLBAR_MIN_THUMB)
        .min(track_height);
    let top = pane_top + SCROLLBAR_MARGIN + (track_height - thumb_height) * (1. - offset / max);
    Some(Bounds::new(
        point(px(pane_right - SCROLLBAR_INSET - SCROLLBAR_WIDTH), px(top)),
        size(px(SCROLLBAR_WIDTH), px(thumb_height)),
    ))
}

fn cell_rect(
    origin: gpui::Point<Pixels>,
    cell: &CellMetrics,
    x: u16,
    y: u16,
    cells: u16,
    rows: u16,
) -> Bounds<Pixels> {
    Bounds::new(
        origin
            + point(
                px(f32::from(x) * cell.width),
                px(f32::from(y) * cell.height),
            ),
        size(
            px(f32::from(cells) * cell.width),
            px(f32::from(rows) * cell.height),
        ),
    )
}

/// One shaped line per (style, symbol); all the glyphs in it are painted at
/// the cell origin so combining marks and emoji keep their shaping.
#[allow(clippy::too_many_arguments)]
fn paint_glyph(
    window: &mut Window,
    origin: gpui::Point<Pixels>,
    cell: &CellMetrics,
    cache: &Rc<RefCell<GlyphCache>>,
    x: u16,
    y: u16,
    symbol: &SmolStr,
    modifier: Modifier,
    color: Hsla,
) {
    if symbol.is_empty() {
        return;
    }
    let style = glyphs::style_of(modifier);
    let line = shaped(cache, window, cell, style, symbol);
    let top = origin
        + point(
            px(f32::from(x) * cell.width),
            px(f32::from(y) * cell.height),
        );
    let baseline = top
        + point(
            px(0.),
            (px(cell.height) - line.ascent - line.descent) / 2. + line.ascent,
        );
    for run in &line.runs {
        for glyph in &run.glyphs {
            let position = baseline + point(glyph.position.x, px(0.));
            if glyph.is_emoji {
                let _ = window.paint_emoji(position, run.font_id, glyph.id, line.font_size);
            } else {
                let _ = window.paint_glyph(position, run.font_id, glyph.id, line.font_size, color);
            }
        }
    }
}

fn shaped(
    cache: &Rc<RefCell<GlyphCache>>,
    window: &Window,
    cell: &CellMetrics,
    style: usize,
    symbol: &SmolStr,
) -> gpui::ShapedLine {
    let mut cache = cache.borrow_mut();
    if let Some(line) = cache.get(style, symbol) {
        return line;
    }
    let font = glyphs::styled_font(&cell.font, style);
    let line = window.text_system().shape_line(
        SharedString::from(symbol.as_str()),
        px(cell.font_size),
        &[TextRun {
            len: symbol.len(),
            font,
            color: Hsla::default(),
            background_color: None,
            underline: None,
            strikethrough: None,
        }],
        None,
    );
    cache.insert(style, symbol, line)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Rect, Scroll};
    use crate::ui::theme::mono_font;

    fn pane(scroll: Scroll) -> PaneRect {
        PaneRect {
            id: "p".into(),
            rect: Rect {
                x: 0,
                y: 0,
                width: 80,
                height: 10,
            },
            focused: true,
            alternate_screen: false,
            mouse_reporting: false,
            scroll: Some(scroll),
            content_revision: 0,
        }
    }

    fn cell() -> CellMetrics {
        CellMetrics {
            width: 10.,
            height: 20.,
            font_size: 13.,
            font: mono_font(),
        }
    }

    #[test]
    fn the_thumb_tracks_the_offset_and_vanishes_at_the_bottom() {
        let bounds = Bounds::new(point(px(0.), px(0.)), size(px(800.), px(200.)));
        let mid = Scroll {
            offset_from_bottom: 5,
            max_offset_from_bottom: 10,
            viewport_rows: 10,
        };
        assert_eq!(
            scrollbar_rect(&pane(mid), bounds, &cell()),
            Some(Bounds::new(point(px(794.), px(53.)), size(px(3.), px(94.))))
        );
        assert_eq!(
            scrollbar_rect(
                &pane(Scroll {
                    offset_from_bottom: 0,
                    ..mid
                }),
                bounds,
                &cell()
            ),
            None
        );
    }

    #[test]
    fn a_short_track_keeps_a_thumb_that_can_be_grabbed() {
        let bounds = Bounds::new(point(px(0.), px(0.)), size(px(800.), px(200.)));
        let long = Scroll {
            offset_from_bottom: 1_000,
            max_offset_from_bottom: 1_000,
            viewport_rows: 1,
        };
        let rect = scrollbar_rect(&pane(long), bounds, &cell()).expect("scrolled");
        assert_eq!(f32::from(rect.size.height), 24.);
        assert_eq!(f32::from(rect.origin.y), 6.);
    }
}
