//! The rows of a chat transcript: messages, thoughts, notices, tool cards,
//! and the plan, queue and permission cards that sit between them. Pure
//! element builders; the column that virtualizes them lives in `chat_view`.

use std::cell::RefCell;
use std::rc::Rc;

use gpui::prelude::*;
use gpui::{
    div, px, AnyElement, Context, ElementId, FontWeight, MouseButton, MouseDownEvent, SharedString,
    Window,
};

use crate::chat::wire::{Entry, Permission, PlanItem, QueuedPrompt};
use crate::chat::ChatState;

use super::controls::dot;
use super::layout;
use super::theme::{mono_font, tone, ui_font, Chrome};
use super::window::PairfobWindow;

/// Long tool output is shown as a preview; the pane's TUI keeps the whole
/// thing, and a view is not a log file.
pub(crate) const TOOL_PREVIEW: usize = 2_400;
pub(crate) const PLAN_ROWS: usize = 4;

pub(crate) fn agent_status(status: &str) -> crate::model::AgentStatus {
    use crate::model::AgentStatus;
    match status {
        "working" => AgentStatus::Working,
        "blocked" => AgentStatus::Blocked,
        "idle" => AgentStatus::Idle,
        "exited" => AgentStatus::Done,
        _ => AgentStatus::Unknown,
    }
}

pub(crate) fn entry_element(
    index: usize,
    state: &Rc<RefCell<ChatState>>,
    chrome: &Chrome,
) -> AnyElement {
    let snapshot = state.borrow();
    let Some(entry) = snapshot.state.entries.get(index) else {
        return div().into_any_element();
    };
    let row = match entry.kind.as_str() {
        "user" => user_entry(entry, chrome),
        "thought" => thought_entry(entry, chrome),
        "tool" => tool_entry(entry, chrome),
        "notice" => notice_entry(entry, chrome),
        _ => agent_entry(entry, chrome),
    };
    div()
        .px(px(14.))
        .py(px(5.))
        .w_full()
        .min_w_0()
        .child(row)
        .into_any_element()
}

fn user_entry(entry: &Entry, chrome: &Chrome) -> AnyElement {
    div()
        .max_w(px(680.))
        .px(px(10.))
        .py(px(8.))
        .rounded(px(8.))
        .border(px(1.))
        .border_color(tone(chrome.line_soft))
        .bg(tone(chrome.raised))
        .text_size(px(12.5))
        .line_height(px(20.))
        .text_color(tone(chrome.foreground))
        .whitespace_normal()
        .child(SharedString::from(entry.text.clone()))
        .into_any_element()
}

fn agent_entry(entry: &Entry, chrome: &Chrome) -> AnyElement {
    let mut text = entry.text.clone();
    if entry.streaming {
        text.push('▌');
    }
    div()
        .max_w(px(720.))
        .text_size(px(13.))
        .line_height(px(21.))
        .text_color(tone(chrome.foreground))
        .whitespace_normal()
        .child(SharedString::from(text))
        .into_any_element()
}

fn thought_entry(entry: &Entry, chrome: &Chrome) -> AnyElement {
    let text = clip(&entry.text, TOOL_PREVIEW);
    let mut text = text.to_owned();
    if entry.streaming {
        text.push('▌');
    }
    div()
        .max_w(px(680.))
        .text_size(px(11.5))
        .line_height(px(18.))
        .font(ui_font())
        .italic()
        .text_color(tone(chrome.muted))
        .whitespace_normal()
        .child(SharedString::from(text))
        .into_any_element()
}

fn notice_entry(entry: &Entry, chrome: &Chrome) -> AnyElement {
    let color = match entry.level.as_str() {
        "error" => chrome.danger,
        "warning" => chrome.warning,
        _ => chrome.muted,
    };
    div()
        .flex()
        .items_center()
        .gap(px(6.))
        .text_size(px(11.5))
        .text_color(tone(color))
        .child(dot(tone(color), 5.))
        .child(SharedString::from(entry.text.clone()))
        .into_any_element()
}

