//! The chat column: transcript, plan, queue, the permission card, and the
//! composer. The transcript is a virtualized list, so a long session costs the
//! rows on screen and nothing else.

use std::rc::Rc;

use gpui::prelude::*;
use gpui::{
    div, list, px, AnyElement, Context, ElementId, ExternalPaths, FontWeight, MouseButton,
    MouseDownEvent, SharedString, Window,
};

use crate::chat::attach::PendingAttachment;
use crate::chat::wire::{ConfigOption, State};

use super::agent_marks;
use super::chat::{ChatMenu, ChatSession, MenuKind};
use super::chat_entries::{agent_status, entry_element, permission_block, plan_block, queue_block};
use super::controls::{dot, small_button, ButtonKind};
use super::layout;
use super::theme::{status_label, status_tone, tone, Chrome};
use super::window::PairfobWindow;

/// Below this the chat keeps only what still reads: the agent name and status,
/// a tighter message size, and no shortcut hint under the composer.
const COMPACT_CHAT_WIDTH: f32 = 430.;
/// Below this the transcript cannot hold a message; the pane says so instead.
const NARROW_CHAT_WIDTH: f32 = 320.;

impl PairfobWindow {
    pub(crate) fn chat_column(&mut self, cx: &mut Context<Self>) -> AnyElement {
        self.sync_chat_list();
        let chrome = self.chrome.clone();
        if self.chat.is_none() {
            return self.chat_placeholder(&chrome, cx);
        }
        if self.content_width() < NARROW_CHAT_WIDTH {
            return self.chat_narrow(&chrome);
        }
        self.chat_body(&chrome, cx)
    }

