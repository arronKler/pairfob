//! Screens for the times there is no terminal to show: first run, Herdr
//! starting or failing, the wait for the first frame, and the diagnostics
//! drawer. None of these take rows away from a live terminal; the banner and
//! the drawer float over it.

use gpui::prelude::*;
use gpui::{
    div, px, AnyElement, Context, FontWeight, MouseButton, MouseDownEvent, SharedString, Window,
};

use super::boot::{HerdrState, SetupState, INSTALL_COMMAND};
use super::controls::{button, dot, small_button, ButtonKind};
use super::layout;
use super::theme::{connection_tone, mono_font, tone, Appearance};
use super::window::PairfobWindow;

const PANEL_WIDTH: f32 = 430.;

impl PairfobWindow {
    pub(crate) fn main_content(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let chat = self.chat_visible();
        let highlights = self
            .app
            .frame
            .as_deref()
            .map(|frame| self.find_highlights(frame))
            .unwrap_or_default();
        let content = if chat {
            self.chat_column(cx)
        } else if let Some(frame) = self.app.frame.clone() {
            self.terminal_canvas_with(frame, highlights, cx)
        } else if self.boot.needs_install() && !self.app.connection.is_ready() {
            self.first_run(cx)
        } else {
            match self.boot.herdr.clone() {
                HerdrState::Starting => self.starting_screen(cx),
                HerdrState::Failed(message) => self.failed_screen(&message, cx),
                HerdrState::Missing | HerdrState::Running => self.waiting_screen(cx),
            }
        };
        let banner = self.connection_banner(cx);
        let find = self.find_bar(cx);
        div()
            .relative()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .child(content)
            .children(find)
            .children(banner)
            .into_any_element()
    }

    fn first_run(&self, cx: &mut Context<Self>) -> AnyElement {
        let chrome = self.chrome.clone();
        let retry = button(
            "first-run-retry",
            "Retry",
            &chrome,
            ButtonKind::Primary,
            cx.listener(|this, _: &MouseDownEvent, _window, cx| this.retry(cx)),
        );
        let diagnostics = small_button(
            "first-run-diagnostics",
            "Diagnostics",
            &chrome,
            ButtonKind::Quiet,
            cx.listener(|this, _: &MouseDownEvent, _window, cx| this.open_diagnostics(cx)),
        );
        panel(
            &chrome,
            "Pairfob is not installed yet",
            "Install it with one command, then press Retry. The window finds pairfob and Herdr on your PATH.",
        )
        .child(
            div()
                .px(px(12.))
                .py(px(10.))
                .rounded(px(layout::RADIUS_CONTROL))
                .bg(tone(chrome.background))
                .border(px(1.))
                .border_color(tone(chrome.line_soft))
                .font(mono_font())
                .text_size(px(11.5))
                .text_color(tone(chrome.secondary))
                .whitespace_nowrap()
                .child(INSTALL_COMMAND),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .pt(px(2.))
                .child(retry)
                .child(diagnostics),
        )
        .into_any_element()
    }

    fn starting_screen(&self, cx: &mut Context<Self>) -> AnyElement {
        self.status_screen(
            "Starting Herdr",
            "Pairfob is launching the local Herdr session. This only happens once.",
            cx,
        )
    }

