//! The session list: the title band the traffic lights sit in, a filter, then
//! workspaces and their panes. A workspace with one pane is a single row; a
//! larger one gets a group row and indented pane rows with tab chips.

use gpui::prelude::*;
use gpui::{
    div, px, AnyElement, Context, ElementId, MouseButton, MouseDownEvent, SharedString, Window,
};

use crate::model::{AgentStatus, Pane, PaneId, Session, Workspace};

use super::agent_marks;
use super::controls::dot;
use super::layout;
use super::theme::{connection_tone, status_tone, tone, Chrome};
use super::view::icon_button;
use super::window::PairfobWindow;

impl PairfobWindow {
    pub(crate) fn sidebar(&mut self, _window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let width = layout::sidebar_width(self.sidebar_width, self.sidebar_collapsed);
        if width == 0. {
            return div().into_any_element();
        }
        let chrome = self.chrome.clone();
        let connection = self.app.connection.clone();
        let session = self.app.session.clone();
        let focused = self.app.focused_pane();
        let filter = if self.filter_active {
            format!("{}{}", self.filter, self.marked)
        } else {
            self.filter.clone()
        };
        let filter_active = self.filter_active;

        let top = div()
            .flex()
            .items_center()
            .h(px(layout::TITLEBAR_HEIGHT))
            .pl(px(84.))
            .pr(px(14.))
            .flex_none()
            .on_mouse_down(MouseButton::Left, |event, window, _| {
                if event.click_count == 2 {
                    window.titlebar_double_click()
                } else {
                    window.start_window_move()
                }
            })
            .child(
                div()
                    .text_size(px(13.))
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_color(tone(chrome.foreground))
                    .child("Pairfob"),
            )
            .child(div().flex_1())
            .child(icon_button(
                "appearance-toggle",
                "◐",
                &chrome,
                cx.listener(|this, _: &MouseDownEvent, window, cx| {
                    cx.stop_propagation();
                    this.toggle_appearance(window, cx);
                }),
            ))
            .child(div().w(px(8.)).flex_none())
            .child(dot(tone(connection_tone(&connection, &chrome)), 7.));

        let filter_row = filter_bar(&filter, filter_active, &chrome, cx);

        let mut tree = div()
            .id("session-tree")
            .flex()
            .flex_col()
            .gap(px(1.))
            .px(px(8.))
            .pb(px(8.))
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&self.sidebar_scroll);
        match session.as_ref().filter(|session| !session.is_empty()) {
            Some(session) => {
                tree =
                    tree.child(self.session_tree(session, focused.as_ref(), &filter, &chrome, cx));
            }
            None => {
                tree = tree.child(empty_state(&chrome));
            }
        }