    fn chat_narrow(&self, chrome: &Chrome) -> AnyElement {
        div()
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(6.))
            .p(px(16.))
            .child(
                div()
                    .text_size(px(11.5))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(tone(chrome.secondary))
                    .child("Chat needs a wider pane"),
            )
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(tone(chrome.muted))
                    .child("Zoom this pane with ⌘⇧↵"),
            )
            .into_any_element()
    }

    fn chat_placeholder(&self, chrome: &Chrome, cx: &mut Context<Self>) -> AnyElement {
        let (heading, note) = match &self.chat_error {
            Some(error) => ("Chat unavailable", error.clone()),
            None => (
                "Opening the chat",
                "The chat process is local to this pane and sends its transcript over a private socket.".to_owned(),
            ),
        };
        let retry = small_button(
            "chat-retry",
            "Try again",
            chrome,
            ButtonKind::Bordered,
            cx.listener(|this, _: &MouseDownEvent, window, cx| this.retry_chat(window, cx)),
        );
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
                    .max_w(px(420.))
                    .p(px(24.))
                    .rounded(px(layout::RADIUS_CARD))
                    .bg(tone(chrome.card))
                    .border(px(1.))
                    .border_color(tone(chrome.line))
                    .child(
                        div()
                            .text_size(px(15.))
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
                            .child(SharedString::from(note)),
                    )
                    .children(
                        self.chat_error
                            .is_some()
                            .then(|| div().flex().pt(px(2.)).child(retry)),
                    ),
            )
            .into_any_element()
    }

    fn chat_body(&self, chrome: &Chrome, cx: &mut Context<Self>) -> AnyElement {
        let Some(chat) = self.chat.as_ref() else {
            return div().into_any_element();
        };
        let state = Rc::clone(&chat.state);
        let chrome_for_rows = chrome.clone();
        // The list measures itself from its rows; without an explicit size the
        // flex column hands it a zero-height box and no row is ever painted.
        let transcript = list(chat.list.clone(), move |index, _window, _cx| {
            entry_element(index, &state, &chrome_for_rows)
        })
        .w_full()
        .h_full();

        let compact = self.content_width() < COMPACT_CHAT_WIDTH;
        let snapshot = chat.state.borrow();
        let state = &snapshot.state;
        let agent_name = if state.agent.is_empty() {
            if state.title.is_empty() {
                "Chat".to_owned()
            } else {
                state.title.clone()
            }
        } else {
            capitalize(&state.agent)
        };
        let model = model_option(state)
            .map(|option| {
                option
                    .choices
                    .iter()
                    .find(|choice| choice.value == option.current_value)
                    .map(|choice| choice.name.clone())
                    .unwrap_or_else(|| option.current_value.clone())
            })
            .filter(|name| !name.is_empty() && !compact);
        let agent_mark = (!state.agent.trim().is_empty())
            .then(|| agent_marks::avatar(&state.agent, false, None, chrome));
        let header = div()
            .flex()
            .items_center()
            .gap(px(7.))
            .h(px(28.))
            .px(px(18.))
            .flex_none()
            .border_b(px(1.))
            .border_color(tone(chrome.line_soft))
            .children(agent_mark)
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_size(px(12.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(tone(chrome.foreground))
                    .child(SharedString::from(agent_name)),
            )
            .children(model.map(|name| {
                div()
                    .h(px(18.))
                    .px(px(7.))
                    .flex()
                    .items_center()
                    .rounded(px(5.))
                    .border(px(1.))
                    .border_color(tone(chrome.line))
                    .text_size(px(10.))
                    .text_color(tone(chrome.muted))
                    .whitespace_nowrap()
                    .child(SharedString::from(name))
            }))
            .child(div().flex_1())
            .child(dot(
                tone(status_tone(agent_status(&state.status), chrome)),
                6.,
            ))
            .children((!compact).then(|| {
                div()
                    .text_size(px(10.5))
                    .text_color(tone(chrome.secondary))
                    .child(SharedString::from(
                        status_label(agent_status(&state.status)).to_owned(),
                    ))
            }));

        let mut column = div()
            .id("chat-column")
            .relative()
            .flex()
            .flex_col()
            .size_full()
            .min_h_0()
            .on_drop(cx.listener(|this, paths: &ExternalPaths, _window, cx| {
                this.chat_attach_files(paths.paths().to_vec(), cx);
            }))
            .child(header)
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .pt(px(10.))
                    .px(px(6.))
                    .child(transcript),
            )
            .children(plan_block(&state.plan, chrome))
            .children(queue_block(&state.queue, chrome, cx))
            .children(permission_block(state.permission.as_ref(), chrome, cx))
            .children(chat_error_line(chat, &state.error, chrome))
            .children(attachment_row(&chat.attachments, chrome, cx))
            .child(self.composer(chat, chrome, cx));

        if let Some(menu) = chat.menu {
            column = column.child(self.chat_menu(menu, chrome, cx));
        }
        column.into_any_element()
    }

    fn composer(&self, chat: &ChatSession, chrome: &Chrome, cx: &mut Context<Self>) -> AnyElement {
        let state = chat.state.borrow();
        let status = state.state.status.as_str();
        let working = status == "working";
        let blocked = status == "blocked";
        let text = if self.composer.is_empty() && self.marked.is_empty() {
            None
        } else {
            Some(format!("{}{}", self.composer, self.marked))
        };
        let mode = state
            .state
            .modes
            .iter()
            .find(|mode| mode.id == state.state.mode)
            .map(|mode| mode.name.clone())
            .unwrap_or_else(|| "Mode".to_owned());
        let model = model_option(&state.state).map(|option| {
            (
                option.name.clone(),
                option
                    .choices
                    .iter()
                    .find(|choice| choice.value == option.current_value)
                    .map(|choice| choice.name.clone())
                    .unwrap_or_else(|| option.current_value.clone()),
            )
        });
        let usage = state.state.usage.as_ref().map(|usage| {
            let percent = if usage.size > 0 {
                (usage.used as f64 / usage.size as f64 * 100.).round() as i64
            } else {
                0
            };
            format!("{percent}% · ${:.2}", usage.cost_usd)
        });
        let auto = state.state.auto_accept;
        let empty = text.is_none() && chat.attachments.is_empty();

        let attach = if self.chat_target().is_some() {
            small_button(
                "chat-attach",
                "📎",
                chrome,
                ButtonKind::Quiet,
                cx.listener(|this, _: &MouseDownEvent, _window, cx| this.chat_pick_attachments(cx)),
            )
            .into_any_element()
        } else {
            div()
                .flex()
                .items_center()
                .justify_center()
                .h(px(26.))
                .px(px(8.))
                .flex_none()
                .text_size(px(13.))
                .text_color(tone(chrome.muted))
                .child("📎")
                .into_any_element()
        };

        let send = if working {
            small_button(
                "chat-stop",
                "Stop",
                chrome,
                ButtonKind::Bordered,
                cx.listener(|this, _: &MouseDownEvent, _window, cx| this.cancel_chat_turn(cx)),
            )
            .into_any_element()
        } else {
            small_button(
                "chat-send",
                "Send",
                chrome,
                ButtonKind::Primary,
                cx.listener(|this, _: &MouseDownEvent, _window, cx| this.send_chat(cx)),
            )
            .into_any_element()
        };

        let field = div()
            .flex()
            .flex_col()
            .justify_center()
            .min_h(px(54.))
            .px(px(10.))
            .py(px(8.))
            .cursor_text()
            .text_size(px(13.))
            .line_height(px(20.))
            .whitespace_normal()
            .child(match text {
                Some(text) => div()
                    .text_color(tone(chrome.foreground))
                    .child(SharedString::from(text)),
                None => {
                    let prompt = if blocked {
                        "Answer the request to continue".to_owned()
                    } else if state.state.agent.is_empty() {
                        "Message the agent…".to_owned()
                    } else {
                        format!("Message {}…", capitalize(&state.state.agent))
                    };
                    div()
                        .text_color(tone(chrome.muted))
                        .child(SharedString::from(prompt))
                }
            });

        let mut row = div()
            .flex()
            .items_center()
            .gap(px(6.))
            .pt(px(8.))
            .child(menu_chip(
                "chat-mode",
                &mode,
                chrome,
                cx.listener(|this, _: &MouseDownEvent, _window, cx| {
                    this.open_chat_menu(MenuKind::Modes, cx)
                }),
            ));
        if let Some((name, value)) = model {
            row = row.child(menu_chip(
                "chat-model",
                &format!("{name}: {value}"),
                chrome,
                cx.listener(|this, _: &MouseDownEvent, _window, cx| {
                    this.open_chat_menu(MenuKind::Option(0), cx)
                }),
            ));
        }
        row = row
            .child(menu_chip(
                "chat-auto",
                if auto {
                    "Auto accept on"
                } else {
                    "Auto accept"
                },
                chrome,
                cx.listener(move |this, _: &MouseDownEvent, _window, cx| {
                    this.set_chat_auto_accept(!auto, cx)
                }),
            ))
            .child(div().flex_1())
            .children(usage.map(|usage| {
                div()
                    .text_size(px(10.5))
                    .text_color(tone(chrome.muted))
                    .child(SharedString::from(usage))
            }))
            .child(attach)
            .child(if empty && !working {
                div()
                    .h(px(26.))
                    .px(px(10.))
                    .flex()
                    .items_center()
                    .text_size(px(12.))
                    .text_color(tone(chrome.muted))
                    .child("Send")
                    .into_any_element()
            } else {
                send
            });

        div()
            .flex_none()
            .px(px(16.))
            .pb(px(10.))
            .pt(px(4.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .rounded(px(layout::RADIUS_CARD))
                    .bg(tone(chrome.raised))
                    .border(px(1.))
                    .border_color(tone(chrome.line))
                    .px(px(6.))
                    .py(px(4.))
                    .child(field)
                    .child(row),
            )
            .children((self.content_width() >= COMPACT_CHAT_WIDTH).then(|| {
                div()
                    .flex()
                    .gap(px(12.))
                    .pt(px(6.))
                    .px(px(4.))
                    .text_size(px(10.))
                    .text_color(tone(chrome.muted))
                    .child("↵ send")
                    .child("⇧↵ newline")
            }))
            .into_any_element()
    }

    fn chat_menu(&self, menu: ChatMenu, chrome: &Chrome, cx: &mut Context<Self>) -> AnyElement {
        let Some(chat) = self.chat.as_ref() else {
            return div().into_any_element();
        };
        let state = chat.state.borrow();
        let mut card = div()
            .id("chat-menu")
            .absolute()
            .bottom(px(112.))
            .left(px(16.))
            .w(px(300.))
            .flex()
            .flex_col()
            .gap(px(2.))
            .p(px(6.))
            .rounded(px(layout::RADIUS_CARD))
            .bg(tone(chrome.card))
            .border(px(1.))
            .border_color(tone(chrome.line));
        match menu.kind {
            MenuKind::Modes => {
                for mode in &state.state.modes {
                    let id = mode.id.clone();
                    card = card.child(menu_row(
                        &format!("chat-mode-{}", mode.id),
                        &mode.name,
                        mode.id == state.state.mode,
                        chrome,
                        cx.listener(move |this, _: &MouseDownEvent, _window, cx| {
                            this.choose_chat_mode(&id, cx)
                        }),
                    ));
                }
            }
            MenuKind::Option(index) => {
                if let Some(option) = state.state.options.get(index) {
                    for choice in &option.choices {
                        let option_id = option.id.clone();
                        let value = choice.value.clone();
                        card = card.child(menu_row(
                            &format!("chat-choice-{}-{}", option.id, choice.value),
                            &choice.name,
                            choice.value == option.current_value,
                            chrome,
                            cx.listener(move |this, _: &MouseDownEvent, _window, cx| {
                                this.choose_chat_option(&option_id, &value, cx)
                            }),
                        ));
                    }
                }
            }
        }
        card.into_any_element()
    }
}

