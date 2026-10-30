//! Wheel prediction. A wheel turn reaches the daemon and comes back as a new
//! frame about 18ms later, the cadence Herdr itself delivers frames on. Until
//! then the picture can move by itself: the pane is drawn a few rows ahead of
//! the frame, in the direction the wheel went, and the next frame lands exactly
//! on that position. Rows the client has never seen repeat the pane's edge row
//! for the one frame they are missing.

use std::time::{Duration, Instant};

use crate::model::{Frame, PaneId, Scroll};

/// How long a turn waits for the frame that shows it. A scroll the daemon
/// never applies must not hold the pane shifted, so the picture falls back to
/// the frame rather than guessing forever.
const PATIENCE: Duration = Duration::from_millis(500);

/// A wheel gesture the daemon has not answered yet, in rows from the bottom.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Slide {
    pub pane: PaneId,
    /// The offset when the gesture started, which is where the prediction ends
    /// if a frame arrives moving the other way.
    pub from: u64,
    pub target: u64,
    /// When the last turn joined the gesture.
    pub sent: Instant,
}

impl Slide {
    fn up(&self) -> bool {
        self.target >= self.from
    }
}

/// The slide after one more wheel turn, or `None` when the prediction is the
/// frame's own position. Turns accumulate while frames are in flight, and the
/// ends of the scrollback clamp before the daemon would clamp them.
pub(crate) fn advanced(
    current: Option<&Slide>,
    pane: &PaneId,
    scroll: Scroll,
    lines: i32,
    now: Instant,
) -> Option<Slide> {
    let max = scroll.max_offset_from_bottom.min(i64::MAX as u64) as i64;
    let offset = scroll.offset_from_bottom as i64;
    let base = current
        .filter(|slide| &slide.pane == pane)
        .map_or(offset, |slide| slide.target as i64);
    let from = current
        .filter(|slide| &slide.pane == pane)
        .map_or(offset, |slide| slide.from as i64);
    let target = (base + i64::from(lines)).clamp(0, max);
    (target != offset).then(|| Slide {
        pane: pane.clone(),
        from: from as u64,
        target: target as u64,
        sent: now,
    })
}

/// The rows to draw a pane ahead of the frame, or `None` when the frame has
/// caught up.
pub(crate) fn painted_lines<'a>(
    slide: Option<&'a Slide>,
    frame: &Frame,
) -> Option<(&'a PaneId, i64)> {
    let slide = slide?;
    let pane = frame.panes.iter().find(|pane| pane.id == slide.pane)?;
    let offset = pane.scroll?.offset_from_bottom as i64;
    let lines = slide.target as i64 - offset;
    if lines == 0 || !within(slide, offset as u64) {
        return None;
    }
    let height = i64::from(pane.rect.height);
    Some((&slide.pane, lines.clamp(-height, height)))
}

/// Whether the frame has reached the prediction, either on it or past it in
/// either direction. A frame outside the gesture's range means another writer
/// moved the scrollback, so the prediction is dropped rather than drawn wrong.
pub(crate) fn finished(slide: &Slide, frame: &Frame) -> bool {
    let Some(offset) = frame
        .panes
        .iter()
        .find(|pane| pane.id == slide.pane)
        .and_then(|pane| pane.scroll)
        .map(|scroll| scroll.offset_from_bottom)
    else {
        return true;
    };
    offset == slide.target || !within(slide, offset)
}

/// Whether the gesture has waited longer than any round trip should take.
pub(crate) fn stale(slide: &Slide, now: Instant) -> bool {
    now.saturating_duration_since(slide.sent) > PATIENCE
}

fn within(slide: &Slide, offset: u64) -> bool {
    if slide.up() {
        (slide.from..=slide.target).contains(&offset)
    } else {
        (slide.target..=slide.from).contains(&offset)
    }
}

