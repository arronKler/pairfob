//! The terminal canvas: measure a cell once, turn clicks and the wheel into
//! pane focus, scrolling and selection, and keep the program's size. The ops
//! themselves are drawn in [`super::canvas_paint`]; resizing is debounced so
//! dragging the window does not flood the engine.

use std::rc::Rc;
use std::time::{Duration, Instant};

use crossbeam_channel::{unbounded, RecvTimeoutError, Sender};
use gpui::{
    canvas, div, px, Bounds, ContentMask, Context, ElementInputHandler, Font, Hsla,
    InteractiveElement, IntoElement, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent,
    ParentElement, Pixels, ScrollEvent, SharedString, Styled, TextRun, Window,
};

use crate::model::{Frame, PaneId, Rect, Size};
use crate::terminal::{links, Highlight, HighlightKind};

use super::canvas_paint;
use super::layout;
use super::menu::ContextMenu;
use super::selection::Selection;
use super::slide;
use super::theme::{mono_font, tone, Chrome};
use super::window::PairfobWindow;

const RESIZE_DEBOUNCE: Duration = Duration::from_millis(100);

#[derive(Clone)]
pub struct CellMetrics {
    pub width: f32,
    pub height: f32,
    pub font_size: f32,
    pub font: Font,
}

impl CellMetrics {
    /// The default-size cell, kept as the entry point for callers that do not
    /// carry a size.
    #[allow(dead_code)]
    pub fn measure(window: &Window) -> Self {
        Self::measure_at(window, layout::TERMINAL_FONT_SIZE)
    }

    /// The same cell at a chosen size. The size is clamped because a stored
    /// setting can predate the current range.
    pub fn measure_at(window: &Window, font_size: f32) -> Self {
        let font_size = px(layout::clamp_font_size(font_size));
        let font = mono_font();
        let line = shape_m(&font, font_size, window);
        let width = f32::from(line.width).max(1.);
        let ascent = f32::from(line.ascent);
        let descent = f32::from(line.descent);
        let height = (ascent + descent).ceil().max(f32::from(font_size));
        Self {
            width,
            height,
            font_size: f32::from(font_size),
            font,
        }
    }
}

fn shape_m(font: &Font, font_size: Pixels, window: &Window) -> gpui::ShapedLine {
    window.text_system().shape_line(
        SharedString::new_static("M"),
        font_size,
        &[TextRun {
            len: 1,
            font: font.clone(),
            color: Hsla::default(),
            background_color: None,
            underline: None,
            strikethrough: None,
        }],
        None,
    )
}