fn chat_error_line(chat: &ChatSession, adapter_error: &str, chrome: &Chrome) -> Option<AnyElement> {
    let message = chat
        .error
        .as_deref()
        .or(chat.attach_error.as_deref())
        .or(Some(adapter_error))?;
    if message.trim().is_empty() {
        return None;
    }
    Some(
        div()
            .mx(px(16.))
            .mb(px(6.))
            .flex_none()
            .text_size(px(11.))
            .text_color(tone(chrome.danger))
            .whitespace_normal()
            .child(SharedString::from(message.to_owned()))
            .into_any_element(),
    )
}

/// One chip per pending image, above the composer. The row shares the chat
/// column with the transcript, so it never takes rows from the terminal.
fn attachment_row(
    attachments: &[PendingAttachment],
    chrome: &Chrome,
    cx: &mut Context<PairfobWindow>,
) -> Option<AnyElement> {
    if attachments.is_empty() {
        return None;
    }
    let mut row = div()
        .flex()
        .flex_wrap()
        .gap(px(6.))
        .mx(px(16.))
        .mb(px(6.))
        .flex_none();
    for (index, attachment) in attachments.iter().enumerate() {
        row = row.child(
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .pl(px(8.))
                .pr(px(4.))
                .py(px(3.))
                .rounded(px(layout::RADIUS_CONTROL))
                .bg(tone(chrome.line_soft))
                .text_size(px(10.5))
                .text_color(tone(chrome.secondary))
                .child(
                    div()
                        .min_w_0()
                        .max_w(px(180.))
                        .truncate()
                        .child(SharedString::from(attachment.name.clone())),
                )
                .child(div().text_color(tone(chrome.muted)).child("·"))
                .child(
                    div()
                        .whitespace_nowrap()
                        .child(SharedString::from(attachment_size(attachment.size()))),
                )
                .child(
                    div()
                        .id(ElementId::Name(SharedString::from(format!(
                            "chat-attachment-{index}"
                        ))))
                        .px(px(4.))
                        .rounded(px(4.))
                        .text_color(tone(chrome.muted))
                        .cursor_pointer()
                        .hover(|style| style.bg(tone(chrome.hover)))
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(move |this, _: &MouseDownEvent, _window, cx| {
                                this.chat_remove_attachment(index, cx)
                            }),
                        )
                        .child("×"),
                ),
        );
    }
    Some(row.into_any_element())
}