fn tool_entry(entry: &Entry, chrome: &Chrome) -> AnyElement {
    let Some(tool) = entry.tool.as_ref() else {
        return agent_entry(entry, chrome);
    };
    let status = match tool.status.as_str() {
        "completed" => chrome.success,
        "failed" | "error" => chrome.danger,
        "in_progress" | "running" => chrome.accent,
        _ => chrome.muted,
    };
    let mut card = div()
        .max_w(px(720.))
        .flex()
        .flex_col()
        .gap(px(4.))
        .px(px(10.))
        .py(px(7.))
        .rounded(px(8.))
        .bg(tone(chrome.line_soft))
        .border(px(1.))
        .border_color(tone(chrome.line))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(7.))
                .child(dot(tone(status), 6.))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_size(px(11.5))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(tone(chrome.secondary))
                        .child(SharedString::from(tool.title.clone())),
                )
                .children((!tool.kind.is_empty()).then(|| {
                    div()
                        .text_size(px(10.))
                        .text_color(tone(chrome.muted))
                        .child(SharedString::from(tool.kind.clone()))
                })),
        );
    for block in tool.content.iter().take(3) {
        let body = match block.kind.as_str() {
            "diff" => {
                let path = if block.path.is_empty() {
                    String::new()
                } else {
                    format!("{}\n", block.path)
                };
                format!(
                    "{path}- {}\n+ {}",
                    clip(&block.old, TOOL_PREVIEW),
                    clip(&block.new, TOOL_PREVIEW)
                )
            }
            _ => clip(&block.text, TOOL_PREVIEW).to_owned(),
        };
        if body.trim().is_empty() {
            continue;
        }
        card = card.child(
            div()
                .font(mono_font())
                .text_size(px(10.5))
                .line_height(px(16.))
                .text_color(tone(chrome.muted))
                .whitespace_normal()
                .child(SharedString::from(body)),
        );
    }
    card.into_any_element()
}

pub(crate) fn plan_block(plan: &[PlanItem], chrome: &Chrome) -> Option<AnyElement> {
    if plan.is_empty() {
        return None;
    }
    let mut block = div()
        .flex()
        .flex_col()
        .gap(px(2.))
        .mx(px(16.))
        .mb(px(6.))
        .px(px(10.))
        .py(px(7.))
        .flex_none()
        .rounded(px(layout::RADIUS_CONTROL))
        .bg(tone(chrome.line_soft));
    for item in plan.iter().take(PLAN_ROWS) {
        let (mark, color) = match item.status.as_str() {
            "completed" => ("✓", chrome.success),
            "in_progress" => ("◐", chrome.accent),
            _ => ("○", chrome.muted),
        };
        block = block.child(
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .text_size(px(11.))
                .text_color(tone(if item.status == "completed" {
                    chrome.muted
                } else {
                    chrome.secondary
                }))
                .child(div().text_color(tone(color)).child(mark))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .child(SharedString::from(item.content.clone())),
                ),
        );
    }
    if plan.len() > PLAN_ROWS {
        block = block.child(
            div()
                .text_size(px(10.))
                .text_color(tone(chrome.muted))
                .child(SharedString::from(format!(
                    "{} more steps",
                    plan.len() - PLAN_ROWS
                ))),
        );
    }
    Some(block.into_any_element())
}

pub(crate) fn queue_block(
    queue: &[QueuedPrompt],
    chrome: &Chrome,
    cx: &mut Context<PairfobWindow>,
) -> Option<AnyElement> {
    if queue.is_empty() {
        return None;
    }
    let mut block = div()
        .flex()
        .flex_col()
        .gap(px(2.))
        .mx(px(16.))
        .mb(px(6.))
        .flex_none();
    for prompt in queue {
        let id = prompt.id.clone();
        block = block.child(
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .px(px(8.))
                .py(px(4.))
                .rounded(px(layout::RADIUS_CONTROL))
                .bg(tone(chrome.line_soft))
                .text_size(px(11.))
                .text_color(tone(chrome.secondary))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .child(SharedString::from(prompt.text.clone())),
                )
                .child(
                    div()
                        .id(ElementId::Name(SharedString::from(format!(
                            "queue-remove-{id}"
                        ))))
                        .px(px(3.))
                        .text_color(tone(chrome.muted))
                        .cursor_pointer()
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(move |this, _: &MouseDownEvent, _window, cx| {
                                this.unqueue_prompt(&id, cx)
                            }),
                        )
                        .child("×"),
                ),
        );
    }
    Some(block.into_any_element())
}

