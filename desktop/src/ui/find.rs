//! Find in the pane's scrollback. The daemon owns the text, so a search is a
//! `pane.copy_search` round trip; this module keeps the query, maps the
//! answer onto visible cells, and scrolls the match into view. The bar floats
//! over the terminal and never changes its box, so the program's size is not
//! disturbed by opening it.

use std::time::{Duration, Instant};

use gpui::prelude::*;
use gpui::{
    div, px, AnyElement, Context, IntoElement, MouseButton, MouseDownEvent, SharedString, Styled,
    Window,
};

use crate::herdr::search::{
    SearchDirection, SearchOutcome, SearchRequest, SearchResult, TextPoint, TextRange,
};
use crate::model::{Frame, PaneId, PaneRect};
use crate::terminal::paint::{Highlight, HighlightKind};

use super::layout;
use super::theme::{mono_font, tone};
use super::window::PairfobWindow;

/// Typing settles before a request goes out; every keystroke would otherwise
/// put a round trip on the pane's history.
const FIND_DEBOUNCE: Duration = Duration::from_millis(150);
/// A pane that is still printing answers `stale_content`; retry against the
/// newer revision a couple of times, then let the user see the failure.
const STALE_RETRIES: u8 = 2;

#[derive(Debug)]
pub(crate) struct FindState {
    pub(crate) pane: PaneId,
    pub(crate) query: String,
    pub(crate) total: u64,
    pub(crate) current: Option<u64>,
    pub(crate) matches: Vec<TextRange>,
    pub(crate) current_match: Option<TextRange>,
    pub(crate) error: Option<String>,
    /// The query changed since the last request; the answer on screen belongs
    /// to text that is no longer there.
    dirty: bool,
    pending: Option<u64>,
    next_id: u64,
    last_edit: Option<Instant>,
    stale_retries: u8,
    /// Where the last answer's coordinates were read from.
    revision: u64,
}

impl FindState {
    fn new(pane: PaneId) -> Self {
        Self {
            pane,
            query: String::new(),
            total: 0,
            current: None,
            matches: Vec::new(),
            current_match: None,
            error: None,
            dirty: false,
            pending: None,
            next_id: 1,
            last_edit: None,
            stale_retries: 0,
            revision: 0,
        }
    }

    /// A bar with an answer already on it, for the screenshot harness.
    #[cfg(feature = "shot")]
    pub(crate) fn fixture(pane: PaneId) -> Self {
        let mut state = Self::new(pane);
        state.query = "needle".to_owned();
        state.total = 17;
        state.current = Some(3);
        state
    }

    /// A new query makes the old answer meaningless; the bar says it is
    /// looking until the daemon answers for the new one.
    fn retyped(&mut self) {
        self.dirty = true;
        self.total = 0;
        self.current = None;
        self.current_match = None;
        self.matches.clear();
        self.stale_retries = 0;
    }

    /// `3 of 17`, or what is wrong instead.
    pub(crate) fn label(&self) -> String {
        if let Some(error) = &self.error {
            return error.clone();
        }
        if self.query.is_empty() {
            return String::new();
        }
        if self.dirty || (self.pending.is_some() && self.total == 0) {
            return "searching…".to_owned();
        }
        if self.total == 0 {
            return "no matches".to_owned();
        }
        match self.current {
            Some(current) => format!("{current} of {}", self.total),
            None => format!("{} matches", self.total),
        }
    }
}

/// The pane-local cell a range covers, when any of it is on screen. Returns
/// start and end as frame coordinates.
pub(crate) fn visible_range(pane: &PaneRect, range: TextRange) -> Option<((u16, u16), (u16, u16))> {
    let scroll = pane.scroll?;
    let top = scroll
        .max_offset_from_bottom
        .saturating_sub(scroll.offset_from_bottom);
    let top = u32::try_from(top).unwrap_or(u32::MAX);
    let height = u32::from(scroll.viewport_rows).max(1);
    let (start, end) = ordered(range);
    let bottom = top.saturating_add(height);
    if end.row < top || start.row >= bottom {
        return None;
    }
    let first_row = start.row.saturating_sub(top);
    let last_row = end.row.saturating_sub(top).min(height - 1);
    let width = pane.rect.width.saturating_sub(1);
    let start_col = if start.row < top { 0 } else { start.col };
    let end_col = if end.row >= bottom {
        width
    } else {
        end.col.min(width)
    };
    Some((
        (
            pane.rect.x + start_col.min(width),
            pane.rect.y + u16::try_from(first_row).ok()?,
        ),
        (
            pane.rect.x + end_col,
            pane.rect.y + u16::try_from(last_row).ok()?,
        ),
    ))
}

