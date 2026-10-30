//! The root view: the session list, the toolbar that names the workspace and
//! carries the window's actions, the terminal or the screen that replaces it,
//! and the footer. Overlays float above everything.

use gpui::prelude::*;
use gpui::{div, px, AnyElement, Context, MouseButton, MouseDownEvent, SharedString, Window};
#[cfg(feature = "perf-hud")]
use gpui_fps::fps_monitor;

use crate::app::NoticeLevel;
use crate::model::{SplitDirection, Tab};

use super::controls::{chip, dot, small_button, ButtonKind};
use super::layout;
use super::theme::{connection_tone, mono_font, tone, Chrome};
use super::window::PairfobWindow;

impl Render for PairfobWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let sidebar = self.sidebar(window, cx);
        let toolbar = self.toolbar(cx);
        let content = self.main_content(cx);
        let footer = self.footer(cx);
        let pairing = self.pairing_sheet(window, cx);
        let diagnostics = self.diagnostics_panel(window, cx);
        let devices = self.devices_drawer(window, cx);
        let sessions = self.session_drawer(window, cx);
        let rename = self.rename_card(cx);
        let menu = self.context_menu(window, cx);

        let root = div()
            .relative()
            .flex()
            .size_full()
            .bg(tone(self.chrome.background))
            .text_color(tone(self.chrome.foreground))
            .font(super::theme::ui_font())
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::key_down))
            .on_mouse_move(cx.listener(Self::root_mouse_move))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::root_mouse_up))
            .child(sidebar)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .child(toolbar)
                    .child(content)
                    .child(footer),
            )
            .children(diagnostics)
            .children(devices)
            .children(sessions)
            .children(pairing)
            .children(rename)
            .children(menu);

        // The development HUD floats over the content; F12 toggles it.
        #[cfg(feature = "perf-hud")]
        if self.show_perf_hud {
            return root.child(fps_monitor(window, cx));
        }

        root
    }
}

