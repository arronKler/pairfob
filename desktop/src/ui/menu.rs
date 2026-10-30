//! The terminal's context menu: the rows it offers, and the card that draws
//! them over the session. Actions reuse the same clipboard and selection paths
//! the keyboard uses.

use gpui::prelude::*;
use gpui::{
    div, px, AnyElement, ClipboardItem, Context, ElementId, MouseButton, Pixels, Point,
    SharedString, Window,
};

use crate::app::input::KeyInput;
use crate::model::{PaneId, Rect, Scroll, SplitDirection};

use super::selection::Selection;
use super::theme::{tone, Chrome};
use super::window::PairfobWindow;

const WIDTH: f32 = 208.;
const ROW_HEIGHT: f32 = 28.;
const PADDING: f32 = 4.;
/// A rule plus its 4px margins above and below.
const SEPARATOR_HEIGHT: f32 = 9.;
const MARGIN: f32 = 8.;

#[derive(Clone, Copy, Debug)]
pub(crate) struct ContextMenu {
    pub at: Point<Pixels>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum MenuAction {
    Copy,
    SelectAll,
    Paste,
    ScrollToBottom,
    SplitRight,
    SplitDown,
    ToggleZoom,
    ClosePane,
    RenamePane,
    ToggleChat,
    LargerText,
    SmallerText,
    ResetText,
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct MenuState {
    pub has_selection: bool,
    pub has_pane: bool,
    pub scrolled: bool,
    pub zoomed: bool,
    pub can_split: bool,
    pub can_zoom: bool,
    pub can_close: bool,
    pub can_rename: bool,
    /// `Some(open)` when the focused pane publishes a chat token.
    pub chat: Option<bool>,
}

pub(crate) struct Row {
    pub action: MenuAction,
    pub label: &'static str,
    pub shortcut: &'static str,
    pub enabled: bool,
}

/// The menu grouped by purpose. A section with no available row (no pane
/// capability, no chat) is omitted, so separators only sit between real
/// groups. Pure, so the enabled matrix is testable without a window.
pub(crate) fn sections(state: &MenuState) -> Vec<Vec<Row>> {
    let clipboard = vec![
        Row {
            action: MenuAction::Copy,
            label: "Copy",
            shortcut: "⌘C",
            enabled: state.has_selection,
        },
        Row {
            action: MenuAction::SelectAll,
            label: "Select All",
            shortcut: "⌘A",
            enabled: state.has_pane,
        },
        Row {
            action: MenuAction::Paste,
            label: "Paste",
            shortcut: "⌘V",
            enabled: state.has_pane,
        },
    ];

    let mut pane = Vec::new();
    if state.can_split {
        pane.push(Row {
            action: MenuAction::SplitRight,
            label: "Split Right",
            shortcut: "⌘D",
            enabled: state.has_pane,
        });
        pane.push(Row {
            action: MenuAction::SplitDown,
            label: "Split Down",
            shortcut: "⌘⇧D",
            enabled: state.has_pane,
        });
    }
    if state.can_zoom {
        pane.push(Row {
            action: MenuAction::ToggleZoom,
            label: if state.zoomed {
                "Unzoom Pane"
            } else {
                "Zoom Pane"
            },
            shortcut: "⌘⇧↵",
            enabled: state.has_pane,
        });
    }
    if state.can_close {
        pane.push(Row {
            action: MenuAction::ClosePane,
            label: "Close Pane",
            shortcut: "⌘⇧W",
            enabled: state.has_pane,
        });
    }
    if state.can_rename {
        pane.push(Row {
            action: MenuAction::RenamePane,
            label: "Rename Pane…",
            shortcut: "⌘R",
            enabled: state.has_pane,
        });
    }

    let mut view = Vec::new();
    if let Some(chat_open) = state.chat {
        view.push(Row {
            action: MenuAction::ToggleChat,
            label: if chat_open {
                "Switch to TUI"
            } else {
                "Switch to Chat"
            },
            shortcut: "⌘⇧M",
            enabled: true,
        });
    }
    view.push(Row {
        action: MenuAction::LargerText,
        label: "Larger Text",
        shortcut: "⌘+",
        enabled: true,
    });
    view.push(Row {
        action: MenuAction::SmallerText,
        label: "Smaller Text",
        shortcut: "⌘−",
        enabled: true,
    });
    view.push(Row {
        action: MenuAction::ResetText,
        label: "Default Text Size",
        shortcut: "⌘0",
        enabled: true,
    });

    let scroll = vec![Row {
        action: MenuAction::ScrollToBottom,
        label: "Scroll to Bottom",
        shortcut: "",
        enabled: state.scrolled,
    }];

    [clipboard, pane, view, scroll]
        .into_iter()
        .filter(|section| !section.is_empty())
        .collect()
}

impl PairfobWindow {
    pub(crate) fn context_menu(
        &mut self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let menu = self.menu?;
        let chrome = self.chrome.clone();
        let focused = self.app.focused_pane();
        let has_pane = focused.is_some();
        let has_selection = self
            .selection
            .as_ref()
            .is_some_and(|selection| !selection.is_empty());
        let scrolled = self
            .focused_scroll()
            .is_some_and(|scroll| scroll.offset_from_bottom > 0);
        let zoomed = self
            .app
            .session
            .as_ref()
            .and_then(|session| session.focused_tab())
            .is_some_and(|(_, tab)| tab.zoomed);
        let chat = focused.and_then(|pane| {
            let open = self.chat_panes.contains(&pane);
            self.app
                .pane(&pane)
                .and_then(|pane| pane.chat_id())
                .map(|_| open)
        });
        let state = MenuState {
            has_selection,
            has_pane,
            scrolled,
            zoomed,
            can_split: self.app.supports("pane.split"),
            can_zoom: self.app.supports("pane.zoom"),
            can_close: self.app.supports("pane.close"),
            can_rename: self.app.supports("pane.rename"),
            chat,
        };
        let sections = sections(&state);
        let rows: usize = sections.iter().map(Vec::len).sum();
        let height = rows as f32 * ROW_HEIGHT
            + sections.len().saturating_sub(1) as f32 * SEPARATOR_HEIGHT
            + PADDING * 2.;
        let (x, y) = place(menu.at, WIDTH, height, window.viewport_size());

        let mut items = Vec::with_capacity(rows + sections.len());
        let mut index = 0;
        for (section_index, section) in sections.into_iter().enumerate() {
            if section_index > 0 {
                items.push(separator(&chrome));
            }
            for row in section {
                let row_index = index;
                index += 1;
                let hovered = row.enabled && self.menu_hover == Some(row.action);
                let foreground = if !row.enabled {
                    chrome.muted
                } else if hovered {
                    chrome.on_accent
                } else {
                    chrome.foreground
                };
                let shortcut = if hovered {
                    chrome.on_accent
                } else {
                    chrome.muted
                };
                let mut item = div()
                    .id(ElementId::Name(SharedString::from(format!(
                        "menu-row-{row_index}"
                    ))))
                    .flex()
                    .items_center()
                    .h(px(ROW_HEIGHT))
                    .px(px(10.))
                    .rounded(px(5.))
                    .text_size(px(12.5))
                    .text_color(tone(foreground))
                    .child(div().flex_1().child(row.label))
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(tone(shortcut))
                            .child(row.shortcut),
                    );
                if hovered {
                    item = item.bg(tone(chrome.accent));
                }
                if row.enabled {
                    let action = row.action;
                    item = item
                        .cursor_pointer()
                        .on_hover(cx.listener(move |this, hovered: &bool, _window, cx| {
                            let next = hovered.then_some(action);
                            if this.menu_hover != next {
                                this.menu_hover = next;
                                cx.notify();
                            }
                        }))
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(move |this, _event, window, cx| {
                                this.menu_choose(action, window, cx);
                                this.close_menu(cx);
                                cx.stop_propagation();
                            }),
                        );
                }
                items.push(item.into_any_element());
            }
        }

        let card = div()
            .absolute()
            .left(px(x))
            .top(px(y))
            .w(px(WIDTH))
            .flex()
            .flex_col()
            .p(px(PADDING))
            .rounded(px(8.))
            .bg(tone(chrome.card))
            .border(px(1.))
            .border_color(tone(chrome.line))
            .children(items);

        Some(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .child(
                    div()
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full()
                        .occlude()
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, _event, _window, cx| this.close_menu(cx)),
                        )
                        .on_mouse_down(
                            MouseButton::Right,
                            cx.listener(|this, _event, _window, cx| this.close_menu(cx)),
                        ),
                )
                .child(card)
                .into_any_element(),
        )
    }

    pub(crate) fn close_menu(&mut self, cx: &mut Context<Self>) {
        if self.menu.take().is_some() {
            self.menu_hover = None;
            cx.notify();
        }
    }

    pub(crate) fn menu_choose(
        &mut self,
        action: MenuAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match action {
            MenuAction::Copy => self.copy_selection(cx),
            MenuAction::SelectAll => self.select_all(cx),
            MenuAction::Paste => self.paste_clipboard(cx),
            MenuAction::ScrollToBottom => self.scroll_to_bottom(),
            MenuAction::SplitRight => {
                self.split_focused(SplitDirection::Vertical);
                self.focus_canvas(window, cx);
            }
            MenuAction::SplitDown => {
                self.split_focused(SplitDirection::Horizontal);
                self.focus_canvas(window, cx);
            }
            MenuAction::ToggleZoom => {
                self.zoom_focused();
                self.focus_canvas(window, cx);
            }
            MenuAction::ClosePane => {
                self.close_focused_pane();
                self.focus_canvas(window, cx);
            }
            MenuAction::RenamePane => self.open_rename(window, cx),
            MenuAction::ToggleChat => self.toggle_chat(window, cx),
            MenuAction::LargerText => self.zoom_text(1., window, cx),
            MenuAction::SmallerText => self.zoom_text(-1., window, cx),
            MenuAction::ResetText => self.reset_text_size(window, cx),
        }
    }

    pub(crate) fn copy_selection(&mut self, cx: &mut Context<Self>) {
        let Some(frame) = self.app.frame.clone() else {
            return;
        };
        let Some(text) = self
            .selection
            .as_ref()
            .and_then(|selection| selection.text(&frame))
        else {
            return;
        };
        cx.write_to_clipboard(ClipboardItem::new_string(text));
    }

    pub(crate) fn select_all(&mut self, cx: &mut Context<Self>) {
        let Some((pane, rect)) = self.focused_pane_rect() else {
            return;
        };
        if rect.width == 0 || rect.height == 0 {
            return;
        }
        self.selection = Some(Selection {
            pane,
            anchor: (rect.x, rect.y),
            head: (rect.right() - 1, rect.bottom() - 1),
        });
        cx.notify();
    }

    pub(crate) fn paste_clipboard(&mut self, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            if !text.is_empty() {
                self.send_input(KeyInput::Paste(text), cx);
            }
        }
    }

    /// There is no scroll RPC: reaching the bottom is one large downward
    /// scroll aimed at the pane's top-left cell.
    fn scroll_to_bottom(&mut self) {
        let Some((pane, rect)) = self.focused_pane_rect() else {
            return;
        };
        let Some(scroll) = self.focused_scroll() else {
            return;
        };
        let count = scroll
            .offset_from_bottom
            .saturating_add(u64::from(scroll.viewport_rows));
        if count == 0 {
            return;
        }
        let lines = -i32::try_from(count).unwrap_or(i32::MAX);
        let _ = self.handle.scroll(pane, rect.x, rect.y, lines);
    }

    fn focused_pane_rect(&self) -> Option<(PaneId, Rect)> {
        let frame = self.app.frame.as_ref()?;
        let pane = self.app.focused_pane()?;
        let rect = frame
            .panes
            .iter()
            .find(|candidate| candidate.id == pane)?
            .rect;
        Some((pane, rect))
    }

    fn focused_scroll(&self) -> Option<Scroll> {
        let frame = self.app.frame.as_ref()?;
        let pane = self.app.focused_pane()?;
        frame
            .panes
            .iter()
            .find(|candidate| candidate.id == pane)?
            .scroll
    }
}