    fn failed_screen(&self, message: &str, cx: &mut Context<Self>) -> AnyElement {
        let chrome = self.chrome.clone();
        let retry = button(
            "herdr-retry",
            "Retry",
            &chrome,
            ButtonKind::Primary,
            cx.listener(|this, _: &MouseDownEvent, _window, cx| this.retry(cx)),
        );
        let diagnostics = small_button(
            "herdr-diagnostics",
            "Diagnostics",
            &chrome,
            ButtonKind::Quiet,
            cx.listener(|this, _: &MouseDownEvent, _window, cx| this.open_diagnostics(cx)),
        );
        panel(&chrome, "Herdr did not start", message)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .pt(px(2.))
                    .child(retry)
                    .child(diagnostics),
            )
            .into_any_element()
    }

    fn waiting_screen(&self, cx: &mut Context<Self>) -> AnyElement {
        let chrome = self.chrome.clone();
        let ready = self.app.connection.is_ready();
        let heading = if ready {
            "Connected; waiting for the first frame"
        } else {
            "Waiting for Herdr"
        };
        let note = if ready {
            "The window is attached. A pane appears here as soon as Herdr sends a frame."
        } else {
            "The window reconnects automatically. Panes and workspaces appear here once Herdr answers."
        };
        let diagnostics = small_button(
            "waiting-diagnostics",
            "Diagnostics",
            &chrome,
            ButtonKind::Quiet,
            cx.listener(|this, _: &MouseDownEvent, _window, cx| this.open_diagnostics(cx)),
        );
        panel(&chrome, heading, note)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .pt(px(2.))
                    .child(dot(
                        tone(connection_tone(&self.app.connection, &chrome)),
                        7.,
                    ))
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(tone(chrome.muted))
                            .child(self.app.connection.label()),
                    )
                    .child(div().flex_1())
                    .child(diagnostics),
            )
            .into_any_element()
    }

    fn status_screen(&self, heading: &str, note: &str, cx: &mut Context<Self>) -> AnyElement {
        let chrome = self.chrome.clone();
        let diagnostics = small_button(
            "status-diagnostics",
            "Diagnostics",
            &chrome,
            ButtonKind::Quiet,
            cx.listener(|this, _: &MouseDownEvent, _window, cx| this.open_diagnostics(cx)),
        );
        panel(&chrome, heading, note)
            .child(div().flex().pt(px(2.)).child(diagnostics))
            .into_any_element()
    }

    /// Only shown while the connection is not usable; it floats over the last
    /// frame instead of shrinking the terminal.
    fn connection_banner(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (reason, color) = match &self.app.connection {
            crate::app::Connection::Offline { reason } => {
                (format!("Offline: {reason}"), self.chrome.danger)
            }
            crate::app::Connection::Reconnecting { attempt, reason } => (
                format!("Reconnecting ({attempt}): {reason}"),
                self.chrome.warning,
            ),
            _ => return None,
        };
        let chrome = self.chrome.clone();
        let retry = small_button(
            "banner-retry",
            "Retry",
            &chrome,
            ButtonKind::Tinted,
            cx.listener(|this, _: &MouseDownEvent, _window, cx| this.retry(cx)),
        );
        let details = small_button(
            "banner-details",
            "Details",
            &chrome,
            ButtonKind::Quiet,
            cx.listener(|this, _: &MouseDownEvent, _window, cx| this.open_diagnostics(cx)),
        );
        Some(
            div()
                .absolute()
                .top(px(10.))
                .left(px(10.))
                .right(px(10.))
                .flex()
                .items_center()
                .gap(px(10.))
                .px(px(12.))
                .py(px(7.))
                .rounded(px(10.))
                .bg(tone(chrome.card))
                .border(px(1.))
                .border_color(tone(chrome.line))
                .child(dot(tone(color), 7.))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_size(px(12.))
                        .text_color(tone(chrome.foreground))
                        .child(reason),
                )
                .child(retry)
                .child(details)
                .into_any_element(),
        )
    }

    pub(crate) fn diagnostics_panel(
        &mut self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let diagnostics = self.boot.diagnostics.as_ref()?;
        let running = diagnostics.doctor_running;
        let report = diagnostics.report.clone();
        let error = diagnostics.error.clone();
        let setup = diagnostics.setup.clone();
        let copied = diagnostics.copied;
        let chrome = self.chrome.clone();

        let viewport = f32::from(window.viewport_size().width);
        let width =
            (viewport - layout::sidebar_width(self.sidebar_width, self.sidebar_collapsed) - 56.)
                .clamp(320., 620.);

        let mut body = div()
            .id("diagnostics-report")
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&self.diagnostics_scroll)
            .p(px(12.))
            .font(mono_font())
            .text_size(px(11.))
            .line_height(px(17.));

        if running {
            body = body.child(line("Running pairfob doctor…", chrome.warning));
        } else if let Some(error) = &error {
            body = body.child(line(error, chrome.danger));
        } else if let Some(report) = &report {
            for text in report.lines() {
                body = body.child(line(text, chrome.secondary));
            }
        } else {
            body = body.child(line("No report yet.", chrome.muted));
        }

        body = body.child(spacer());

        match &setup {
            SetupState::Idle => {}
            SetupState::Running => {
                body = body.child(spacer());
                body = body.child(line(
                    "Running pairfob setup… This can take a few minutes.",
                    chrome.warning,
                ));
            }
            SetupState::Done(text) => {
                body = body.child(spacer());
                body = body.child(line("Setup finished", chrome.success));
                for text in text.lines().take(40) {
                    body = body.child(line(text, chrome.secondary));
                }
            }
            SetupState::Failed(text) => {
                body = body.child(spacer());
                body = body.child(line("Setup failed", chrome.danger));
                for text in text.lines().take(40) {
                    body = body.child(line(text, chrome.secondary));
                }
            }
        }

        let close = small_button(
            "diagnostics-close",
            "Close",
            &chrome,
            ButtonKind::Quiet,
            cx.listener(|this, _: &MouseDownEvent, _window, cx| this.close_diagnostics(cx)),
        );
        let recheck = small_button(
            "diagnostics-recheck",
            "Run doctor again",
            &chrome,
            ButtonKind::Quiet,
            cx.listener(|this, _: &MouseDownEvent, _window, cx| this.rerun_doctor(cx)),
        );
        let copy = small_button(
            "diagnostics-copy",
            if copied { "Copied" } else { "Copy diagnostics" },
            &chrome,
            ButtonKind::Quiet,
            cx.listener(|this, _: &MouseDownEvent, _window, cx| this.copy_diagnostics(cx)),
        );
        let setup_label = match setup {
            SetupState::Running => "Running setup…",
            SetupState::Done(_) => "Run setup again",
            SetupState::Idle | SetupState::Failed(_) => "Run pairfob setup",
        };
        let setup_button = button(
            "diagnostics-setup",
            setup_label,
            &chrome,
            ButtonKind::Primary,
            cx.listener(|this, _: &MouseDownEvent, _window, cx| this.run_setup(cx)),
        );
        let appearance = appearance_row(self.appearance, &chrome, cx);
        let update = self.update_row(&chrome, cx);

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
                                .child("Diagnostics"),
                        )
                        .child(close),
                )
                .child(appearance)
                .child(update)
                .child(body)
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap(px(8.))
                        .px(px(12.))
                        .py(px(10.))
                        .flex_none()
                        .border_t(px(1.))
                        .border_color(tone(chrome.line_soft))
                        .child(setup_button)
                        .child(recheck)
                        .child(copy),
                )
                .into_any_element(),
        )
    }
}