/// `lines` rows of the pane moved down (positive) or up (negative) inside its
/// own rectangle. Rows shifting out of the pane are dropped, and the strip
/// they leave at the edge repeats the row already there.
pub(crate) fn slide_frame(frame: &Frame, pane: &PaneId, lines: i64) -> Frame {
    let mut out = frame.clone();
    if lines == 0 {
        return out;
    }
    let Some(rect) = frame
        .panes
        .iter()
        .find(|candidate| &candidate.id == pane)
        .map(|candidate| candidate.rect)
    else {
        return out;
    };
    if rect.width == 0 || rect.height == 0 {
        return out;
    }
    let cols = usize::from(frame.size.cols);
    let top = i64::from(rect.y);
    let bottom = i64::from(rect.bottom()) - 1;
    for y in rect.y..rect.bottom() {
        let source = (i64::from(y) - lines).clamp(top, bottom) as u16;
        for x in rect.x..rect.right() {
            let Some(cell) = frame.cell(x, source) else {
                continue;
            };
            let index = usize::from(y) * cols + usize::from(x);
            if let Some(slot) = out.cells.get_mut(index) {
                *slot = cell.clone();
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Cell, PaneRect, Rect, Size};
    use smol_str::SmolStr;

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

    fn row(frame: &Frame, y: u16) -> String {
        (0..frame.size.cols)
            .filter_map(|x| frame.cell(x, y).map(|cell| cell.symbol.to_string()))
            .collect()
    }

    fn scroll(offset: u64, max: u64) -> Scroll {
        Scroll {
            offset_from_bottom: offset,
            max_offset_from_bottom: max,
            viewport_rows: 3,
        }
    }

    /// Tall enough that the tests below the height clamp read the real
    /// prediction rather than the pane's four rows.
    fn at(offset: u64) -> Frame {
        let mut frame = frame(
            &["a", "a", "a", "a"],
            Rect {
                x: 0,
                y: 0,
                width: 1,
                height: 4,
            },
        );
        frame.panes[0].scroll = Some(scroll(offset, 10));
        frame
    }

    #[test]
    fn scrolling_up_moves_the_pane_down_and_repeats_the_top_row() {
        let mut frame = frame(
            &["a", "b", "c", "d"],
            Rect {
                x: 0,
                y: 0,
                width: 1,
                height: 4,
            },
        );
        frame.panes[0].scroll = Some(scroll(0, 10));
        let slid = slide_frame(&frame, &"p".into(), 2);
        assert_eq!(
            (0..4).map(|y| row(&slid, y)).collect::<Vec<_>>(),
            ["a", "a", "a", "b"]
        );
    }

    #[test]
    fn scrolling_down_moves_the_pane_up_and_repeats_the_bottom_row() {
        let frame = frame(
            &["a", "b", "c", "d"],
            Rect {
                x: 0,
                y: 0,
                width: 1,
                height: 4,
            },
        );
        let slid = slide_frame(&frame, &"p".into(), -1);
        assert_eq!(
            (0..4).map(|y| row(&slid, y)).collect::<Vec<_>>(),
            ["b", "c", "d", "d"]
        );
    }

    #[test]
    fn a_slide_stays_inside_its_pane_and_leaves_its_neighbour_alone() {
        let mut frame = frame(
            &["aX", "bY", "cZ"],
            Rect {
                x: 0,
                y: 0,
                width: 1,
                height: 2,
            },
        );
        frame.panes.push(PaneRect {
            id: "q".into(),
            rect: Rect {
                x: 1,
                y: 0,
                width: 1,
                height: 3,
            },
            focused: false,
            alternate_screen: false,
            mouse_reporting: false,
            scroll: None,
            content_revision: 0,
        });
        let slid = slide_frame(&frame, &"p".into(), 1);
        assert_eq!(row(&slid, 0), "aX");
        assert_eq!(row(&slid, 1), "aY", "the pane repeats its own top row");
        assert_eq!(row(&slid, 2), "cZ", "the neighbour never moves");
    }

    #[test]
    fn turns_accumulate_and_clamp_at_both_ends_of_the_scrollback() {
        let pane: PaneId = "p".into();
        let now = Instant::now();
        let first = advanced(None, &pane, scroll(2, 10), 3, now).unwrap();
        assert_eq!((first.from, first.target), (2, 5));
        let second = advanced(Some(&first), &pane, scroll(2, 10), 3, now).unwrap();
        assert_eq!(second.target, 8, "the earlier turn is still in flight");
        assert_eq!(second.from, 2, "the gesture keeps its starting point");
        assert_eq!(
            advanced(Some(&second), &pane, scroll(2, 10), 9, now)
                .unwrap()
                .target,
            10
        );
        assert_eq!(
            advanced(None, &pane, scroll(10, 10), 3, now),
            None,
            "at the top"
        );
        assert_eq!(
            advanced(None, &pane, scroll(0, 10), -3, now),
            None,
            "at the bottom"
        );
        assert_eq!(
            advanced(None, &pane, scroll(0, 0), 3, now),
            None,
            "no scrollback"
        );
    }

    #[test]
    fn a_frame_catches_up_exactly_or_ends_the_prediction() {
        let pane: PaneId = "p".into();
        let slide = advanced(None, &pane, scroll(5, 10), 3, Instant::now()).unwrap();
        assert_eq!(painted_lines(Some(&slide), &at(5)), Some((&pane, 3)));
        assert_eq!(painted_lines(Some(&slide), &at(7)), Some((&pane, 1)));
        assert_eq!(painted_lines(Some(&slide), &at(8)), None);
        assert!(!finished(&slide, &at(7)));
        assert!(finished(&slide, &at(8)));
        assert!(finished(&slide, &at(9)), "past the prediction");
        assert!(finished(&slide, &at(4)), "the other way, past the start");
        assert_eq!(painted_lines(Some(&slide), &at(4)), None, "never backwards");
    }

    #[test]
    fn a_long_prediction_cannot_exceed_the_panes_height() {
        let pane: PaneId = "p".into();
        let mut frame = frame(
            &["a", "b"],
            Rect {
                x: 0,
                y: 0,
                width: 1,
                height: 2,
            },
        );
        frame.panes[0].scroll = Some(scroll(0, 100));
        let slide = Slide {
            pane: "p".into(),
            from: 0,
            target: 50,
            sent: Instant::now(),
        };
        assert_eq!(painted_lines(Some(&slide), &frame), Some((&pane, 2)));
    }

    #[test]
    fn a_gesture_downwards_reaches_the_bottom_exactly() {
        let pane: PaneId = "p".into();
        let slide = advanced(None, &pane, scroll(6, 10), -4, Instant::now()).unwrap();
        assert_eq!((slide.from, slide.target), (6, 2));
        assert_eq!(painted_lines(Some(&slide), &at(5)), Some((&pane, -3)));
        assert!(finished(&slide, &at(2)));
        assert!(finished(&slide, &at(10)), "past the start, the other way");
        assert!(!finished(&slide, &at(4)));
    }

    #[test]
    fn a_scroll_the_daemon_never_answers_falls_back_to_the_frame() {
        let pane: PaneId = "p".into();
        let sent = Instant::now();
        let slide = advanced(None, &pane, scroll(5, 10), 3, sent).unwrap();
        assert!(!stale(&slide, sent + Duration::from_millis(400)));
        assert!(stale(&slide, sent + Duration::from_millis(600)));
        assert!(!finished(&slide, &at(5)), "the frame alone does not end it");
    }
}