/// The card opens down-right from the pointer, flips to the other side when
/// that would overflow, and stays at least [`MARGIN`] inside the viewport.
fn place(at: Point<Pixels>, width: f32, height: f32, viewport: gpui::Size<Pixels>) -> (f32, f32) {
    let view_width = f32::from(viewport.width);
    let view_height = f32::from(viewport.height);
    let mut x = f32::from(at.x);
    let mut y = f32::from(at.y);
    if x + width > view_width - MARGIN {
        x = f32::from(at.x) - width;
    }
    if y + height > view_height - MARGIN {
        y = f32::from(at.y) - height;
    }
    (
        x.clamp(MARGIN, (view_width - width - MARGIN).max(MARGIN)),
        y.clamp(MARGIN, (view_height - height - MARGIN).max(MARGIN)),
    )
}

fn separator(chrome: &Chrome) -> AnyElement {
    div()
        .h(px(1.))
        .mx(px(10.))
        .my(px(4.))
        .bg(tone(chrome.line))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{point, size};

    fn everything() -> MenuState {
        MenuState {
            has_selection: true,
            has_pane: true,
            scrolled: true,
            zoomed: false,
            can_split: true,
            can_zoom: true,
            can_close: true,
            can_rename: true,
            chat: Some(false),
        }
    }

    fn actions(section: &[Row]) -> Vec<MenuAction> {
        section.iter().map(|row| row.action).collect()
    }

    #[test]
    fn sections_group_by_purpose_and_enable_by_state() {
        let all = sections(&everything());
        assert_eq!(all.len(), 4);
        assert_eq!(
            actions(&all[0]),
            vec![MenuAction::Copy, MenuAction::SelectAll, MenuAction::Paste]
        );
        assert_eq!(
            actions(&all[1]),
            vec![
                MenuAction::SplitRight,
                MenuAction::SplitDown,
                MenuAction::ToggleZoom,
                MenuAction::ClosePane,
                MenuAction::RenamePane
            ]
        );
        assert_eq!(
            actions(&all[2]),
            vec![
                MenuAction::ToggleChat,
                MenuAction::LargerText,
                MenuAction::SmallerText,
                MenuAction::ResetText
            ]
        );
        assert_eq!(actions(&all[3]), vec![MenuAction::ScrollToBottom]);
        assert!(all.iter().flatten().all(|row| row.enabled));

        let labels: Vec<&str> = all[1].iter().map(|row| row.label).collect();
        assert_eq!(
            labels,
            vec![
                "Split Right",
                "Split Down",
                "Zoom Pane",
                "Close Pane",
                "Rename Pane…"
            ]
        );
        let shortcuts: Vec<&str> = all[1].iter().map(|row| row.shortcut).collect();
        assert_eq!(shortcuts, vec!["⌘D", "⌘⇧D", "⌘⇧↵", "⌘⇧W", "⌘R"]);
        assert_eq!(all[2][0].shortcut, "⌘⇧M");
        assert_eq!(all[3][0].shortcut, "");
    }

    #[test]
    fn rows_hide_when_the_daemon_does_not_advertise_the_capability() {
        let mut state = everything();
        state.can_split = false;
        state.can_zoom = false;
        state.can_close = false;
        state.can_rename = false;
        let hidden = sections(&state);
        assert_eq!(hidden.len(), 3, "the pane section disappears");
        assert_eq!(
            actions(&hidden[1]),
            vec![
                MenuAction::ToggleChat,
                MenuAction::LargerText,
                MenuAction::SmallerText,
                MenuAction::ResetText
            ]
        );

        state.chat = None;
        let plain = sections(&state);
        assert_eq!(
            plain.len(),
            3,
            "the view section survives on text size alone"
        );
        assert_eq!(
            actions(&plain[0]),
            vec![MenuAction::Copy, MenuAction::SelectAll, MenuAction::Paste]
        );
        assert_eq!(actions(&plain[2]), vec![MenuAction::ScrollToBottom]);
    }

    #[test]
    fn nothing_is_enabled_without_a_pane_or_a_selection() {
        let state = MenuState {
            can_split: true,
            can_zoom: true,
            can_close: true,
            ..MenuState::default()
        };
        let rows: Vec<Row> = sections(&state).into_iter().flatten().collect();
        let text_size = [
            MenuAction::LargerText,
            MenuAction::SmallerText,
            MenuAction::ResetText,
        ];
        assert!(
            rows.iter()
                .all(|row| row.enabled == text_size.contains(&row.action)),
            "only text size works without a pane or a selection"
        );

        let scrolled = MenuState {
            has_pane: true,
            scrolled: true,
            ..MenuState::default()
        };
        let rows: Vec<Row> = sections(&scrolled).into_iter().flatten().collect();
        assert!(!rows[0].enabled, "copy needs a selection");
        assert!(rows[1].enabled && rows[2].enabled);
        let scroll = rows
            .iter()
            .find(|row| row.action == MenuAction::ScrollToBottom)
            .expect("the scroll row");
        assert!(scroll.enabled, "scrolled away from the bottom");
    }

    #[test]
    fn zoom_and_chat_labels_flip_with_their_state() {
        let mut state = everything();
        state.zoomed = true;
        state.chat = Some(true);
        let flipped = sections(&state);
        assert_eq!(flipped[1][2].label, "Unzoom Pane");
        assert_eq!(flipped[2][0].label, "Switch to TUI");
    }

    #[test]
    fn the_card_flips_at_the_edges_and_keeps_its_margin() {
        let viewport = size(px(1000.), px(800.));
        assert_eq!(
            place(point(px(100.), px(100.)), 208., 129., viewport),
            (100., 100.)
        );
        assert_eq!(
            place(point(px(900.), px(100.)), 208., 129., viewport),
            (692., 100.)
        );
        assert_eq!(
            place(point(px(100.), px(780.)), 208., 129., viewport),
            (100., 651.)
        );
        assert_eq!(place(point(px(2.), px(2.)), 208., 129., viewport), (8., 8.));
    }
}