/// One worker for the window's lifetime. A size is sent only after it has
/// stayed unchanged for the debounce, and only when it differs from the last
/// one sent.
pub fn spawn_resize_worker(handle: crate::herdr::EngineHandle) -> Sender<Size> {
    let (tx, rx) = unbounded::<Size>();
    std::thread::spawn(move || {
        let mut pending: Option<(Size, Instant)> = None;
        let mut sent: Option<Size> = None;
        loop {
            let wait = pending
                .map(|(_, at)| {
                    RESIZE_DEBOUNCE
                        .checked_sub(at.elapsed())
                        .unwrap_or_default()
                })
                .unwrap_or(Duration::from_secs(3600));
            match rx.recv_timeout(wait) {
                Ok(size) => pending = Some((size, Instant::now())),
                Err(RecvTimeoutError::Timeout) => {
                    let ready = pending.is_some_and(|(_, at)| at.elapsed() >= RESIZE_DEBOUNCE);
                    if !ready {
                        continue;
                    }
                    let Some((size, _)) = pending.take() else {
                        continue;
                    };
                    if sent != Some(size) {
                        sent = Some(size);
                        let _ = handle.resize(size.cols, size.rows);
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    });
    tx
}

impl PairfobWindow {
    pub(crate) fn terminal_canvas_with(
        &mut self,
        frame: std::sync::Arc<Frame>,
        find_highlights: Vec<Highlight>,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let entity = cx.entity();
        let focus = self.focus.clone();
        let cell = self.cell.clone();
        let theme = self.terminal_theme.clone();
        let paint_theme = theme.clone();
        let paint_chrome = self.chrome.clone();
        let cache = Rc::clone(&self.glyph_cache);
        let ops_cache = Rc::clone(&self.ops_cache);
        let canvas_bounds = Rc::clone(&self.canvas_bounds);
        let resize = self.resize_tx.clone();
        let input_enabled = self.pairing.is_none();
        let mut highlights = find_highlights;
        if let Some(selection) = self.selection.as_ref() {
            let (start, end) = selection.ordered();
            highlights.push(Highlight {
                pane: selection.pane.clone(),
                start,
                end,
                kind: HighlightKind::Selection,
            });
        }
        let scrollbar = Chrome::blend(self.chrome.foreground, self.chrome.muted, 40);
        // A selection or find hit lives in frame coordinates, so it holds the
        // picture still while it exists; a slid frame would shift them apart.
        let frame = match (self.selection.is_none() && highlights.is_empty())
            .then(|| slide::painted_lines(self.wheel_slide.as_ref(), &frame))
            .flatten()
        {
            Some((pane, lines)) => std::sync::Arc::new(slide::slide_frame(&frame, pane, lines)),
            None => frame,
        };
        let split_preview = self
            .split_drag
            .as_ref()
            .map(|drag| (drag.split.clone(), drag.ratio));
        let paint_frame = frame.clone();

        let background = tone(theme.background);
        let view = div()
            .relative()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .overflow_hidden()
            .pl(px(12.))
            .pt(px(8.))
            .pb(px(8.))
            .bg(background)
            .on_mouse_down(MouseButton::Left, cx.listener(Self::canvas_mouse_down))
            .on_mouse_down(MouseButton::Right, cx.listener(Self::canvas_right_click))
            .on_scroll(cx.listener(Self::canvas_scroll))
            .child(
                canvas(
                    move |bounds, _, _| {
                        let grid = layout::grid_for(
                            f32::from(bounds.size.width),
                            f32::from(bounds.size.height),
                            cell.width,
                            cell.height,
                        );
                        canvas_bounds.set(Some(bounds));
                        let _ = resize.send(grid);
                        ops_cache
                            .borrow_mut()
                            .get(&frame, &paint_theme, &highlights)
                    },
                    move |bounds, ops, window, cx| {
                        if input_enabled {
                            window.handle_input(
                                &focus,
                                ElementInputHandler::new(bounds, entity.clone()),
                                cx,
                            );
                        }
                        window.with_content_mask(Some(ContentMask { bounds }), |window| {
                            let cursors = window.paint_layer(bounds, |window| {
                                canvas_paint::ops(
                                    &ops,
                                    bounds,
                                    &cell,
                                    &cache,
                                    &theme,
                                    &paint_chrome,
                                    window,
                                )
                            });
                            for cursor in cursors {
                                canvas_paint::cursor(bounds, &cell, &cache, cursor, window);
                            }
                            if let Some((split, ratio)) = &split_preview {
                                canvas_paint::preview(bounds, &cell, split, *ratio, &theme, window);
                            }
                            canvas_paint::scrollbars(
                                &paint_frame,
                                bounds,
                                &cell,
                                scrollbar,
                                window,
                            );
                        });
                    },
                )
                .size_full(),
            );
        view.into_any_element()
    }

    pub(crate) fn canvas_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.pairing.is_some() {
            return;
        }
        if event.modifiers.platform {
            if let Some((pane, _, x, y)) = self.cell_at(event.position) {
                let link = self.app.frame.as_ref().and_then(|frame| {
                    let pane = frame.panes.iter().find(|rect| rect.id == pane)?;
                    links::link_at(frame, pane, x, y)
                });
                if let Some(url) = link {
                    let _ = links::open_external(&url);
                    cx.stop_propagation();
                    return;
                }
            }
        }
        self.focus_canvas(window, cx);
        let Some((pane, _, x, y)) = self.cell_at(event.position) else {
            return;
        };
        if let Some((tab, split)) = self.split_under(x, y) {
            if event.click_count == 2 {
                let _ = self.handle.set_split_ratio(tab, split.path.clone(), 0.5);
            } else {
                self.split_drag = Some(super::window::SplitDrag {
                    tab,
                    ratio: layout::split_ratio(&split, x, y),
                    split,
                });
                cx.notify();
            }
            return;
        }
        self.focus_pane(pane.clone(), window, cx);
        self.drag = Some(Selection {
            pane,
            anchor: (x, y),
            head: (x, y),
        });
    }

    pub(crate) fn canvas_right_click(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.pairing.is_some() {
            return;
        }
        match self.cell_at(event.position) {
            Some((pane, _, _, _)) => self.focus_pane(pane, window, cx),
            None => self.focus_canvas(window, cx),
        }
        // A right-click keeps whatever text is selected.
        self.menu = Some(ContextMenu { at: event.position });
        self.menu_hover = None;
        cx.notify();
    }

    pub(crate) fn canvas_scroll(
        &mut self,
        event: &ScrollEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.pairing.is_some() {
            return;
        }
        let Some((pane, rect, x, y)) = self.cell_at(event.position) else {
            return;
        };
        let delta = f32::from(event.delta.pixel_delta(px(self.cell.height)).y);
        let lines = take_lines(&mut self.wheel_remainder, delta, self.cell.height);
        if lines != 0 {
            self.predict_scroll(&pane, lines, cx);
            let _ = self.handle.scroll(pane, x - rect.x, y - rect.y, lines);
        }
        cx.stop_propagation();
    }

    /// Moves the picture by the rows the wheel is about to ask the daemon for,
    /// so the gesture does not wait on the round trip. A pane that reads the
    /// wheel itself has no scrollback to predict.
    fn predict_scroll(&mut self, pane: &PaneId, lines: i32, cx: &mut Context<Self>) {
        let Some(frame) = self.app.frame.as_ref() else {
            return;
        };
        let scrollback = frame
            .panes
            .iter()
            .find(|candidate| &candidate.id == pane)
            .and_then(|candidate| {
                let scroll = candidate.scroll?;
                (!candidate.alternate_screen && !candidate.mouse_reporting).then_some(scroll)
            });
        let next = scrollback.and_then(|scroll| {
            slide::advanced(
                self.wheel_slide.as_ref(),
                pane,
                scroll,
                lines,
                std::time::Instant::now(),
            )
        });
        if next != self.wheel_slide {
            self.wheel_slide = next;
            cx.notify();
        }
    }

    /// The tab and split under a surface cell, when the cell is on a divider.
    fn split_under(
        &self,
        x: u16,
        y: u16,
    ) -> Option<(crate::model::TabId, crate::model::SplitRect)> {
        if !self.app.supports("layout.set_split_ratio") {
            return None;
        }
        let frame = self.app.frame.as_ref()?;
        let split = layout::split_at(frame, x, y)?.clone();
        let pane = frame.pane_at(x, y)?;
        let tab = self
            .app
            .session
            .as_ref()?
            .find_pane(&pane.id)
            .map(|(_, tab, _)| tab.id.clone())?;
        Some((tab, split))
    }

    /// The drag outlives the canvas, so the move and up handlers live on the
    /// root; this only turns the pointer back into a cell inside the pane the
    /// drag started in.
    pub(crate) fn root_mouse_move(
        &mut self,
        event: &MouseMoveEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if event.pressed_button != Some(MouseButton::Left) {
            return;
        }
        if let Some((started, width)) = self.sidebar_drag {
            let delta = f32::from(event.position.x) - started;
            self.sidebar_width = layout::sidebar_width(width + delta, false);
            cx.notify();
            return;
        }
        if let Some(drag) = self.split_drag.as_mut() {
            if let Some(bounds) = self.canvas_bounds.get() {
                let x = ((f32::from(event.position.x) - f32::from(bounds.origin.x))
                    / self.cell.width)
                    .max(0.) as u16;
                let y = ((f32::from(event.position.y) - f32::from(bounds.origin.y))
                    / self.cell.height)
                    .max(0.) as u16;
                drag.ratio = layout::split_ratio(&drag.split, x, y);
                cx.notify();
            }
            return;
        }
        let Some(drag) = self.drag.clone() else {
            return;
        };
        let Some(head) = self.clamped_cell(&drag.pane, event.position) else {
            return;
        };
        if drag.head == head {
            return;
        }
        let drag = Selection { head, ..drag };
        self.selection = Some(drag.clone());
        self.drag = Some(drag);
        cx.notify();
    }

    pub(crate) fn root_mouse_up(
        &mut self,
        _event: &MouseUpEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.sidebar_drag.take().is_some() {
            cx.notify();
            return;
        }
        if let Some(drag) = self.split_drag.take() {
            let _ = self
                .handle
                .set_split_ratio(drag.tab, drag.split.path, drag.ratio);
            cx.notify();
            return;
        }
        let Some(drag) = self.drag.take() else {
            return;
        };
        // A click that never left its cell is not a selection; it clears one.
        if drag.is_empty() && self.selection.take().is_some() {
            cx.notify();
        }
    }

    /// The pane and cell under a window position, or `None` over the padding
    /// and outside the frame.
    fn cell_at(&self, position: gpui::Point<Pixels>) -> Option<(PaneId, Rect, u16, u16)> {
        let bounds = self.canvas_bounds.get()?;
        let frame = self.app.frame.as_ref()?;
        let local_x = f32::from(position.x) - f32::from(bounds.origin.x);
        let local_y = f32::from(position.y) - f32::from(bounds.origin.y);
        if local_x < 0.
            || local_y < 0.
            || local_x >= f32::from(bounds.size.width)
            || local_y >= f32::from(bounds.size.height)
        {
            return None;
        }
        let (x, y) = self.cell_position(bounds, position)?;
        if !frame.size.contains(x, y) {
            return None;
        }
        let pane = frame.pane_at(x, y)?;
        Some((pane.id.clone(), pane.rect, x, y))
    }

    /// The cell under a window position, clamped into `pane`'s rectangle so a
    /// pointer that leaves the pane still produces a valid head.
    fn clamped_cell(&self, pane: &PaneId, position: gpui::Point<Pixels>) -> Option<(u16, u16)> {
        let bounds = self.canvas_bounds.get()?;
        let frame = self.app.frame.as_ref()?;
        let rect = frame
            .panes
            .iter()
            .find(|candidate| &candidate.id == pane)?
            .rect;
        if rect.width == 0 || rect.height == 0 {
            return None;
        }
        let (x, y) = self.cell_position(bounds, position)?;
        let x = f32::from(x).clamp(f32::from(rect.x), f32::from(rect.right() - 1));
        let y = f32::from(y).clamp(f32::from(rect.y), f32::from(rect.bottom() - 1));
        Some((x as u16, y as u16))
    }

    fn cell_position(
        &self,
        bounds: Bounds<Pixels>,
        position: gpui::Point<Pixels>,
    ) -> Option<(u16, u16)> {
        if !(self.cell.width > 0. && self.cell.height > 0.) {
            return None;
        }
        let local_x = f32::from(position.x) - f32::from(bounds.origin.x);
        let local_y = f32::from(position.y) - f32::from(bounds.origin.y);
        if !(local_x.is_finite() && local_y.is_finite()) {
            return None;
        }
        let x = (local_x / self.cell.width).floor();
        let y = (local_y / self.cell.height).floor();
        Some((x as u16, y as u16))
    }
}

/// Whole cell rows in `delta_px`, positive being up. The sub-cell remainder
/// stays in `remainder` so a trackpad's small deltas still add up.
pub(super) fn take_lines(remainder: &mut f32, delta_px: f32, cell_height: f32) -> i32 {
    if !cell_height.is_finite() || cell_height <= 0. || !delta_px.is_finite() {
        return 0;
    }
    let total = *remainder + delta_px;
    let lines = (total / cell_height).trunc();
    *remainder = total - lines * cell_height;
    lines as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wheel_lines_accumulate_sub_cell_motion_and_keep_the_remainder() {
        let mut remainder = 0.;
        assert_eq!(take_lines(&mut remainder, 9., 18.), 0);
        assert_eq!(take_lines(&mut remainder, 9., 18.), 1);
        assert_eq!(remainder, 0.);
        assert_eq!(take_lines(&mut remainder, 36., 18.), 2);
        assert_eq!(take_lines(&mut remainder, -9., 18.), 0);
        assert_eq!(take_lines(&mut remainder, -9., 18.), -1);
        assert_eq!(take_lines(&mut remainder, 5., 0.), 0);
        assert_eq!(take_lines(&mut remainder, f32::INFINITY, 18.), 0);
    }
}
