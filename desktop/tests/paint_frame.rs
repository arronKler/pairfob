//! Pins the painter against one real captured Herdr surface frame.

use std::collections::BTreeMap;

use pairfob_desktop::model::{
    Cell, Cursor, CursorShape, Frame, Modifier, PaneId, PaneRect, Rect, Scroll, Size,
    SplitDirection, SplitRect,
};
use pairfob_desktop::terminal::color::from_wire;
use pairfob_desktop::terminal::paint::{
    paint, BgRun, DecorationKind, DecorationOp, DrawOp, GlyphOp,
};
use pairfob_desktop::terminal::theme::{Rgb, Theme};
use serde_json::Value;
use smol_str::SmolStr;

fn number(value: &Value) -> u32 {
    value.as_u64().expect("a non-negative number") as u32
}

fn cursor_shape(value: u32) -> CursorShape {
    match value {
        3 | 4 => CursorShape::Underline,
        5 | 6 => CursorShape::Bar,
        _ => CursorShape::Block,
    }
}

fn rect(value: &Value) -> Rect {
    Rect {
        x: number(&value["x"]) as u16,
        y: number(&value["y"]) as u16,
        width: number(&value["w"]) as u16,
        height: number(&value["h"]) as u16,
    }
}

fn fixture() -> Frame {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/frame.json");
    let text = std::fs::read_to_string(path).expect("the captured frame");
    let root: Value = serde_json::from_str(&text).expect("frame JSON");

    let cells = root["cells"]
        .as_array()
        .expect("cells")
        .iter()
        .map(|value| {
            let parts = value.as_array().expect("one cell as an array");
            Cell {
                symbol: SmolStr::new(parts[0].as_str().expect("symbol")),
                fg: from_wire(number(&parts[1])),
                bg: from_wire(number(&parts[2])),
                modifier: Modifier(number(&parts[3]) as u16),
                skip: parts[4].as_bool().expect("skip"),
                link: parts[5].as_u64().map(|link| link as u32),
            }
        })
        .collect();

    let cursor = root
        .get("cursor")
        .filter(|value| !value.is_null())
        .map(|value| Cursor {
            x: number(&value["x"]) as u16,
            y: number(&value["y"]) as u16,
            visible: value["visible"].as_bool().expect("visible"),
            shape: cursor_shape(number(&value["shape"])),
        });

    let panes = root["panes"]
        .as_array()
        .expect("panes")
        .iter()
        .map(|pane| {
            let scroll = &pane["scroll"];
            PaneRect {
                id: PaneId::new(pane["id"].as_str().expect("pane id")),
                rect: rect(pane),
                focused: pane["focused"].as_bool().expect("focused"),
                alternate_screen: pane["alt"].as_bool().expect("alt"),
                mouse_reporting: pane["mouse"].as_bool().expect("mouse"),
                scroll: Some(Scroll {
                    offset_from_bottom: scroll["offset"].as_u64().expect("scroll offset"),
                    max_offset_from_bottom: scroll["max"].as_u64().expect("scroll max"),
                    viewport_rows: number(&scroll["viewport"]) as u16,
                }),
                content_revision: 0,
            }
        })
        .collect();

    let splits = root["splits"]
        .as_array()
        .expect("splits")
        .iter()
        .map(|split| SplitRect {
            direction: match split["dir"].as_str().expect("split direction") {
                "Horizontal" => SplitDirection::Horizontal,
                _ => SplitDirection::Vertical,
            },
            pos: number(&split["pos"]) as u16,
            area: rect(split),
            hit_rect: rect(split),
            path: Vec::new(),
        })
        .collect();

    let links = root["hyperlinks"]
        .as_array()
        .expect("hyperlinks")
        .iter()
        .map(|link| link.as_str().expect("link").to_string())
        .collect();

    Frame {
        size: Size::new(
            number(&root["width"]) as u16,
            number(&root["height"]) as u16,
        ),
        cells,
        cursor,
        panes,
        splits,
        links,
    }
}

fn glyphs(ops: &[DrawOp]) -> Vec<&GlyphOp> {
    ops.iter()
        .filter_map(|op| match op {
            DrawOp::Glyph(glyph) => Some(glyph),
            _ => None,
        })
        .collect()
}

