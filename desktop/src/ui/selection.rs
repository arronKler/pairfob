//! A text selection inside one pane. The anchor is where the drag started and
//! the head follows the pointer; everything else is derived from those two
//! cells and the pane's rectangle.

use crate::model::{Frame, PaneId};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Selection {
    pub pane: PaneId,
    pub anchor: (u16, u16),
    pub head: (u16, u16),
}

impl Selection {
    /// Start and end in reading order, whichever way the drag went.
    pub fn ordered(&self) -> ((u16, u16), (u16, u16)) {
        if (self.anchor.1, self.anchor.0) <= (self.head.1, self.head.0) {
            (self.anchor, self.head)
        } else {
            (self.head, self.anchor)
        }
    }

    pub fn is_empty(&self) -> bool {
        let (start, end) = self.ordered();
        start == end
    }

    /// Row-major containment, both ends included.
    pub fn contains(&self, x: u16, y: u16) -> bool {
        let (start, end) = self.ordered();
        let after_start = y > start.1 || (y == start.1 && x >= start.0);
        let before_end = y < end.1 || (y == end.1 && x <= end.0);
        after_start && before_end
    }

    /// The selected text, or `None` when there is nothing to copy. Rows keep
    /// no trailing spaces, blank rows at either end are dropped, and a wide
    /// glyph's continuation cell is not repeated.
    pub fn text(&self, frame: &Frame) -> Option<String> {
        if self.is_empty() {
            return None;
        }
        let rect = frame.panes.iter().find(|pane| pane.id == self.pane)?.rect;
        let mut rows = Vec::new();
        for y in rect.y..rect.bottom() {
            let mut row = String::new();
            for x in rect.x..rect.right() {
                if !self.contains(x, y) {
                    continue;
                }
                let Some(cell) = frame.cell(x, y) else {
                    continue;
                };
                if !cell.skip {
                    row.push_str(&cell.symbol);
                }
            }
            rows.push(row.trim_end().to_owned());
        }
        while rows.last().is_some_and(String::is_empty) {
            rows.pop();
        }
        let first_text = rows.iter().position(|row| !row.is_empty())?;
        Some(rows[first_text..].join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Cell, PaneRect, Rect, Size};
    use smol_str::SmolStr;

    fn pane_rect(width: u16, height: u16) -> Rect {
        Rect {
            x: 0,
            y: 0,
            width,
            height,
        }
    }

    fn frame(rows: &[&str], rect: Rect) -> Frame {
        let cols = rows
            .iter()
            .map(|row| row.chars().count())
            .max()
            .unwrap_or(0) as u16;
        let mut cells = Vec::new();
        for row in rows {
            let mut symbols: Vec<char> = row.chars().collect();
            symbols.resize(usize::from(cols), ' ');
            for symbol in symbols {
                cells.push(Cell {
                    symbol: SmolStr::new(symbol.to_string()),
                    ..Cell::default()
                });
            }
        }
        Frame {
            size: Size::new(cols, rows.len() as u16),
            cells,
            panes: vec![PaneRect {
                id: "p".into(),
                rect,
                focused: true,
                alternate_screen: false,
                mouse_reporting: false,
                scroll: None,
                content_revision: 0,
            }],
            ..Frame::default()
        }
    }

    fn selection(anchor: (u16, u16), head: (u16, u16)) -> Selection {
        Selection {
            pane: "p".into(),
            anchor,
            head,
        }
    }

    #[test]
    fn a_backwards_drag_orders_and_contains_the_same_cells() {
        let backwards = selection((3, 1), (1, 0));
        assert_eq!(backwards.ordered(), ((1, 0), (3, 1)));
        assert!(!backwards.is_empty());
        assert!(backwards.contains(1, 0));
        assert!(backwards.contains(3, 1));
        assert!(backwards.contains(2, 0));
        assert!(!backwards.contains(0, 0), "before the start row-major");
        assert!(!backwards.contains(2, 2), "after the end row-major");
        assert!(selection((2, 2), (2, 2)).is_empty());
    }

    #[test]
    fn text_joins_rows_and_trims_trailing_spaces() {
        let frame = frame(&["hello   ", "world", "   "], pane_rect(8, 3));
        let text = selection((0, 0), (7, 1)).text(&frame);
        assert_eq!(text.as_deref(), Some("hello\nworld"));
    }

    #[test]
    fn text_drops_blank_rows_at_both_ends() {
        let frame = frame(&["   ", "hi", "   "], pane_rect(3, 3));
        let text = selection((0, 0), (2, 2)).text(&frame);
        assert_eq!(text.as_deref(), Some("hi"));
        assert_eq!(selection((0, 0), (2, 0)).text(&frame), None);
    }

    #[test]
    fn text_skips_a_wide_glyphs_continuation_cell() {
        let mut frame = frame(&["ab"], pane_rect(2, 1));
        frame.cells[0] = Cell {
            symbol: SmolStr::new("界"),
            ..Cell::default()
        };
        frame.cells[1] = Cell {
            symbol: SmolStr::new(" "),
            skip: true,
            ..Cell::default()
        };
        let text = selection((0, 0), (1, 0)).text(&frame);
        assert_eq!(text.as_deref(), Some("界"));
    }

    #[test]
    fn text_is_clamped_to_the_selections_own_pane() {
        let mut frame = frame(&["abcdef"], pane_rect(2, 1));
        frame.panes[0].rect.x = 2;
        frame.panes[0].rect.width = 3;
        let text = selection((0, 0), (5, 0)).text(&frame);
        assert_eq!(text.as_deref(), Some("cde"));
    }

    #[test]
    fn text_is_none_without_a_pane_or_without_cells() {
        let frame = frame(&["abc"], pane_rect(3, 1));
        let mut missing = selection((0, 0), (2, 0));
        missing.pane = "gone".into();
        assert_eq!(missing.text(&frame), None);
        assert_eq!(selection((1, 0), (1, 0)).text(&frame), None);
    }
}
