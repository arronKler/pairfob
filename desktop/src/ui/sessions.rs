//! The Herdr session switcher. Sessions are separate sockets on this machine;
//! this drawer lists the ones that exist right now and moves the window to the
//! chosen one, which reconnects the engine without restarting the app.

use gpui::prelude::*;
use gpui::{
    div, px, AnyElement, Context, FontWeight, IntoElement, MouseDownEvent, SharedString, Styled,
};

use crate::process::sessions::{self, HerdrSession};

use super::controls::{button, dot, small_button, ButtonKind};
use super::layout;
use super::theme::{mono_font, tone, Chrome};
use super::window::PairfobWindow;

#[derive(Debug)]
pub(crate) struct SessionsSheet {
    pub(crate) entries: Vec<HerdrSession>,
    /// The session the window is attached to; `None` is the default one.
    pub(crate) current: Option<String>,
}

impl SessionsSheet {
    pub(crate) fn open(current: Option<String>) -> Self {
        Self {
            entries: sessions::list(),
            current,
        }
    }

    fn is_current(&self, entry: &HerdrSession) -> bool {
        entry.name == self.current
    }

    /// Three invented sessions, so the window shot never touches the real ones.
    #[cfg(feature = "shot")]
    pub(crate) fn fixture(current: Option<String>) -> Self {
        use std::path::PathBuf;
        let root = PathBuf::from("/Users/you/.config/herdr");
        let entry = |name: Option<&str>, alive: bool| HerdrSession {
            name: name.map(str::to_owned),
            socket: match name {
                Some(name) => root.join(format!("sessions/{name}/herdr-client.sock")),
                None => root.join("herdr-client.sock"),
            },
            alive,
        };
        Self {
            entries: vec![
                entry(None, false),
                entry(Some("pffixture"), true),
                entry(Some("release"), true),
            ],
            current,
        }
    }
}

impl PairfobWindow {
    pub(crate) fn open_sessions(&mut self, cx: &mut Context<Self>) {
        self.devices = None;
        self.boot.close_diagnostics();
        let sheet = SessionsSheet::open(self.session.clone());
        self.session_count = sheet.entries.len();
        self.sessions = Some(sheet);
        cx.notify();
    }

    pub(crate) fn close_sessions(&mut self, cx: &mut Context<Self>) {
        if self.sessions.take().is_some() {
            cx.notify();
        }
    }

    pub(crate) fn session_drawer(
        &mut self,
        window: &gpui::Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let sheet = self.sessions.as_ref()?;
        let chrome = self.chrome.clone();
        let rows: Vec<(Option<String>, String, String, bool, bool)> = sheet
            .entries
            .iter()
            .map(|entry| {
                (
                    entry.name.clone(),
                    entry.name.clone().unwrap_or_else(|| "default".to_owned()),
                    entry.socket.display().to_string(),
                    entry.alive,
                    sheet.is_current(entry),
                )
            })
            .collect();
        let viewport = f32::from(window.viewport_size().width);
        let width =
            (viewport - layout::sidebar_width(self.sidebar_width, self.sidebar_collapsed) - 56.)
                .clamp(320., 520.);

        let mut body = div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .p(px(10.))
            .flex_1()
            .min_h_0();
        if rows.is_empty() {
            body = body.child(
                div()
                    .text_size(px(12.))
                    .text_color(tone(chrome.muted))
                    .child("No Herdr sessions found on this machine."),
            );
        }
        for (name, label, socket, alive, is_current) in rows {
            body = body.child(session_row(
                name, label, socket, alive, is_current, &chrome, cx,
            ));
        }

        Some(
            div()
                .absolute()
                .top(px(layout::TOOLBAR_HEIGHT + 10.))
                .right(px(14.))
                .bottom(px(14.))
                .w(px(width))
                .flex()
                .flex_col()
                .rounded(px(layout::RADIUS_CARD))
                .bg(tone(chrome.card))
                .border(px(1.))
                .border_color(tone(chrome.line))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .h(px(46.))
                        .px(px(14.))
                        .flex_none()
                        .border_b(px(1.))
                        .border_color(tone(chrome.line_soft))
                        .child(
                            div()
                                .flex_1()
                                .text_size(px(13.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(tone(chrome.foreground))
                                .child("Sessions"),
                        )
                        .child(small_button(
                            "sessions-close",
                            "Close",
                            &chrome,
                            ButtonKind::Quiet,
                            cx.listener(|this, _: &MouseDownEvent, _window, cx| {
                                this.close_sessions(cx)
                            }),
                        )),
                )
                .child(body)
                .child(
                    div()
                        .flex()
                        .items_center()
                        .px(px(12.))
                        .py(px(10.))
                        .flex_none()
                        .border_t(px(1.))
                        .border_color(tone(chrome.line_soft))
                        .child(
                            div()
                                .text_size(px(10.5))
                                .text_color(tone(chrome.muted))
                                .child("Switching reconnects this window; panes keep running."),
                        ),
                )
                .into_any_element(),
        )
    }
}

#[allow(clippy::too_many_arguments)]
fn session_row(
    name: Option<String>,
    label: String,
    socket: String,
    alive: bool,
    is_current: bool,
    chrome: &Chrome,
    cx: &mut Context<PairfobWindow>,
) -> AnyElement {
    let color = if alive { chrome.success } else { chrome.muted };
    let action = if is_current {
        div()
            .text_size(px(11.))
            .text_color(tone(chrome.muted))
            .child("current")
            .into_any_element()
    } else if !alive {
        // A directory without a live socket would only fail after the engine
        // swapped out the working one, so it is shown but not offered.
        div()
            .text_size(px(11.))
            .text_color(tone(chrome.muted))
            .child("not running")
            .into_any_element()
    } else {
        let target = name.clone();
        let id = SharedString::from(format!("session-switch-{label}"));
        button(
            id,
            "Switch",
            chrome,
            ButtonKind::Bordered,
            cx.listener(move |this, _: &MouseDownEvent, _window, cx| {
                this.switch_session(target.clone(), cx)
            }),
        )
        .into_any_element()
    };
    div()
        .flex()
        .items_center()
        .gap(px(8.))
        .p(px(10.))
        .rounded(px(8.))
        .bg(tone(chrome.raised))
        .child(dot(tone(color), 7.))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(
                    div()
                        .truncate()
                        .text_size(px(13.))
                        .text_color(tone(chrome.foreground))
                        .child(SharedString::from(label)),
                )
                .child(
                    div()
                        .truncate()
                        .font(mono_font())
                        .text_size(px(10.))
                        .text_color(tone(chrome.muted))
                        .child(SharedString::from(socket)),
                ),
        )
        .child(action)
        .into_any_element()
}