        let handle = div()
            .id("sidebar-resize")
            .absolute()
            .top(px(0.))
            .right(px(0.))
            .bottom(px(0.))
            .w(px(5.))
            .cursor_ew_resize()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &MouseDownEvent, _window, cx| {
                    this.sidebar_drag = Some((f32::from(event.position.x), this.sidebar_width));
                    cx.notify();
                }),
            );

        div()
            .relative()
            .flex()
            .flex_col()
            .flex_none()
            .w(px(width))
            .h_full()
            .bg(tone(chrome.sidebar))
            .border_r(px(1.))
            .border_color(tone(chrome.line))
            .child(top)
            .child(filter_row)
            .child(tree)
            .child(handle)
            .into_any_element()
    }

    fn session_tree(
        &self,
        session: &Session,
        focused: Option<&PaneId>,
        filter: &str,
        chrome: &Chrome,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut column = div().flex().flex_col().gap(px(1.));
        let mut any = false;
        for workspace in &session.workspaces {
            let rows: Vec<(usize, &crate::model::Tab, &Pane)> = workspace
                .tabs
                .iter()
                .flat_map(|tab| {
                    tab.panes
                        .iter()
                        .enumerate()
                        .map(move |(index, pane)| (index, tab, pane))
                })
                .filter(|(index, tab, pane)| {
                    layout::pane_matches(pane, &workspace.label, &tab.label, filter, *index)
                })
                .collect();
            if rows.is_empty() {
                continue;
            }
            any = true;
            let single = rows.len() == 1 && workspace.tabs.len() == 1;
            if single {
                let (index, _, pane) = rows[0];
                column = column.child(self.pane_row(
                    pane,
                    index,
                    &workspace.label,
                    None,
                    true,
                    focused,
                    chrome,
                    cx,
                ));
                continue;
            }
            column = column.child(self.group_row(workspace, chrome, cx));
            for (index, tab, pane) in rows {
                let chip = (workspace.tabs.len() > 1).then(|| tab_chip(tab, chrome));
                column = column.child(self.pane_row(
                    pane,
                    index,
                    &workspace.label,
                    chip,
                    false,
                    focused,
                    chrome,
                    cx,
                ));
            }
            column = column.child(div().h(px(6.)).flex_none());
        }
        if !any && filter.trim().is_empty() {
            column = column.child(empty_state(chrome));
        } else if !any {
            column = column.child(nothing_matches(chrome));
        }
        column.into_any_element()
    }

    fn group_row(
        &self,
        workspace: &Workspace,
        chrome: &Chrome,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let target = layout::workspace_target(workspace);
        let label = workspace.label.clone();
        let note = workspace
            .branch
            .clone()
            .filter(|branch| !branch.trim().is_empty())
            .or_else(|| {
                let count = workspace.pane_count();
                (count > 1).then(|| format!("{count}"))
            });
        let hover = tone(chrome.hover);
        let selected = tone(chrome.accent_soft());

        let mut row = div()
            .id(ElementId::Name(SharedString::from(format!(
                "workspace-{}",
                workspace.id
            ))))
            .flex()
            .items_center()
            .gap(px(7.))
            .h(px(layout::GROUP_ROW))
            .pl(px(layout::GROUP_INSET))
            .pr(px(8.))
            .rounded(px(layout::RADIUS_ROW))
            .cursor_pointer()
            .when(workspace.focused, |row| row.bg(selected))
            .hover(move |style| style.bg(hover))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(
                    move |this, _: &MouseDownEvent, window, cx| match target.clone() {
                        Some(pane) => this.focus_pane(pane, window, cx),
                        None => this.focus_canvas(window, cx),
                    },
                ),
            )
            .child(leading_slot(Some(status_tone(workspace.status, chrome))))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(12.5))
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_color(tone(chrome.foreground))
                    .child(label),
            );
        if let Some(note) = note {
            row = row.child(
                div()
                    .flex_none()
                    .text_size(px(10.5))
                    .text_color(tone(chrome.muted))
                    .child(note),
            );
        }
        row.into_any_element()
    }

    #[allow(clippy::too_many_arguments)]
    fn pane_row(
        &self,
        pane: &Pane,
        index: usize,
        workspace: &str,
        chip: Option<AnyElement>,
        workspace_row: bool,
        focused: Option<&PaneId>,
        chrome: &Chrome,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let is_focused = focused.map_or(pane.focused, |id| id == &pane.id);
        let id = pane.id.clone();
        let hover = tone(chrome.hover);
        let selected = tone(chrome.selected);
        let foreground = tone(if is_focused {
            chrome.on_accent
        } else {
            chrome.secondary
        });
        let label = if workspace_row {
            workspace.to_owned()
        } else {
            layout::pane_label(pane, index)
        };

        let mut row = div()
            .id(ElementId::Name(SharedString::from(format!(
                "pane-{}",
                pane.id
            ))))
            .flex()
            .items_center()
            .gap(px(7.))
            .h(px(if workspace_row {
                layout::GROUP_ROW
            } else {
                layout::PANE_ROW
            }))
            .pl(px(if workspace_row {
                layout::GROUP_INSET
            } else {
                layout::PANE_INSET
            }))
            .pr(px(8.))
            .rounded(px(layout::RADIUS_ROW))
            .cursor_pointer()
            .when(is_focused, |row| row.bg(selected))
            .hover(move |style| style.bg(hover))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, _: &MouseDownEvent, window, cx| {
                    this.focus_pane(id.clone(), window, cx)
                }),
            );
        let agent = pane
            .agent
            .as_deref()
            .map(str::trim)
            .filter(|agent| !agent.is_empty());
        let status = pane_dot(pane.status, is_focused, chrome);
        row = row.child(match agent {
            Some(agent) => agent_marks::avatar(agent, is_focused, status, chrome),
            None => leading_slot(status),
        });
        row = row.child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(px(12.5))
                .when(workspace_row, |text| {
                    text.font_weight(gpui::FontWeight::SEMIBOLD)
                })
                .text_color(foreground)
                .child(label),
        );
        if let Some(chip) = chip {
            row = row.child(chip);
        }
        row.into_any_element()
    }
}