pub(crate) fn permission_block(
    permission: Option<&Permission>,
    chrome: &Chrome,
    cx: &mut Context<PairfobWindow>,
) -> Option<AnyElement> {
    let permission = permission?;
    let request = permission.id.clone();
    let mut card = div()
        .flex()
        .flex_col()
        .gap(px(8.))
        .mx(px(16.))
        .mb(px(8.))
        .p(px(12.))
        .flex_none()
        .rounded(px(layout::RADIUS_CARD))
        .bg(tone(chrome.accent_soft()))
        .border(px(1.))
        .border_color(tone(chrome.accent));
    card = card.child(
        div()
            .text_size(px(12.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(tone(chrome.foreground))
            .whitespace_normal()
            .child(SharedString::from(if permission.title.is_empty() {
                "The agent is asking for permission".to_owned()
            } else {
                permission.title.clone()
            })),
    );
    let mut options = div().flex().items_center().gap(px(6.)).flex_wrap();
    for option in &permission.options {
        let request = request.clone();
        let id = option.id.clone();
        options = options.child(permission_button(
            format!("permission-{}-{}", permission.id, option.id),
            option.name.clone(),
            option.kind.starts_with("allow"),
            chrome,
            cx.listener(move |this, _: &MouseDownEvent, _window, cx| {
                this.answer_permission(&request, &id, cx)
            }),
        ));
    }
    Some(card.child(options).into_any_element())
}

/// Permission option ids come from the agent, so this button takes a runtime
/// element id rather than the shared helper's `&'static str`.
fn permission_button(
    id: String,
    label: String,
    primary: bool,
    chrome: &Chrome,
    on: impl Fn(&MouseDownEvent, &mut Window, &mut gpui::App) + 'static,
) -> AnyElement {
    let (background, foreground) = if primary {
        (Some(chrome.accent), chrome.on_accent)
    } else {
        (None, chrome.foreground)
    };
    let mut button = div()
        .id(ElementId::Name(SharedString::from(id)))
        .flex()
        .items_center()
        .justify_center()
        .h(px(26.))
        .px(px(10.))
        .flex_none()
        .rounded(px(layout::RADIUS_CONTROL))
        .text_size(px(12.))
        .text_color(tone(foreground))
        .cursor_pointer()
        .hover(|style| style.bg(tone(chrome.hover)))
        .on_mouse_down(MouseButton::Left, on)
        .child(SharedString::from(label));
    if let Some(background) = background {
        button = button.bg(tone(background));
    } else {
        button = button.border(px(1.)).border_color(tone(chrome.line));
    }
    button.into_any_element()
}

fn clip(text: &str, limit: usize) -> &str {
    if text.len() <= limit {
        return text;
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipping_never_splits_a_character() {
        assert_eq!(clip("short", 10), "short");
        assert_eq!(clip("héllo", 2), "h");
        assert_eq!(clip("héllo", 100), "héllo");
    }

    #[test]
    fn adapter_statuses_map_onto_the_pane_vocabulary() {
        assert_eq!(agent_status("working"), crate::model::AgentStatus::Working);
        assert_eq!(agent_status("blocked"), crate::model::AgentStatus::Blocked);
        assert_eq!(agent_status("exited"), crate::model::AgentStatus::Done);
        assert_eq!(agent_status("what"), crate::model::AgentStatus::Unknown);
    }
}