fn glyph_at(ops: &[DrawOp], x: u16, y: u16) -> Option<&GlyphOp> {
    ops.iter().find_map(|op| match op {
        DrawOp::Glyph(glyph) if glyph.x == x && glyph.y == y => Some(glyph),
        _ => None,
    })
}

/// Text as the window would lay it out: glyphs at their columns, skipped
/// spaces filled in, and a wide glyph stepping over its continuation column.
fn row_text(ops: &[DrawOp], cols: u16, y: u16) -> String {
    let by_column: BTreeMap<u16, &GlyphOp> = glyphs(ops)
        .into_iter()
        .filter(|glyph| glyph.y == y)
        .map(|glyph| (glyph.x, glyph))
        .collect();
    let mut text = String::new();
    let mut x = 0;
    while x < cols {
        if let Some(glyph) = by_column.get(&x) {
            text.push_str(&glyph.symbol);
            x += glyph.cells;
        } else {
            text.push(' ');
            x += 1;
        }
    }
    text
}

/// Whether any op begins at this cell. A wide glyph's continuation column must
/// be claimed by the glyph itself, not by a second op.
fn op_starts_at(ops: &[DrawOp], x: u16, y: u16) -> bool {
    ops.iter().any(|op| match op {
        DrawOp::Background(run) => run.x == x && run.y == y,
        DrawOp::Decoration(decoration) => decoration.x == x && decoration.y == y,
        DrawOp::Glyph(glyph) => glyph.x == x && glyph.y == y,
        DrawOp::Cursor(cursor) => cursor.x == x && cursor.y == y,
    })
}

fn background_at(ops: &[DrawOp], x: u16, y: u16) -> Option<&BgRun> {
    ops.iter().find_map(|op| match op {
        DrawOp::Background(run) if run.x == x && run.y == y => Some(run),
        _ => None,
    })
}

fn decoration_at(ops: &[DrawOp], x: u16, y: u16) -> Vec<&DecorationOp> {
    ops.iter()
        .filter_map(|op| match op {
            DrawOp::Decoration(decoration) if decoration.x == x && decoration.y == y => {
                Some(decoration)
            }
            _ => None,
        })
        .collect()
}

fn rank(op: &DrawOp) -> u8 {
    match op {
        DrawOp::Background(_) => 0,
        DrawOp::Decoration(_) => 1,
        DrawOp::Glyph(_) => 2,
        DrawOp::Cursor(_) => 3,
    }
}

#[test]
fn maps_the_captured_frame_to_model_types() {
    let frame = fixture();
    assert_eq!(frame.size, Size::new(120, 40));
    assert_eq!(frame.cells.len(), 4800);
    assert_eq!(frame.panes.len(), 2);
    assert_eq!(frame.panes[0].id, "w2:p1".into());
    assert!(frame.panes[0].focused);
    assert_eq!(
        frame.panes[0].rect,
        Rect {
            x: 0,
            y: 0,
            width: 54,
            height: 40
        }
    );
    assert_eq!(frame.panes[1].id, "w2:p2".into());
    assert!(!frame.panes[1].focused);
    assert_eq!(
        frame.panes[1].rect,
        Rect {
            x: 54,
            y: 0,
            width: 66,
            height: 40
        }
    );
    assert_eq!(frame.splits.len(), 1);
    assert_eq!(frame.splits[0].direction, SplitDirection::Horizontal);
    assert_eq!(frame.splits[0].pos, 54);
    assert_eq!(
        frame.splits[0].area,
        Rect {
            x: 0,
            y: 0,
            width: 120,
            height: 40
        }
    );
    assert!(frame.links.is_empty());
    let cursor = frame.cursor.expect("cursor");
    assert_eq!((cursor.x, cursor.y), (1, 11));
    assert!(cursor.visible);
    assert_eq!(cursor.shape, CursorShape::Block);
}

#[test]
fn paints_the_captured_content_as_glyphs() {
    let frame = fixture();
    let ops = paint(&frame, &Theme::dark(), &[]);
    let text = |y| row_text(&ops, frame.size.cols, y);

    assert!(text(2).contains("PF FIXTURE v1"), "row 2: {:?}", text(2));
    assert!(text(7).contains("cjk: 你好，世界"), "row 7: {:?}", text(7));
    assert!(text(8).contains("emoji: 🚀 ✅ 👨‍👩‍👧‍👦"), "row 8: {:?}", text(8));
    assert!(
        text(5).contains("wide: ＡＢＣ vs ABC"),
        "row 5: {:?}",
        text(5)
    );
    assert!(text(3).contains("reverse video"), "row 3: {:?}", text(3));
    assert!(
        text(5).contains("palette-196 red palette-46 green"),
        "row 5: {:?}",
        text(5)
    );
    assert!(text(6).contains("truecolor-123456"), "row 6: {:?}", text(6));
}