fn attachment_size(bytes: usize) -> String {
    const KIB: f64 = 1024.;
    let size = bytes as f64;
    if bytes < 1024 {
        format!("{bytes} B")
    } else if size < KIB * KIB {
        format!("{:.0} KiB", size / KIB)
    } else {
        format!("{:.1} MiB", size / (KIB * KIB))
    }
}

/// The session's model option, whichever position the adapter reports it in.
fn model_option(state: &State) -> Option<&ConfigOption> {
    state
        .options
        .iter()
        .find(|option| option.category == "model")
        .or_else(|| state.options.first())
}

fn capitalize(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn menu_chip(
    id: &'static str,
    label: &str,
    chrome: &Chrome,
    on: impl Fn(&MouseDownEvent, &mut Window, &mut gpui::App) + 'static,
) -> AnyElement {
    div()
        .id(id)
        .flex()
        .items_center()
        .h(px(24.))
        .px(px(8.))
        .flex_none()
        .rounded(px(layout::RADIUS_CONTROL))
        .text_size(px(10.5))
        .text_color(tone(chrome.secondary))
        .cursor_pointer()
        .hover(|style| style.bg(tone(chrome.line_soft)))
        .on_mouse_down(MouseButton::Left, on)
        .child(SharedString::from(label.to_owned()))
        .into_any_element()
}

fn menu_row(
    id: &str,
    label: &str,
    active: bool,
    chrome: &Chrome,
    on: impl Fn(&MouseDownEvent, &mut Window, &mut gpui::App) + 'static,
) -> AnyElement {
    div()
        .id(ElementId::Name(SharedString::from(id.to_owned())))
        .flex()
        .items_center()
        .gap(px(7.))
        .h(px(28.))
        .px(px(8.))
        .rounded(px(layout::RADIUS_CONTROL))
        .text_size(px(12.))
        .text_color(tone(if active {
            chrome.accent
        } else {
            chrome.foreground
        }))
        .cursor_pointer()
        .hover(|style| style.bg(tone(chrome.hover)))
        .on_mouse_down(MouseButton::Left, on)
        .child(div().w(px(8.)).child(if active { "✓" } else { "" }))
        .child(SharedString::from(label.to_owned()))
        .into_any_element()
}