impl PairfobWindow {
    fn toolbar(&self, cx: &mut Context<Self>) -> AnyElement {
        let chrome = self.chrome.clone();
        let workspace = self
            .app
            .session
            .as_ref()
            .and_then(|session| session.focused_workspace());
        let title = workspace
            .map(|workspace| workspace.label.clone())
            .unwrap_or_else(|| "Pairfob".to_owned());
        let branch = workspace
            .and_then(|workspace| workspace.branch.clone())
            .filter(|branch| !branch.trim().is_empty());
        let notice = self.app.notice.as_ref().map(|notice| {
            let color = match notice.level {
                NoticeLevel::Info => chrome.secondary,
                NoticeLevel::Warning => chrome.warning,
                NoticeLevel::Error => chrome.danger,
            };
            (notice.text.clone(), color)
        });
        let chat_available = self.chat_target().is_some();
        let chat_on = self.chat_visible();
        let ready = self.app.connection.is_ready();
        let connection = self.app.connection.clone();
        let tools = self.boot.tools().is_some();
        let sessions_available = self.session_count > 1;
        let can_split = self.app.supports("pane.split");
        let can_zoom = self.app.supports("pane.zoom");
        let collapsed = self.sidebar_collapsed;
        let compact = self.content_width() < layout::COMPACT_TOOLBAR_WIDTH;

        let toggle = icon_button(
            "sidebar-toggle",
            if collapsed { "▤" } else { "◧" },
            &chrome,
            cx.listener(|this, _: &MouseDownEvent, window, cx| {
                this.toggle_sidebar(cx);
                this.focus_canvas(window, cx);
            }),
        );
        let more = if self.update_available() {
            icon_button_with_badge(
                "toolbar-more",
                "⋯",
                &chrome,
                cx.listener(|this, _: &MouseDownEvent, _window, cx| this.open_diagnostics(cx)),
            )
        } else {
            icon_button(
                "toolbar-more",
                "⋯",
                &chrome,
                cx.listener(|this, _: &MouseDownEvent, _window, cx| this.open_diagnostics(cx)),
            )
        };

        let mut tabs = div().flex().items_center().gap(px(2.)).flex_none();
        if let Some(workspace) = workspace.filter(|workspace| workspace.tabs.len() > 1) {
            for tab in &workspace.tabs {
                tabs = tabs.child(tab_segment(tab, &chrome, cx));
            }
        }

        let mut chat_switch = div().flex().items_center().gap(px(2.)).flex_none();
        if chat_available {
            chat_switch = chat_switch
                .child(mode_segment(
                    "view-tui", "TUI", !chat_on, compact, &chrome, cx,
                ))
                .child(mode_segment(
                    "view-chat",
                    "Chat",
                    chat_on,
                    compact,
                    &chrome,
                    cx,
                ));
        }

        let mut actions = div().flex().items_center().gap(px(4.)).flex_none();
        if can_split {
            actions = actions
                .child(icon_button(
                    "split-right",
                    "◫",
                    &chrome,
                    cx.listener(|this, _: &MouseDownEvent, window, cx| {
                        this.split_focused(SplitDirection::Vertical);
                        this.focus_canvas(window, cx);
                    }),
                ))
                .child(icon_button(
                    "split-down",
                    "⬓",
                    &chrome,
                    cx.listener(|this, _: &MouseDownEvent, window, cx| {
                        this.split_focused(SplitDirection::Horizontal);
                        this.focus_canvas(window, cx);
                    }),
                ));
        }
        if can_zoom {
            actions = actions.child(icon_button(
                "zoom-pane",
                "⤢",
                &chrome,
                cx.listener(|this, _: &MouseDownEvent, window, cx| {
                    this.zoom_focused();
                    this.focus_canvas(window, cx);
                }),
            ));
        }

        div()
            .flex()
            .items_center()
            .gap(px(if compact { 6. } else { 10. }))
            .h(px(layout::TOOLBAR_HEIGHT))
            .pl(px(layout::toolbar_inset(collapsed)))
            .pr(px(12.))
            .flex_none()
            .bg(tone(chrome.background))
            .border_b(px(1.))
            .border_color(tone(chrome.line))
            .child(toggle)
            .child(
                div()
                    .flex()
                    .items_baseline()
                    .gap(px(7.))
                    .min_w_0()
                    .flex_none()
                    .child(
                        div()
                            .max_w(px(if compact { 170. } else { 220. }))
                            .truncate()
                            .text_size(px(13.))
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .text_color(tone(chrome.foreground))
                            .child(SharedString::from(title)),
                    )
                    .children(branch.map(|branch| {
                        div()
                            .font(mono_font())
                            .text_size(px(10.5))
                            .text_color(tone(chrome.muted))
                            .child(SharedString::from(branch))
                    })),
            )
            .child(tabs)
            .child(chat_switch)
            .child(div().flex_1())
            .child(actions)
            .children(notice.map(|(text, color)| {
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .max_w(px(280.))
                    .min_w_0()
                    .child(dot(tone(color), 6.))
                    .child(
                        div()
                            .truncate()
                            .text_size(px(11.))
                            .text_color(tone(color))
                            .child(SharedString::from(text)),
                    )
            }))
            .children((!ready).then(|| {
                chip(
                    &connection.label(),
                    connection_tone(&connection, &chrome),
                    &chrome,
                )
            }))
            .children(sessions_available.then(|| {
                small_button(
                    "toolbar-sessions",
                    if compact { "⇄" } else { "Sessions" },
                    &chrome,
                    ButtonKind::Bordered,
                    cx.listener(|this, _: &MouseDownEvent, _window, cx| this.open_sessions(cx)),
                )
            }))
            .children(tools.then(|| {
                small_button(
                    "toolbar-devices",
                    if compact { "▣" } else { "Devices" },
                    &chrome,
                    ButtonKind::Bordered,
                    cx.listener(|this, _: &MouseDownEvent, _window, cx| this.open_devices(cx)),
                )
            }))
            .child(more)
            .into_any_element()
    }