/// The scheme picker. `Auto` follows macOS; the other two pin one scheme.
/// It lives at the top of the diagnostics drawer so the operation is
/// discoverable without knowing the shortcut.
fn appearance_row(
    current: Appearance,
    chrome: &super::theme::Chrome,
    cx: &mut Context<PairfobWindow>,
) -> AnyElement {
    let mut row = div()
        .flex()
        .items_center()
        .gap(px(4.))
        .h(px(44.))
        .px(px(14.))
        .flex_none()
        .border_b(px(1.))
        .border_color(tone(chrome.line_soft))
        .child(
            div()
                .flex_1()
                .text_size(px(12.))
                .text_color(tone(chrome.secondary))
                .child("Appearance"),
        );
    for choice in [Appearance::Auto, Appearance::Light, Appearance::Dark] {
        row = row.child(appearance_choice(choice, current, chrome, cx));
    }
    row.child(
        div()
            .ml(px(6.))
            .text_size(px(10.5))
            .text_color(tone(chrome.muted))
            .child("⌘⇧A"),
    )
    .into_any_element()
}

fn appearance_choice(
    choice: Appearance,
    current: Appearance,
    chrome: &super::theme::Chrome,
    cx: &mut Context<PairfobWindow>,
) -> AnyElement {
    let active = choice == current;
    let (id, label) = match choice {
        Appearance::Auto => ("appearance-auto", "Auto"),
        Appearance::Light => ("appearance-light", "Light"),
        Appearance::Dark => ("appearance-dark", "Dark"),
    };
    div()
        .id(id)
        .flex()
        .items_center()
        .h(px(24.))
        .px(px(9.))
        .rounded(px(layout::RADIUS_CONTROL))
        .bg(tone(if active {
            chrome.raised
        } else {
            chrome.background
        }))
        .text_size(px(11.5))
        .text_color(tone(if active {
            chrome.foreground
        } else {
            chrome.muted
        }))
        .cursor_pointer()
        .when(!active, |segment| {
            segment.hover(|style| style.bg(tone(chrome.hover)))
        })
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(move |this, _: &MouseDownEvent, window, cx| {
                this.set_appearance(choice, window, cx)
            }),
        )
        .child(label)
        .into_any_element()
}

fn panel(chrome: &super::theme::Chrome, heading: &str, note: &str) -> gpui::Div {
    div()
        .flex_1()
        .min_h_0()
        .flex()
        .items_center()
        .justify_center()
        .p(px(24.))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(10.))
                .w_full()
                .max_w(px(PANEL_WIDTH))
                .p(px(26.))
                .rounded(px(layout::RADIUS_CARD))
                .bg(tone(chrome.card))
                .border(px(1.))
                .border_color(tone(chrome.line))
                .child(
                    div()
                        .text_size(px(16.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(tone(chrome.foreground))
                        .child(SharedString::from(heading.to_owned())),
                )
                .child(
                    div()
                        .text_size(px(12.))
                        .line_height(px(19.))
                        .text_color(tone(chrome.secondary))
                        .whitespace_normal()
                        .child(SharedString::from(note.to_owned())),
                ),
        )
}

fn line(text: &str, color: crate::terminal::Rgb) -> AnyElement {
    div()
        .text_size(px(11.))
        .text_color(tone(color))
        .whitespace_normal()
        .child(SharedString::from(text.to_owned()))
        .into_any_element()
}

fn spacer() -> AnyElement {
    div().h(px(8.)).flex_none().into_any_element()
}