#[test]
fn resolves_palette_truecolor_and_reverse_video_cells() {
    let theme = Theme::dark();
    let ops = paint(&fixture(), &theme, &[]);

    // 256-palette text: 196 is pure red, 46 pure green.
    assert_eq!(
        glyph_at(&ops, 1, 5).expect("palette-196").color,
        Rgb(0xff0000)
    );
    assert_eq!(glyph_at(&ops, 13, 5).expect("red").color, Rgb(0xff0000));
    assert_eq!(
        glyph_at(&ops, 17, 5).expect("palette-46").color,
        Rgb(0x00ff00)
    );

    // Direct color is passed through channel for channel.
    assert_eq!(
        glyph_at(&ops, 1, 6).expect("truecolor").color,
        Rgb::new(0x12, 0x34, 0x56)
    );

    // The daemon already swapped the reverse-video line's colors.
    let background = background_at(&ops, 55, 3).expect("reverse-video background");
    assert_eq!(background.color, Rgb::new(0xff, 0xff, 0xff));
    assert_eq!((background.x, background.cells), (55, 13));
    assert_eq!(
        glyph_at(&ops, 55, 3).expect("reverse-video glyph").color,
        Rgb::new(0, 0, 0)
    );
}

#[test]
fn wide_glyphs_claim_two_cells_and_their_continuation() {
    let ops = paint(&fixture(), &Theme::dark(), &[]);
    let glyphs = glyphs(&ops);
    for symbol in ["你", "好", "，", "世", "界", "Ａ", "Ｂ", "Ｃ"] {
        let hits: Vec<&GlyphOp> = glyphs
            .iter()
            .copied()
            .filter(|glyph| glyph.symbol == symbol)
            .collect();
        assert_eq!(hits.len(), 1, "one glyph for {symbol:?}");
        let glyph = hits[0];
        assert_eq!(glyph.cells, 2, "{symbol:?} is wide");
        assert!(
            !op_starts_at(&ops, glyph.x + 1, glyph.y),
            "{symbol:?} at ({}, {}) leaves its continuation column empty",
            glyph.x,
            glyph.y
        );
    }
}

#[test]
fn the_zwj_emoji_stays_one_two_cell_glyph() {
    let ops = paint(&fixture(), &Theme::dark(), &[]);
    let family: Vec<&GlyphOp> = glyphs(&ops)
        .into_iter()
        .filter(|glyph| glyph.symbol == "👨‍👩‍👧‍👦")
        .collect();
    assert_eq!(family.len(), 1);
    assert_eq!(family[0].cells, 2);
    assert!(!op_starts_at(&ops, family[0].x + 1, family[0].y));
}

#[test]
fn decorations_follow_the_measured_modifier_bits_and_merge() {
    let theme = Theme::dark();
    let ops = paint(&fixture(), &theme, &[]);

    // UNDERLINE carries bit 8 plus style level 1 (4104): nine cells, one run.
    let underline = decoration_at(&ops, 13, 4);
    assert_eq!(underline.len(), 1);
    assert_eq!(underline[0].cells, 9);
    assert_eq!(underline[0].kind, DecorationKind::Underline(1));
    assert_eq!(underline[0].color, theme.foreground);
    assert!(
        !op_starts_at(&ops, 22, 4),
        "the run stops at the word's end"
    );

    // STRIKETHROUGH is bit 256: six cells, one run.
    let strike = decoration_at(&ops, 23, 4);
    assert_eq!(strike.len(), 1);
    assert_eq!(strike[0].cells, 6);
    assert_eq!(strike[0].kind, DecorationKind::Strikethrough);
    assert_eq!(strike[0].color, theme.foreground);

    // The second pane combines bold, underline level 1 and strikethrough.
    let combined = decoration_at(&ops, 63, 4);
    let combined_underline = combined
        .iter()
        .filter(|decoration| matches!(decoration.kind, DecorationKind::Underline(_)))
        .collect::<Vec<_>>();
    assert_eq!(combined_underline.len(), 1);
    assert_eq!(combined_underline[0].cells, 17);
    assert_eq!(combined_underline[0].kind, DecorationKind::Underline(1));
    let combined_strike = combined
        .into_iter()
        .filter(|decoration| decoration.kind == DecorationKind::Strikethrough)
        .collect::<Vec<_>>();
    assert_eq!(combined_strike.len(), 1);
    assert_eq!(combined_strike[0].cells, 17);

    let row_underlines = ops
        .iter()
        .filter(|op| {
            matches!(
                op,
                DrawOp::Decoration(DecorationOp {
                    y: 4,
                    kind: DecorationKind::Underline(_),
                    ..
                })
            )
        })
        .count();
    let row_strikes = ops
        .iter()
        .filter(|op| {
            matches!(
                op,
                DrawOp::Decoration(DecorationOp {
                    y: 4,
                    kind: DecorationKind::Strikethrough,
                    ..
                })
            )
        })
        .count();
    assert_eq!(row_underlines, 2, "adjacent cells merged into one run each");
    assert_eq!(row_strikes, 2);
}

