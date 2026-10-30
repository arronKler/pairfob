//! Small hand-built frames pin the painter's rules one at a time.

use pairfob_desktop::model::{
    Cell, Color, Cursor, CursorShape, Frame, Modifier, PaneId, PaneRect, Rect, Size,
};
use pairfob_desktop::terminal::color::from_wire;
use std::rc::Rc;
use std::sync::Arc;

use pairfob_desktop::terminal::paint::{
    paint, BgRun, CursorOp, DecorationKind, DecorationOp, DrawOp, GlyphOp, Highlight,
    HighlightKind, OpsCache,
};
use pairfob_desktop::terminal::theme::{Rgb, Theme};
use pairfob_desktop::terminal::width;
use smol_str::SmolStr;

fn styled(symbol: &str, fg: Color, bg: Color, modifier: Modifier) -> Cell {
    Cell {
        symbol: SmolStr::new(symbol),
        fg,
        bg,
        modifier,
        skip: false,
        link: None,
    }
}

fn plain(symbol: &str) -> Cell {
    styled(symbol, Color::Default, Color::Default, Modifier::default())
}

fn one_row(cols: u16, cells: Vec<Cell>) -> Frame {
    Frame {
        size: Size::new(cols, 1),
        cells,
        ..Frame::default()
    }
}

fn theme() -> Theme {
    Theme::dark()
}

fn decorations(ops: &[DrawOp]) -> Vec<&DecorationOp> {
    ops.iter()
        .filter_map(|op| match op {
            DrawOp::Decoration(decoration) => Some(decoration),
            _ => None,
        })
        .collect()
}

fn backgrounds(ops: &[DrawOp]) -> Vec<&BgRun> {
    ops.iter()
        .filter_map(|op| match op {
            DrawOp::Background(run) => Some(run),
            _ => None,
        })
        .collect()
}

fn glyphs(ops: &[DrawOp]) -> Vec<&GlyphOp> {
    ops.iter()
        .filter_map(|op| match op {
            DrawOp::Glyph(glyph) => Some(glyph),
            _ => None,
        })
        .collect()
}

#[test]
fn wire_colors_decode_by_high_byte() {
    assert_eq!(from_wire(0x0000_0000), Color::Default);
    assert_eq!(from_wire(0x0000_0001), Color::Named(1));
    assert_eq!(from_wire(0x0000_0010), Color::Named(16));
    assert_eq!(from_wire(0x0000_0011), Color::Default);
    assert_eq!(from_wire(0x0100_0000), Color::Palette(0));
    assert_eq!(from_wire(0x0100_00FF), Color::Palette(255));
    assert_eq!(from_wire(0x0212_3456), Color::Rgb(0x12, 0x34, 0x56));
    assert_eq!(from_wire(0x0300_0000), Color::Default);
}

#[test]
fn symbol_widths_match_the_host_renderer() {
    assert_eq!(width::columns("a"), 1);
    assert_eq!(width::columns("你"), 2);
    assert_eq!(width::columns("🚀"), 2);
    assert_eq!(width::columns("Ａ"), 2);
    assert_eq!(width::columns("ﾊﾞ"), 2);
    assert_eq!(width::columns(""), 1);
    assert_eq!(width::columns("e\u{301}"), 1);
    assert_eq!(width::columns("\u{301}"), 1);
    assert_eq!(width::columns("👨‍👩‍👧‍👦"), 2);
}

#[test]
fn an_empty_frame_paints_nothing() {
    assert!(paint(&Frame::default(), &theme(), &[]).is_empty());
    let blank = Frame {
        size: Size::new(4, 2),
        cells: vec![Cell::default(); 8],
        ..Frame::default()
    };
    assert!(paint(&blank, &theme(), &[]).is_empty());
}

#[test]
fn a_wide_glyph_at_the_last_column_covers_one_cell() {
    let mut cells = vec![Cell::default(); 2];
    cells[1] = styled(
        "你",
        Color::Default,
        Color::Rgb(1, 2, 3),
        Modifier::default(),
    );
    let ops = paint(&one_row(2, cells), &theme(), &[]);

    assert_eq!(
        ops,
        vec![
            DrawOp::Background(BgRun {
                x: 1,
                y: 0,
                cells: 1,
                color: Rgb::new(1, 2, 3),
                highlight: None,
            }),
            DrawOp::Glyph(GlyphOp {
                x: 1,
                y: 0,
                cells: 1,
                symbol: SmolStr::new("你"),
                color: theme().foreground,
                modifier: Modifier::default(),
            }),
        ]
    );
}