    fn footer(&self, _cx: &mut Context<Self>) -> AnyElement {
        let chrome = self.chrome.clone();
        let connection = self.app.connection.clone();
        let pane = self.app.focused_pane().and_then(|id| {
            self.app
                .session
                .as_ref()
                .and_then(|session| session.pane(&id).cloned())
        });
        let cwd = pane
            .as_ref()
            .and_then(|pane| pane.cwd.clone())
            .unwrap_or_default();
        let agent = pane.as_ref().and_then(|pane| pane.agent.clone());
        let status = pane.as_ref().map(|pane| pane.status);

        div()
            .flex()
            .items_center()
            .gap(px(10.))
            .h(px(layout::FOOTER_HEIGHT))
            .px(px(16.))
            .flex_none()
            .bg(tone(chrome.background))
            .border_t(px(1.))
            .border_color(tone(chrome.line))
            .child(dot(tone(connection_tone(&connection, &chrome)), 7.))
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(tone(chrome.muted))
                    .child(connection.label()),
            )
            .children(agent.map(|agent| {
                div()
                    .text_size(px(11.))
                    .text_color(tone(chrome.secondary))
                    .child(SharedString::from(agent))
            }))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .font(mono_font())
                    .text_size(px(11.))
                    .text_color(tone(chrome.muted))
                    .child(SharedString::from(cwd)),
            )
            .children(status.map(|status| {
                div()
                    .text_size(px(11.))
                    .text_color(tone(chrome.secondary))
                    .child(super::theme::status_label(status))
            }))
            .children(
                (self.content_width() >= layout::FOOTER_HINTS_WIDTH).then(|| {
                    div()
                        .text_size(px(10.5))
                        .text_color(tone(chrome.line))
                        .child("⌘D split · ⌘⇧M chat · ⌘F find · ⌘⇧F filter")
                }),
            )
            .into_any_element()
    }
}

fn mode_segment(
    id: &'static str,
    label: &'static str,
    active: bool,
    compact: bool,
    chrome: &Chrome,
    cx: &mut Context<PairfobWindow>,
) -> AnyElement {
    div()
        .id(id)
        .flex()
        .items_center()
        .h(px(24.))
        .px(px(if compact { 7. } else { 9. }))
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
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(move |this, _: &MouseDownEvent, window, cx| {
                if !active {
                    this.toggle_chat(window, cx);
                }
            }),
        )
        .child(label)
        .into_any_element()
}

fn tab_segment(tab: &Tab, chrome: &Chrome, cx: &mut Context<PairfobWindow>) -> AnyElement {
    let id = tab.id.clone();
    let active = tab.focused;
    div()
        .id(gpui::ElementId::Name(SharedString::from(format!(
            "toolbar-tab-{}",
            tab.id
        ))))
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
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(move |this, _: &MouseDownEvent, window, cx| {
                this.focus_tab(id.clone());
                this.focus_canvas(window, cx);
            }),
        )
        .child(SharedString::from(tab.label.clone()))
        .into_any_element()
}

pub(crate) fn icon_button(
    id: &'static str,
    glyph: &'static str,
    chrome: &Chrome,
    on: impl Fn(&MouseDownEvent, &mut Window, &mut gpui::App) + 'static,
) -> AnyElement {
    div()
        .id(id)
        .flex()
        .items_center()
        .justify_center()
        .size(px(26.))
        .flex_none()
        .rounded(px(layout::RADIUS_CONTROL))
        .text_size(px(13.))
        .text_color(tone(chrome.secondary))
        .cursor_pointer()
        .hover(|style| style.bg(tone(chrome.raised)))
        .on_mouse_down(MouseButton::Left, on)
        .child(glyph)
        .into_any_element()
}

/// The same button with a small accent dot for an available update. The dot
/// adds no control and no width, so the compact toolbar keeps its layout.
pub(crate) fn icon_button_with_badge(
    id: &'static str,
    glyph: &'static str,
    chrome: &Chrome,
    on: impl Fn(&MouseDownEvent, &mut Window, &mut gpui::App) + 'static,
) -> AnyElement {
    div()
        .relative()
        .flex_none()
        .child(icon_button(id, glyph, chrome, on))
        .child(
            div()
                .absolute()
                .top(px(3.))
                .right(px(3.))
                .size(px(5.))
                .rounded(px(3.))
                .bg(tone(chrome.accent)),
        )
        .into_any_element()
}