#[test]
fn the_cursor_is_last_and_at_the_captured_cell() {
    let theme = Theme::dark();
    let frame = fixture();
    let ops = paint(&frame, &theme, &[]);

    assert_eq!(
        ops.iter()
            .filter(|op| matches!(op, DrawOp::Cursor(_)))
            .count(),
        1
    );
    let DrawOp::Cursor(cursor) = ops.last().expect("ops") else {
        panic!("the cursor paints last, got {:?}", ops.last());
    };
    assert_eq!((cursor.x, cursor.y), (1, 11));
    assert_eq!(cursor.shape, CursorShape::Block);
    assert_eq!(cursor.color, theme.cursor);
    // The captured cursor sits on a blank cell, so a block has no glyph to
    // redraw; ink is only set over a real symbol.
    assert_eq!(frame.cell(1, 11).expect("cell").symbol.as_str(), " ");
    assert_eq!(cursor.ink, None);
}

#[test]
fn background_runs_are_bounded_disjoint_and_not_default() {
    let theme = Theme::dark();
    let frame = fixture();
    let ops = paint(&frame, &theme, &[]);

    let mut runs: BTreeMap<u16, Vec<&BgRun>> = BTreeMap::new();
    for op in &ops {
        if let DrawOp::Background(run) = op {
            assert!(run.cells > 0);
            assert!(
                u32::from(run.x) + u32::from(run.cells) <= u32::from(frame.size.cols),
                "run leaves the row: {run:?}"
            );
            assert_ne!(run.color, theme.background, "default background painted");
            for x in run.x..run.x + run.cells {
                let cell = frame.cell(x, run.y).expect("cell in run");
                assert!(
                    !cell.bg.is_default(),
                    "run covers a default cell at {x},{}",
                    run.y
                );
            }
            runs.entry(run.y).or_default().push(run);
        }
    }

    for (y, row) in &runs {
        for pair in row.windows(2) {
            assert!(
                pair[0].x + pair[0].cells <= pair[1].x,
                "overlapping runs on row {y}"
            );
        }
    }
    // The frame has exactly the white reverse-video span and the amber span.
    assert_eq!(runs.len(), 2);
    assert_eq!(
        runs.get(&3)
            .expect("row 3")
            .iter()
            .map(|run| run.color)
            .collect::<Vec<_>>(),
        vec![Rgb::new(0xff, 0xff, 0xff)]
    );
    assert_eq!(
        runs.get(&6)
            .expect("row 6")
            .iter()
            .map(|run| (run.x, run.cells, run.color))
            .collect::<Vec<_>>(),
        vec![(18, 10, Rgb::new(0xc8, 0x78, 0x28))]
    );
}

#[test]
fn ops_are_grouped_in_paint_order_and_deterministic() {
    let theme = Theme::dark();
    let frame = fixture();
    let ops = paint(&frame, &theme, &[]);

    for pair in ops.windows(2) {
        assert!(
            rank(&pair[0]) <= rank(&pair[1]),
            "ops out of order: {:?} then {:?}",
            pair[0],
            pair[1]
        );
    }
    assert_eq!(ops, paint(&frame, &theme, &[]));
}