#[test]
fn a_wide_glyph_owns_its_continuation_background() {
    let mut cells = vec![Cell::default(); 4];
    cells[1] = styled(
        "你",
        Color::Default,
        Color::Rgb(1, 2, 3),
        Modifier::default(),
    );
    // The daemon leaves a plain space here, and its own background is not the
    // one the host renderer shows.
    cells[2] = styled(
        " ",
        Color::Default,
        Color::Rgb(9, 9, 9),
        Modifier::default(),
    );
    cells[3] = plain("x");
    let ops = paint(&one_row(4, cells), &theme(), &[]);

    assert_eq!(
        backgrounds(&ops),
        vec![&BgRun {
            x: 1,
            y: 0,
            cells: 2,
            color: Rgb::new(1, 2, 3),
            highlight: None,
        }]
    );
    let glyphs = glyphs(&ops);
    assert_eq!(glyphs.len(), 2);
    assert_eq!(
        (glyphs[0].x, glyphs[0].cells, glyphs[0].symbol.as_str()),
        (1, 2, "你")
    );
    assert_eq!(
        (glyphs[1].x, glyphs[1].cells, glyphs[1].symbol.as_str()),
        (3, 1, "x")
    );
    assert!(!ops.iter().any(|op| matches!(
        op,
        DrawOp::Glyph(glyph) if glyph.x == 2 && glyph.y == 0
    )));
}

#[test]
fn backgrounds_merge_maximal_runs_and_skip_default_cells() {
    let red = Color::Rgb(1, 0, 0);
    let blue = Color::Rgb(0, 0, 1);
    let cells = vec![
        styled("a", Color::Default, red, Modifier::default()),
        styled("b", Color::Default, red, Modifier::default()),
        plain(" "),
        styled("c", Color::Default, red, Modifier::default()),
        styled("d", Color::Default, blue, Modifier::default()),
    ];
    let ops = paint(&one_row(5, cells), &theme(), &[]);

    assert_eq!(
        backgrounds(&ops),
        vec![
            &BgRun {
                x: 0,
                y: 0,
                cells: 2,
                color: Rgb::new(1, 0, 0),
                highlight: None,
            },
            &BgRun {
                x: 3,
                y: 0,
                cells: 1,
                color: Rgb::new(1, 0, 0),
                highlight: None,
            },
            &BgRun {
                x: 4,
                y: 0,
                cells: 1,
                color: Rgb::new(0, 0, 1),
                highlight: None,
            },
        ]
    );
}

#[test]
fn underline_merges_across_adjacent_cells() {
    let cells = vec![
        styled("a", Color::Default, Color::Default, Modifier(4104)),
        styled("b", Color::Default, Color::Default, Modifier(4104)),
        styled("c", Color::Default, Color::Default, Modifier(4104)),
    ];
    let ops = paint(&one_row(3, cells), &theme(), &[]);

    assert_eq!(
        decorations(&ops),
        vec![&DecorationOp {
            x: 0,
            y: 0,
            cells: 3,
            color: theme().foreground,
            kind: DecorationKind::Underline(1),
        }]
    );
}

#[test]
fn the_plain_underline_bit_is_solid_level_zero() {
    // Bit 8 alone is the plain SGR underline; a different style level breaks
    // the run because the window would draw a different line.
    let cells = vec![
        styled("a", Color::Default, Color::Default, Modifier::UNDERLINE),
        styled("b", Color::Default, Color::Default, Modifier(4104)),
        styled("c", Color::Default, Color::Default, Modifier(4104)),
    ];
    let ops = paint(&one_row(3, cells), &theme(), &[]);

    assert_eq!(
        decorations(&ops),
        vec![
            &DecorationOp {
                x: 0,
                y: 0,
                cells: 1,
                color: theme().foreground,
                kind: DecorationKind::Underline(0),
            },
            &DecorationOp {
                x: 1,
                y: 0,
                cells: 2,
                color: theme().foreground,
                kind: DecorationKind::Underline(1),
            },
        ]
    );
}

#[test]
fn skip_suppresses_the_glyph() {
    let mut skipped = plain("X");
    skipped.skip = true;
    let cells = vec![skipped, plain("Y")];
    let ops = paint(&one_row(2, cells), &theme(), &[]);

    assert_eq!(
        ops,
        vec![DrawOp::Glyph(GlyphOp {
            x: 1,
            y: 0,
            cells: 1,
            symbol: SmolStr::new("Y"),
            color: theme().foreground,
            modifier: Modifier::default(),
        })]
    );
}

#[test]
fn dim_halves_the_glyph_and_the_background_it_sits_on() {
    let cells = vec![styled(
        "x",
        Color::Rgb(0x12, 0x34, 0x56),
        Color::Rgb(0xFF, 0xFF, 0xFF),
        Modifier::DIM,
    )];
    let ops = paint(&one_row(1, cells), &theme(), &[]);

    assert_eq!(
        glyphs(&ops)[0].color,
        Rgb::new(0x88, 0x99, 0xAA),
        "((fg & 0xfefefe) >> 1) + ((bg & 0xfefefe) >> 1)"
    );
}

#[test]
fn a_block_cursor_over_a_space_has_no_ink() {
    let mut frame = one_row(3, vec![Cell::default(); 3]);
    frame.cursor = Some(Cursor {
        x: 1,
        y: 0,
        visible: true,
        shape: CursorShape::Block,
    });
    let ops = paint(&frame, &theme(), &[]);

    assert_eq!(
        ops,
        vec![DrawOp::Cursor(CursorOp {
            x: 1,
            y: 0,
            shape: CursorShape::Block,
            color: theme().cursor,
            ink: None,
        })]
    );
}

