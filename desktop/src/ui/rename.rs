//! Renaming the focused pane. Herdr keeps the label, so the card only collects
//! the text and sends `pane.rename`; an empty label clears the name back to the
//! program's own title.

use gpui::prelude::*;
use gpui::{
    div, px, AnyElement, Context, FontWeight, IntoElement, MouseButton, MouseDownEvent,
    SharedString, Styled, Window,
};

use crate::model::PaneId;

use super::controls::{button, small_button, ButtonKind};
use super::layout;
use super::theme::{mono_font, tone};
use super::window::PairfobWindow;

#[derive(Debug)]
pub(crate) struct RenameState {
    pub(crate) pane: PaneId,
    pub(crate) text: String,
    pub(crate) error: Option<String>,
}

impl PairfobWindow {
    pub(crate) fn open_rename(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.rename.is_some() {
            return;
        }
        if !self.app.supports("pane.rename") {
            self.notify(
                crate::app::Notice::warning("This daemon cannot rename panes; update it first."),
                cx,
            );
            return;
        }
        let Some(pane) = self.app.focused_pane() else {
            return;
        };
        let text = self
            .app
            .pane(&pane)
            .and_then(|pane| pane.label.clone())
            .unwrap_or_default();
        self.rename = Some(RenameState {
            pane,
            text,
            error: None,
        });
        self.focus_canvas(window, cx);
        cx.notify();
    }

    pub(crate) fn close_rename(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.rename.take().is_some() {
            self.marked.clear();
            self.marked_selection = None;
            self.focus_canvas(window, cx);
            cx.notify();
        }
    }

    pub(crate) fn rename_push(&mut self, text: &str, cx: &mut Context<Self>) {
        if let Some(rename) = self.rename.as_mut() {
            rename.text.push_str(text);
            cx.notify();
        }
    }

    pub(crate) fn rename_backspace(&mut self, cx: &mut Context<Self>) {
        if let Some(rename) = self.rename.as_mut() {
            rename.text.pop();
            cx.notify();
        }
    }

    pub(crate) fn commit_rename(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(rename) = self.rename.as_ref() else {
            return;
        };
        let pane = rename.pane.clone();
        let label = rename.text.trim().to_owned();
        match self.handle.rename_pane(pane, label) {
            Ok(()) => self.close_rename(window, cx),
            Err(error) => {
                if let Some(rename) = self.rename.as_mut() {
                    rename.error = Some(error.to_string());
                }
                cx.notify();
            }
        }
    }

    pub(crate) fn rename_card(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let rename = self.rename.as_ref()?;
        let chrome = self.chrome.clone();
        let text = if rename.text.is_empty() && self.marked.is_empty() {
            "Pane name".to_owned()
        } else {
            format!("{}{}", rename.text, self.marked)
        };
        let color = if rename.text.is_empty() {
            chrome.muted
        } else {
            chrome.foreground
        };
        Some(
            div()
                .absolute()
                .top(px(layout::TOOLBAR_HEIGHT + 24.))
                .left(px(0.))
                .right(px(0.))
                .flex()
                .justify_center()
                .child(
                    div()
                        .id("rename-card")
                        .w(px(320.))
                        .flex()
                        .flex_col()
                        .gap(px(10.))
                        .p(px(14.))
                        .rounded(px(layout::RADIUS_CARD))
                        .bg(tone(chrome.card))
                        .border(px(1.))
                        .border_color(tone(chrome.line))
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|_this, _: &MouseDownEvent, _window, _cx| {}),
                        )
                        .child(
                            div()
                                .text_size(px(13.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(tone(chrome.foreground))
                                .child("Rename pane"),
                        )
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .h(px(30.))
                                .px(px(8.))
                                .rounded(px(layout::RADIUS_CONTROL))
                                .bg(tone(chrome.raised))
                                .border(px(1.))
                                .border_color(tone(chrome.accent))
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .truncate()
                                        .font(mono_font())
                                        .text_size(px(12.))
                                        .text_color(tone(color))
                                        .child(SharedString::from(text)),
                                ),
                        )
                        .children(rename.error.as_ref().map(|error| {
                            div()
                                .text_size(px(11.))
                                .text_color(tone(chrome.danger))
                                .child(SharedString::from(error.clone()))
                        }))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .child(div().flex_1())
                                .child(small_button(
                                    "rename-cancel",
                                    "Cancel",
                                    &chrome,
                                    ButtonKind::Quiet,
                                    cx.listener(|this, _: &MouseDownEvent, window, cx| {
                                        this.close_rename(window, cx)
                                    }),
                                ))
                                .child(button(
                                    "rename-commit",
                                    "Rename",
                                    &chrome,
                                    ButtonKind::Primary,
                                    cx.listener(|this, _: &MouseDownEvent, window, cx| {
                                        this.commit_rename(window, cx)
                                    }),
                                )),
                        ),
                )
                .into_any_element(),
        )
    }
}
