//! Commands the window sends to Herdr and the few it applies to itself. Each
//! one reads the focused pane from the app and returns nothing: the engine's
//! answer arrives later as an event, like every other change on screen.

use std::sync::Arc;

use gpui::{Context, Window};

use crate::app::{App, Notice};
use crate::herdr::engine::{Direction, ZoomMode};
use crate::herdr::Desktop;
use crate::model::{SplitDirection, TabId};

use super::terminal::{spawn_resize_worker, CellMetrics};

impl super::window::PairfobWindow {
    pub(crate) fn focus_tab(&mut self, tab: TabId) {
        let _ = self.handle.focus_tab(tab);
    }

    pub(crate) fn split_focused(&mut self, direction: SplitDirection) {
        let Some(pane) = self.app.focused_pane() else {
            return;
        };
        let _ = self.handle.split(pane, direction, true);
    }

    pub(crate) fn zoom_focused(&mut self) {
        let Some(pane) = self.app.focused_pane() else {
            return;
        };
        let _ = self.handle.zoom(pane, ZoomMode::Toggle);
    }

    pub(crate) fn close_focused_pane(&mut self) {
        let Some(pane) = self.app.focused_pane() else {
            return;
        };
        let _ = self.handle.close_pane(pane);
    }

    /// ⌘+ / ⌘− step the text size; the cell is measured again from the new
    /// point size, so the grid follows without touching the program's rows
    /// until the canvas reports its own size.
    pub(crate) fn zoom_text(&mut self, delta: f32, window: &mut Window, cx: &mut Context<Self>) {
        let size = self.font_size + delta * super::layout::FONT_SIZE_STEP;
        self.set_font_size(size, window, cx);
    }

    pub(crate) fn reset_text_size(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.set_font_size(super::layout::FONT_SIZE_DEFAULT, window, cx);
    }

    pub(crate) fn set_font_size(&mut self, size: f32, window: &mut Window, cx: &mut Context<Self>) {
        let size = super::layout::clamp_font_size(size);
        if (size - self.font_size).abs() < f32::EPSILON {
            return;
        }
        self.font_size = size;
        self.cell = CellMetrics::measure_at(window, size);
        self.glyph_cache.borrow_mut().clear();
        self.save_geometry();
        cx.notify();
    }

    pub(crate) fn focus_direction(&mut self, direction: Direction) {
        if let Some(pane) = self.app.focused_pane() {
            let _ = self.handle.focus_direction(pane, direction);
        }
    }

    pub(crate) fn swap_focused(&mut self, direction: Direction) {
        if let Some(pane) = self.app.focused_pane() {
            let _ = self.handle.swap_pane(pane, direction);
        }
    }

    pub(crate) fn resize_focused(&mut self, direction: Direction) {
        if let Some(pane) = self.app.focused_pane() {
            let _ = self.handle.resize_pane(pane, direction);
        }
    }

    /// Attach the window to another Herdr session on this machine. The old
    /// engine is shut down and a new one started, while the window and its
    /// overlays stay put.
    pub(crate) fn switch_session(&mut self, name: Option<String>, cx: &mut Context<Self>) {
        if self.session == name {
            self.close_sessions(cx);
            return;
        }
        let mut config = crate::herdr::Config::local();
        config.target = match &name {
            Some(name) => crate::herdr::ConnectTarget::Session {
                name: name.clone(),
                development: false,
            },
            None => crate::herdr::ConnectTarget::Local,
        };
        self.handle.shutdown();
        self.app = App::default();
        self.chat = None;
        self.chat_panes.clear();
        self.chat_error = None;
        self.chat_attempted = None;
        self.composer.clear();
        self.selection = None;
        self.drag = None;
        self.menu = None;
        self.find = None;
        self.rename = None;
        self.sessions = None;
        self.marked.clear();
        self.marked_selection = None;
        self.session = name.clone();
        self.boot.set_session(name.clone());
        crate::log::info(&format!(
            "attaching to session {}",
            name.as_deref().unwrap_or("default")
        ));
        match crate::herdr::start(config) {
            Ok(Desktop { handle, events }) => {
                self.handle = handle.clone();
                super::window::spawn_pump(events, Arc::clone(&self.mailbox), self.wake.clone());
                self.resize_tx = spawn_resize_worker(handle);
            }
            Err(error) => {
                crate::log::error(&format!("session attach failed: {error}"));
                self.notify(
                    Notice::error(format!("could not attach to that session: {error}")),
                    cx,
                );
            }
        }
        cx.notify();
    }
}