#[test]
fn a_block_cursor_over_a_glyph_redraws_it_in_the_background_color() {
    let mut frame = one_row(3, vec![Cell::default(), plain("A"), Cell::default()]);
    frame.cursor = Some(Cursor {
        x: 1,
        y: 0,
        visible: true,
        shape: CursorShape::Block,
    });
    let ops = paint(&frame, &theme(), &[]);

    let DrawOp::Cursor(cursor) = ops.last().expect("cursor last") else {
        panic!("cursor must paint last");
    };
    assert_eq!(cursor.ink, Some((SmolStr::new("A"), theme().background)));
}

#[test]
fn only_block_cursors_carry_ink_and_hidden_or_out_of_bounds_ones_do_not_paint() {
    let mut frame = one_row(3, vec![Cell::default(), plain("A"), Cell::default()]);
    frame.cursor = Some(Cursor {
        x: 1,
        y: 0,
        visible: true,
        shape: CursorShape::Bar,
    });
    let DrawOp::Cursor(cursor) = paint(&frame, &theme(), &[]).pop().expect("cursor") else {
        panic!("cursor must paint last");
    };
    assert_eq!(cursor.ink, None);

    frame.cursor = Some(Cursor {
        x: 1,
        y: 0,
        visible: false,
        shape: CursorShape::Block,
    });
    assert!(!paint(&frame, &theme(), &[])
        .iter()
        .any(|op| matches!(op, DrawOp::Cursor(_))));

    frame.cursor = Some(Cursor {
        x: 9,
        y: 0,
        visible: true,
        shape: CursorShape::Block,
    });
    assert!(!paint(&frame, &theme(), &[])
        .iter()
        .any(|op| matches!(op, DrawOp::Cursor(_))));
}

fn pane(id: &str, x: u16, width: u16) -> PaneRect {
    PaneRect {
        id: id.into(),
        rect: Rect {
            x,
            y: 0,
            width,
            height: 1,
        },
        focused: false,
        alternate_screen: false,
        mouse_reporting: false,
        scroll: None,
        content_revision: 0,
    }
}

#[test]
fn a_highlight_tints_exactly_the_selected_cells() {
    let mut frame = one_row(4, vec![plain("a"), plain("b"), plain("c"), plain("d")]);
    frame.panes = vec![pane("w:t:p1", 0, 4)];
    let theme = theme();
    let highlight = Highlight {
        pane: PaneId::from("w:t:p1"),
        start: (1, 0),
        end: (2, 0),
        kind: HighlightKind::Selection,
    };

    let ops = paint(&frame, &theme, std::slice::from_ref(&highlight));
    let runs = backgrounds(&ops);
    assert_eq!(runs.len(), 1, "only the selected cells get a fill");
    assert_eq!((runs[0].x, runs[0].y, runs[0].cells), (1, 0, 2));
    assert_eq!(
        runs[0].color, theme.background,
        "the cell keeps its own fill"
    );
    assert_eq!(
        runs[0].highlight,
        Some(HighlightKind::Selection),
        "the window picks the wash for the highlight"
    );

    let plain = paint(&frame, &theme, &[]);
    assert!(backgrounds(&plain).is_empty());
    assert_eq!(glyphs(&plain), glyphs(&ops), "the wash leaves text alone");
}

#[test]
fn a_highlight_never_bleeds_into_a_neighbouring_pane() {
    let mut frame = one_row(4, vec![plain("a"), plain("b"), plain("c"), plain("d")]);
    frame.panes = vec![pane("left", 0, 2), pane("right", 2, 2)];
    let highlight = Highlight {
        pane: PaneId::from("left"),
        start: (0, 0),
        end: (3, 0),
        kind: HighlightKind::Selection,
    };

    let ops = paint(&frame, &theme(), std::slice::from_ref(&highlight));
    let runs = backgrounds(&ops);
    assert_eq!(runs.len(), 1);
    assert_eq!((runs[0].x, runs[0].cells), (0, 2));
}

#[test]
fn an_unchanged_frame_reuses_its_ops_and_a_change_rebuilds_them() {
    let frame = Arc::new(one_row(2, vec![plain("a"), plain("b")]));
    let mut cache = OpsCache::default();

    let first = cache.get(&frame, &theme(), &[]);
    let again = cache.get(&frame, &theme(), &[]);
    assert!(Rc::ptr_eq(&first, &again));
    assert_eq!(again.len(), paint(&frame, &theme(), &[]).len());

    let other = cache.get(&Arc::new((*frame).clone()), &theme(), &[]);
    assert!(!Rc::ptr_eq(&again, &other), "a new frame repaints");

    let light = cache.get(&frame, &Theme::light(), &[]);
    assert!(!Rc::ptr_eq(&other, &light), "a scheme change repaints");

    let highlight = Highlight {
        pane: PaneId::from("p"),
        start: (0, 0),
        end: (1, 0),
        kind: HighlightKind::Selection,
    };
    let selected = cache.get(&frame, &Theme::light(), std::slice::from_ref(&highlight));
    assert!(!Rc::ptr_eq(&light, &selected), "a selection repaints");
}