fn filter_bar(
    filter: &str,
    active: bool,
    chrome: &Chrome,
    cx: &mut Context<PairfobWindow>,
) -> AnyElement {
    let text = if filter.is_empty() {
        "Filter panes".to_owned()
    } else {
        filter.to_owned()
    };
    let color = if filter.is_empty() {
        chrome.muted
    } else {
        chrome.foreground
    };
    div()
        .id("filter-bar")
        .flex()
        .items_center()
        .gap(px(6.))
        .h(px(layout::FILTER_HEIGHT))
        .mx(px(8.))
        .mb(px(4.))
        .px(px(8.))
        .flex_none()
        .rounded(px(layout::RADIUS_CONTROL))
        .bg(tone(if active {
            chrome.raised
        } else {
            chrome.line_soft
        }))
        .cursor_text()
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(|this, _: &MouseDownEvent, window, cx| {
                this.filter_active = true;
                this.focus_canvas(window, cx);
                cx.notify();
            }),
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
                .text_size(px(11.5))
                .text_color(tone(color))
                .child(SharedString::from(text)),
        )
        .children((filter.is_empty() && !active).then(|| {
            div()
                .text_size(px(10.))
                .text_color(tone(chrome.muted))
                .child("⌘⇧F")
        }))
        .children((!filter.is_empty()).then(|| {
            div()
                .id("filter-clear")
                .px(px(2.))
                .text_size(px(11.))
                .text_color(tone(chrome.muted))
                .cursor_pointer()
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|this, _: &MouseDownEvent, _window, cx| {
                        this.filter.clear();
                        cx.notify();
                    }),
                )
                .child("×")
        }))
        .into_any_element()
}

fn tab_chip(tab: &crate::model::Tab, chrome: &Chrome) -> AnyElement {
    div()
        .flex_none()
        .h(px(16.))
        .px(px(5.))
        .rounded(px(4.))
        .bg(tone(chrome.line_soft))
        .text_size(px(10.))
        .text_color(tone(chrome.muted))
        .child(SharedString::from(tab.number.to_string()))
        .into_any_element()
}

/// A 15px leading box that holds a row's status dot or nothing, so every label
/// starts at the same x whether or not the pane has an agent mark.
fn leading_slot(status: Option<crate::terminal::Rgb>) -> AnyElement {
    div()
        .flex()
        .items_center()
        .justify_center()
        .flex_none()
        .size(px(agent_marks::SIZE))
        .children(status.map(|color| dot(tone(color), 6.)))
        .into_any_element()
}

/// Idle panes keep no dot; only working, blocked and done states earn one.
fn pane_dot(status: AgentStatus, selected: bool, chrome: &Chrome) -> Option<crate::terminal::Rgb> {
    let base = match status {
        AgentStatus::Working | AgentStatus::Blocked | AgentStatus::Done => {
            status_tone(status, chrome)
        }
        AgentStatus::Idle | AgentStatus::Unknown => return None,
    };
    Some(if selected {
        Chrome::blend(base, chrome.foreground, 55)
    } else {
        base
    })
}

fn empty_state(chrome: &Chrome) -> AnyElement {
    div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .px(px(8.))
        .py(px(6.))
        .child(
            div()
                .text_size(px(12.))
                .font_weight(gpui::FontWeight::MEDIUM)
                .text_color(tone(chrome.secondary))
                .child("No session yet"),
        )
        .child(
            div()
                .text_size(px(11.))
                .line_height(px(16.))
                .text_color(tone(chrome.muted))
                .whitespace_normal()
                .child("Start Herdr on this computer, or pair a device to see its panes here."),
        )
        .into_any_element()
}

fn nothing_matches(chrome: &Chrome) -> AnyElement {
    div()
        .px(px(8.))
        .py(px(6.))
        .text_size(px(11.))
        .text_color(tone(chrome.muted))
        .child("No panes match this filter.")
        .into_any_element()
}