/// How far from the bottom to scroll so the match sits in view. Visible rows
/// keep the current position; only an off-screen match moves the pane.
pub(crate) fn reveal_offset(pane: &PaneRect, range: TextRange) -> Option<u64> {
    let scroll = pane.scroll?;
    let top = scroll
        .max_offset_from_bottom
        .saturating_sub(scroll.offset_from_bottom);
    let top = u32::try_from(top).unwrap_or(u32::MAX);
    let height = u32::from(scroll.viewport_rows).max(1);
    let (start, end) = ordered(range);
    if start.row >= top && end.row < top.saturating_add(height) {
        return None;
    }
    let target_top = start.row.saturating_sub(height / 2);
    Some(
        scroll
            .max_offset_from_bottom
            .saturating_sub(u64::from(target_top))
            .min(scroll.max_offset_from_bottom),
    )
}

fn ordered(range: TextRange) -> (TextPoint, TextPoint) {
    if (range.start.row, range.start.col) <= (range.end.row, range.end.col) {
        (range.start, range.end)
    } else {
        (range.end, range.start)
    }
}

impl PairfobWindow {
    pub(crate) fn open_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.find.is_some() {
            self.focus_canvas(window, cx);
            return;
        }
        if !self.app.supports("pane.copy_search") {
            self.notify(
                crate::app::Notice::warning(
                    "This daemon cannot search scrollback; update it first.",
                ),
                cx,
            );
            return;
        }
        let Some(pane) = self.app.focused_pane() else {
            return;
        };
        self.find = Some(FindState::new(pane));
        self.focus_canvas(window, cx);
        cx.notify();
    }

    pub(crate) fn close_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.find.take().is_some() {
            self.marked.clear();
            self.marked_selection = None;
            self.focus_canvas(window, cx);
            cx.notify();
        }
    }

    pub(crate) fn find_push(&mut self, text: &str, cx: &mut Context<Self>) {
        let Some(find) = self.find.as_mut() else {
            return;
        };
        find.query.push_str(text);
        find.last_edit = Some(Instant::now());
        find.error = None;
        find.retyped();
        cx.notify();
    }

    pub(crate) fn find_backspace(&mut self, cx: &mut Context<Self>) {
        let Some(find) = self.find.as_mut() else {
            return;
        };
        if find.query.pop().is_some() {
            find.last_edit = Some(Instant::now());
            find.error = None;
            find.retyped();
        }
        cx.notify();
    }

    /// Enter sends the next match; Shift+Enter the previous one. With no
    /// match yet, the first step starts from the viewport's corner.
    pub(crate) fn find_step(&mut self, backward: bool, cx: &mut Context<Self>) {
        let Some(find) = self.find.as_mut() else {
            return;
        };
        if find.query.is_empty() || find.pending.is_some() {
            return;
        }
        find.last_edit = Some(
            Instant::now()
                .checked_sub(FIND_DEBOUNCE)
                .unwrap_or_else(Instant::now),
        );
        self.send_find(backward, cx);
        cx.notify();
    }

    /// Runs every tick: retires a bar whose pane left the screen and sends a
    /// settled query.
    pub(crate) fn poll_find(&mut self, now: Instant, cx: &mut Context<Self>) -> bool {
        let Some(find) = self.find.as_ref() else {
            return false;
        };
        #[cfg(feature = "shot")]
        if self.shot_find_pending {
            return false;
        }
        let focused = self.app.focused_pane();
        if focused.as_ref() != Some(&find.pane) || self.app.frame.is_none() {
            self.find = None;
            self.marked.clear();
            return true;
        }
        if find.pending.is_some() || find.query.is_empty() {
            return false;
        }
        if !find
            .last_edit
            .is_none_or(|edit| now.saturating_duration_since(edit) >= FIND_DEBOUNCE)
        {
            return false;
        }
        self.send_find(false, cx);
        true
    }

    /// The highlights the canvas paints for the current answer.
    pub(crate) fn find_highlights(&self, frame: &Frame) -> Vec<Highlight> {
        let Some(find) = self.find.as_ref() else {
            return Vec::new();
        };
        let Some(pane) = frame.panes.iter().find(|pane| pane.id == find.pane) else {
            return Vec::new();
        };
        let mut highlights = Vec::new();
        for range in &find.matches {
            let Some((start, end)) = visible_range(pane, *range) else {
                continue;
            };
            let kind = if find.current_match == Some(*range) {
                HighlightKind::FindCurrent
            } else {
                HighlightKind::FindMatch
            };
            highlights.push(Highlight {
                pane: find.pane.clone(),
                start,
                end,
                kind,
            });
        }
        highlights
    }

    pub(crate) fn apply_find_result(
        &mut self,
        request_id: u64,
        outcome: SearchOutcome,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(find) = self.find.as_mut() else {
            return false;
        };
        if find.pending != Some(request_id) {
            return false;
        }
        find.pending = None;
        match outcome {
            SearchOutcome::Found(result) => self.found(result, cx),
            SearchOutcome::Stale => {
                if find.stale_retries < STALE_RETRIES {
                    find.stale_retries += 1;
                    self.send_find(false, cx);
                } else {
                    find.error = Some("the pane kept changing; press Enter to try again".into());
                }
                true
            }
            SearchOutcome::Failed { code, message } => {
                find.error = Some(format!("{code}: {message}"));
                true
            }
        }
    }

    fn found(&mut self, result: SearchResult, cx: &mut Context<Self>) -> bool {
        let Some(find) = self.find.as_mut() else {
            return false;
        };
        // The reply is for the text that was there when the request went out.
        // If the query changed since, the debounce will ask again.
        if find.dirty {
            return true;
        }
        find.stale_retries = 0;
        find.total = result.total;
        find.current = result.current_global;
        find.current_match = result.current_match();
        find.matches = result.matches;
        find.revision = result.content_revision;
        find.error = None;
        let current = find.current_match;
        let pane_id = find.pane.clone();
        if let Some(range) = current {
            if let Some(frame) = self.app.frame.as_ref() {
                if let Some(pane) = frame.panes.iter().find(|pane| pane.id == pane_id) {
                    if let Some(offset) = reveal_offset(pane, range) {
                        let _ = self.handle.scroll_to(pane_id, offset);
                    }
                }
            }
        }
        cx.notify();
        true
    }

    fn send_find(&mut self, backward: bool, cx: &mut Context<Self>) {
        let Some(frame) = self.app.frame.clone() else {
            return;
        };
        let Some(find) = self.find.as_mut() else {
            return;
        };
        let Some(pane) = frame.panes.iter().find(|pane| pane.id == find.pane) else {
            return;
        };
        let Some(scroll) = pane.scroll else {
            find.error = Some("this pane has no scrollback".into());
            return;
        };
        let top = scroll
            .max_offset_from_bottom
            .saturating_sub(scroll.offset_from_bottom);
        let height = u64::from(scroll.viewport_rows).max(1);
        let previous = find.current_match;
        let (cursor, direction) = match (previous, backward) {
            (Some(range), _) => (
                range.start,
                if backward {
                    SearchDirection::Backward
                } else {
                    SearchDirection::Forward
                },
            ),
            (None, true) => (
                TextPoint {
                    row: u32::try_from(top + height - 1).unwrap_or(u32::MAX),
                    col: pane.rect.width.saturating_sub(1),
                },
                SearchDirection::Backward,
            ),
            (None, false) => (
                TextPoint {
                    row: u32::try_from(top).unwrap_or(u32::MAX),
                    col: 0,
                },
                SearchDirection::Forward,
            ),
        };
        let request = SearchRequest {
            pane_id: find.pane.as_str().to_owned(),
            query: find.query.clone(),
            direction,
            cursor,
            content_revision: pane.content_revision,
            previous,
        };
        if let Err(error) = request.validate() {
            find.error = Some(error);
            return;
        }
        find.dirty = false;
        let id = find.next_id;
        find.next_id = find.next_id.wrapping_add(1);
        match self.handle.search(id, request) {
            Ok(()) => find.pending = Some(id),
            Err(error) => find.error = Some(error.to_string()),
        }
        cx.notify();
    }

    pub(crate) fn find_bar(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let find = self.find.as_ref()?;
        let chrome = self.chrome.clone();
        let text = if find.query.is_empty() {
            "Find in scrollback".to_owned()
        } else {
            find.query.clone()
        };
        let color = if find.query.is_empty() {
            chrome.muted
        } else {
            chrome.foreground
        };
        let label = find.label();
        let tone_color = if find.error.is_some() {
            chrome.danger
        } else {
            chrome.muted
        };
        Some(
            div()
                .id("find-bar")
                .absolute()
                .top(px(8.))
                .right(px(12.))
                .w(px(340.))
                .flex()
                .items_center()
                .gap(px(6.))
                .h(px(layout::FILTER_HEIGHT + 6.))
                .px(px(8.))
                .rounded(px(layout::RADIUS_CONTROL))
                .bg(tone(chrome.raised))
                .border(px(1.))
                .border_color(tone(chrome.line))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|_this, _: &MouseDownEvent, _window, cx| cx.stop_propagation()),
                )
                .child(
                    div()
                        .text_size(px(11.))
                        .text_color(tone(chrome.muted))
                        .child("⌕"),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .font(mono_font())
                        .text_size(px(11.5))
                        .text_color(tone(color))
                        .child(SharedString::from(text)),
                )
                .children((!label.is_empty()).then(|| {
                    div()
                        .flex_none()
                        .text_size(px(10.5))
                        .text_color(tone(tone_color))
                        .child(SharedString::from(label))
                }))
                .child(
                    div()
                        .id("find-prev")
                        .px(px(3.))
                        .text_size(px(11.))
                        .text_color(tone(chrome.secondary))
                        .cursor_pointer()
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, _: &MouseDownEvent, window, cx| {
                                this.find_step(true, cx);
                                this.focus_canvas(window, cx);
                            }),
                        )
                        .child("↑"),
                )
                .child(
                    div()
                        .id("find-next")
                        .px(px(3.))
                        .text_size(px(11.))
                        .text_color(tone(chrome.secondary))
                        .cursor_pointer()
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, _: &MouseDownEvent, window, cx| {
                                this.find_step(false, cx);
                                this.focus_canvas(window, cx);
                            }),
                        )
                        .child("↓"),
                )
                .child(
                    div()
                        .id("find-close")
                        .px(px(3.))
                        .text_size(px(12.))
                        .text_color(tone(chrome.muted))
                        .cursor_pointer()
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, _: &MouseDownEvent, window, cx| {
                                this.close_find(window, cx)
                            }),
                        )
                        .child("×"),
                )
                .into_any_element(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Rect, Scroll};

    fn pane() -> PaneRect {
        PaneRect {
            id: "w1:p1".into(),
            rect: Rect {
                x: 2,
                y: 1,
                width: 20,
                height: 10,
            },
            focused: true,
            alternate_screen: false,
            mouse_reporting: false,
            scroll: Some(Scroll {
                offset_from_bottom: 0,
                max_offset_from_bottom: 100,
                viewport_rows: 10,
            }),
            content_revision: 1,
        }
    }

    fn point(row: u32, col: u16) -> TextPoint {
        TextPoint { row, col }
    }

    #[test]
    fn a_match_on_screen_needs_no_scroll() {
        let pane = pane();
        let range = TextRange {
            start: point(104, 4),
            end: point(104, 8),
        };
        assert_eq!(visible_range(&pane, range), Some(((6, 5), (10, 5))));
        assert_eq!(reveal_offset(&pane, range), None);
    }

    #[test]
    fn an_old_match_scrolls_into_the_middle() {
        let pane = pane();
        let range = TextRange {
            start: point(40, 0),
            end: point(40, 3),
        };
        assert_eq!(reveal_offset(&pane, range), Some(65));
        assert!(visible_range(&pane, range).is_none());
    }

    #[test]
    fn a_match_that_wraps_onto_other_rows_is_clipped() {
        let pane = pane();
        let range = TextRange {
            start: point(102, 2),
            end: point(104, 25),
        };
        let ((sx, sy), (ex, ey)) = visible_range(&pane, range).unwrap();
        assert_eq!((sx, sy), (4, 3), "the first row starts at its own column");
        assert_eq!(
            (ex, ey),
            (21, 5),
            "the wrap past the last column is clipped"
        );
    }

    #[test]
    fn the_label_reports_progress_then_errors() {
        let mut find = FindState::new("w1:p1".into());
        assert_eq!(find.label(), "");
        find.query = "needle".into();
        assert_eq!(find.label(), "no matches");
        find.total = 17;
        find.current = Some(3);
        assert_eq!(find.label(), "3 of 17");
        find.error = Some("boom".into());
        assert_eq!(find.label(), "boom");
        find.error = None;
        find.retyped();
        assert_eq!(find.label(), "searching…", "an old answer is not shown");
    }
}
