//! Keyboard and input-method plumbing for the terminal. Printable text comes
//! through [`gpui::EntityInputHandler`]; keys that mean something to the
//! program are mapped here and sent as [`KeyInput`]s.

use std::ops::Range;

use gpui::{
    point, px, size, Bounds, ClipboardItem, Context, EntityInputHandler, KeyDownEvent, Pixels,
    Point, UTF16Selection, Window,
};

use crate::app::input::{KeyCode, KeyInput, Modifiers as KeyModifiers};
use crate::app::Notice;
use crate::herdr::engine::Direction;

use super::window::PairfobWindow;

fn direction(key: &str) -> Option<Direction> {
    match key {
        "left" => Some(Direction::Left),
        "right" => Some(Direction::Right),
        "up" => Some(Direction::Up),
        "down" => Some(Direction::Down),
        _ => None,
    }
}

impl PairfobWindow {
    pub(crate) fn key_down(
        &mut self,
        event: &KeyDownEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let key = event.keystroke.key.as_str();
        let modifiers = event.keystroke.modifiers;

        // The HUD is a development tool, so F12 reaches it before the pane.
        #[cfg(feature = "perf-hud")]
        if key == "f12" && !modifiers.platform {
            self.show_perf_hud = !self.show_perf_hud;
            cx.notify();
            cx.stop_propagation();
            return;
        }

        if self.pairing.is_some() {
            if key == "escape" {
                self.close_pairing(cx);
            }
            // The sheet is modal: nothing typed behind it may reach a pane.
            cx.stop_propagation();
            return;
        }

        if key == "escape" && self.menu.is_some() {
            self.close_menu(cx);
            cx.stop_propagation();
            return;
        }

        if key == "escape" && self.sessions.is_some() {
            self.close_sessions(cx);
            cx.stop_propagation();
            return;
        }

        if key == "escape" && self.devices.is_some() {
            self.close_devices(cx);
            cx.stop_propagation();
            return;
        }

        if key == "escape" && self.boot.diagnostics.is_some() {
            self.close_diagnostics(cx);
            cx.stop_propagation();
            return;
        }

        if key == "escape" && self.rename.is_some() {
            self.close_rename(_window, cx);
            cx.stop_propagation();
            return;
        }

        if key == "escape" && self.find.is_some() {
            self.close_find(_window, cx);
            cx.stop_propagation();
            return;
        }

        if self.filter_active {
            match key {
                "escape" => {
                    if self.filter.is_empty() {
                        self.leave_filter(false, cx);
                    } else {
                        self.leave_filter(true, cx);
                    }
                }
                "backspace" | "back" => self.filter_backspace(cx),
                "enter" => self.leave_filter(false, cx),
                _ => {}
            }
            cx.stop_propagation();
            return;
        }

        if modifiers.platform {
            let handled = match key {
                "f" if modifiers.shift => {
                    self.start_filter(_window, cx);
                    true
                }
                "f" => {
                    self.open_find(_window, cx);
                    true
                }
                "r" => {
                    self.open_rename(_window, cx);
                    true
                }
                "+" | "=" => {
                    self.zoom_text(1., _window, cx);
                    self.focus_canvas(_window, cx);
                    true
                }
                "-" => {
                    self.zoom_text(-1., _window, cx);
                    self.focus_canvas(_window, cx);
                    true
                }
                "0" => {
                    self.reset_text_size(_window, cx);
                    self.focus_canvas(_window, cx);
                    true
                }
                "left" | "right" | "up" | "down" if modifiers.alt && modifiers.shift => {
                    if let Some(direction) = direction(key) {
                        self.resize_focused(direction);
                    }
                    self.focus_canvas(_window, cx);
                    true
                }
                "left" | "right" | "up" | "down" if modifiers.alt && modifiers.control => {
                    if let Some(direction) = direction(key) {
                        self.swap_focused(direction);
                    }
                    self.focus_canvas(_window, cx);
                    true
                }
                "left" | "right" | "up" | "down" if modifiers.alt => {
                    if let Some(direction) = direction(key) {
                        self.focus_direction(direction);
                    }
                    true
                }
                "s" if modifiers.alt => {
                    self.toggle_sidebar(cx);
                    self.focus_canvas(_window, cx);
                    true
                }
                "d" if modifiers.shift => {
                    self.split_focused(crate::model::SplitDirection::Horizontal);
                    self.focus_canvas(_window, cx);
                    true
                }
                "d" => {
                    self.split_focused(crate::model::SplitDirection::Vertical);
                    self.focus_canvas(_window, cx);
                    true
                }
                "enter" if modifiers.shift => {
                    self.zoom_focused();
                    self.focus_canvas(_window, cx);
                    true
                }
                "a" if modifiers.shift => {
                    self.toggle_appearance(_window, cx);
                    self.focus_canvas(_window, cx);
                    true
                }
                "m" if modifiers.shift => {
                    self.toggle_chat(_window, cx);
                    true
                }
                "w" if modifiers.shift => {
                    self.close_focused_pane();
                    self.focus_canvas(_window, cx);
                    true
                }
                _ => false,
            };
            if handled {
                cx.stop_propagation();
                return;
            }
        }

        if self.find.is_some() {
            match key {
                "enter" if modifiers.shift => self.find_step(true, cx),
                "enter" => self.find_step(false, cx),
                "backspace" | "back" => self.find_backspace(cx),
                _ => {}
            }
            cx.stop_propagation();
            return;
        }

        if self.rename.is_some() {
            match key {
                "enter" => self.commit_rename(_window, cx),
                "backspace" | "back" => self.rename_backspace(cx),
                _ => {}
            }
            cx.stop_propagation();
            return;
        }

        if self.chat_visible() {
            if self.chat_key_down(event, cx) {
                cx.stop_propagation();
            }
            return;
        }

        if is_paste(key, modifiers) {
            self.paste_clipboard(cx);
            cx.stop_propagation();
            return;
        }

        if is_copy(key, modifiers) {
            self.copy_selection(cx);
            cx.stop_propagation();
            return;
        }

        if is_select_all(key, modifiers) {
            self.select_all(cx);
            cx.stop_propagation();
            return;
        }

        // AltGr and similar layouts need the input method's character more
        // than they need a key name.
        if event.prefer_character_input {
            return;
        }

        if let Some(code) = key_code(key, modifiers) {
            self.send_input(
                KeyInput::Key {
                    code,
                    modifiers: key_modifiers(modifiers),
                },
                cx,
            );
            cx.stop_propagation();
        }
    }

    pub(crate) fn send_input(&mut self, input: KeyInput, cx: &mut Context<Self>) {
        if !self.app.can_interact() {
            return;
        }
        let Some(pane) = self.app.focused_pane() else {
            return;
        };
        if self.handle.send_keys(pane, vec![input]).is_err() {
            self.app.notice = Some(Notice::warning("The connection to Herdr closed."));
            cx.notify();
        }
    }
}

impl EntityInputHandler for PairfobWindow {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        adjusted: &mut Option<Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<String> {
        let text: Vec<u16> = self.marked.encode_utf16().collect();
        let range = range.start.min(text.len())..range.end.min(text.len());
        *adjusted = Some(range.clone());
        Some(String::from_utf16_lossy(&text[range]))
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        let end = self.marked.encode_utf16().count();
        let range = self
            .marked_selection
            .clone()
            .filter(|range| range.start <= range.end && range.end <= end)
            .unwrap_or(end..end);
        Some(UTF16Selection {
            range,
            reversed: false,
        })
    }

    fn marked_text_range(
        &self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Range<usize>> {
        (!self.marked.is_empty()).then(|| 0..self.marked.encode_utf16().count())
    }

    fn unmark_text(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.marked.clear();
        self.marked_selection = None;
        cx.notify();
    }

    fn paste(&mut self, item: ClipboardItem, _window: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = item.text() {
            if text.is_empty() {
                return;
            }
            if self.rename.is_some() {
                self.rename_push(&text, cx);
            } else if self.find.is_some() {
                self.find_push(&text, cx);
            } else if self.filter_active {
                self.edit_filter(&text, cx);
            } else if self.chat_visible() {
                self.chat_insert(&text, cx);
            } else {
                self.send_input(KeyInput::Paste(text), cx);
            }
        }
        // An image on the clipboard is attached by the chat key handler, which
        // is the path this window actually gets its Cmd+V through; attaching
        // here as well would add the same screenshot twice.
    }

    fn replace_text_in_range(
        &mut self,
        _range: Option<Range<usize>>,
        text: &str,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.marked.clear();
        self.marked_selection = None;
        if !text.is_empty() {
            if self.rename.is_some() {
                self.rename_push(text, cx);
            } else if self.find.is_some() {
                self.find_push(text, cx);
            } else if self.filter_active {
                self.edit_filter(text, cx);
            } else if self.chat_visible() {
                self.chat_insert(text, cx);
            } else {
                self.send_input(KeyInput::Text(text.to_owned()), cx);
            }
        }
        cx.notify();
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        _range: Option<Range<usize>>,
        new_text: &str,
        new_selected_range: Option<Range<usize>>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.filter_active || self.chat_visible() || self.find.is_some() || self.rename.is_some()
        {
            self.marked = new_text.to_owned();
            self.marked_selection = new_selected_range;
            cx.notify();
            return;
        }
        if !self.app.can_interact() {
            return;
        }
        // Composition stays local until the input method commits it; the
        // program must not see half a character.
        self.marked = new_text.to_owned();
        self.marked_selection = new_selected_range;
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        _range_utf16: Range<usize>,
        element_bounds: Bounds<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        if self.filter_active || self.chat_visible() || self.find.is_some() || self.rename.is_some()
        {
            return None;
        }
        let cell = &self.cell;
        let origin = match self.app.frame.as_ref().and_then(|frame| frame.cursor) {
            Some(cursor) => {
                element_bounds.origin
                    + point(
                        px(f32::from(cursor.x) * cell.width),
                        px(f32::from(cursor.y) * cell.height),
                    )
            }
            None => element_bounds.origin,
        };
        Some(Bounds::new(origin, size(px(cell.width), px(cell.height))))
    }

    fn character_index_for_point(
        &mut self,
        _point: Point<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        None
    }
}

fn is_paste(key: &str, modifiers: gpui::Modifiers) -> bool {
    key == "v" && (modifiers.platform || modifiers.control)
}

/// Cmd on macOS, Ctrl+Shift elsewhere: plain Ctrl+C is the program's SIGINT
/// on Linux and must keep reaching the pane.
fn is_copy(key: &str, modifiers: gpui::Modifiers) -> bool {
    key == "c" && (modifiers.platform || (modifiers.control && modifiers.shift))
}

fn is_select_all(key: &str, modifiers: gpui::Modifiers) -> bool {
    key == "a" && (modifiers.platform || (modifiers.control && modifiers.shift))
}

fn key_modifiers(modifiers: gpui::Modifiers) -> KeyModifiers {
    KeyModifiers {
        ctrl: modifiers.control,
        alt: modifiers.alt,
        shift: modifiers.shift,
        platform: modifiers.platform,
    }
}

/// Named keys and control combinations; printable text is left to the input
/// method. Platform (Cmd) shortcuts belong to the app and never reach a pane.
fn key_code(key: &str, modifiers: gpui::Modifiers) -> Option<KeyCode> {
    use KeyCode::*;
    if modifiers.platform {
        return None;
    }
    Some(match key {
        "enter" => Enter,
        "backspace" | "back" => Backspace,
        "escape" => Escape,
        "tab" => Tab,
        "up" => Up,
        "down" => Down,
        "left" => Left,
        "right" => Right,
        "home" => Home,
        "end" => End,
        "pageup" => PageUp,
        "pagedown" => PageDown,
        "delete" => Delete,
        "insert" => Insert,
        "space" if modifiers.control || modifiers.alt => Char(' '),
        name if name.starts_with('f') => {
            let number: u8 = name.get(1..)?.parse().ok()?;
            if !(1..=12).contains(&number) {
                return None;
            }
            Function(number)
        }
        name if (modifiers.control || modifiers.alt) && name.chars().count() == 1 => {
            let ch = name.chars().next()?;
            // GPUI reports Shift-letter as the lowercase key plus Shift.
            Char(if modifiers.alt && modifiers.shift {
                ch.to_ascii_uppercase()
            } else {
                ch
            })
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mods(control: bool, alt: bool, shift: bool, platform: bool) -> gpui::Modifiers {
        gpui::Modifiers {
            control,
            alt,
            shift,
            platform,
            ..Default::default()
        }
    }

    #[test]
    fn named_keys_map_without_needing_a_character() {
        let none = mods(false, false, false, false);
        assert_eq!(key_code("enter", none), Some(KeyCode::Enter));
        assert_eq!(key_code("back", none), Some(KeyCode::Backspace));
        assert_eq!(key_code("escape", none), Some(KeyCode::Escape));
        assert_eq!(key_code("pagedown", none), Some(KeyCode::PageDown));
        assert_eq!(key_code("f5", none), Some(KeyCode::Function(5)));
        assert_eq!(key_code("f13", none), None);
        assert_eq!(key_code("shift", none), None);
    }

    #[test]
    fn only_control_and_alt_turn_a_letter_into_a_key() {
        let none = mods(false, false, false, false);
        assert_eq!(key_code("a", none), None, "plain text goes through the IME");
        assert_eq!(
            key_code("a", mods(true, false, false, false)),
            Some(KeyCode::Char('a'))
        );
        assert_eq!(
            key_code("a", mods(false, true, true, false)),
            Some(KeyCode::Char('A'))
        );
        assert_eq!(
            key_code("space", mods(true, false, false, false)),
            Some(KeyCode::Char(' '))
        );
    }

    #[test]
    fn platform_shortcuts_never_reach_the_pane() {
        assert_eq!(key_code("c", mods(false, false, false, true)), None);
        assert_eq!(key_code("enter", mods(false, false, false, true)), None);
        assert!(is_paste("v", mods(false, false, false, true)));
        assert!(is_paste("v", mods(true, false, false, false)));
        assert!(!is_paste("c", mods(false, false, false, true)));
    }

    #[test]
    fn copy_and_select_all_keep_plain_control_for_the_program() {
        assert!(is_copy("c", mods(false, false, false, true)));
        assert!(is_copy("c", mods(true, false, true, false)));
        assert!(!is_copy("c", mods(true, false, false, false)));
        assert!(is_select_all("a", mods(false, false, false, true)));
        assert!(is_select_all("a", mods(true, false, true, false)));
        assert!(!is_select_all("a", mods(true, false, false, false)));
        assert!(!is_copy("v", mods(false, false, false, true)));
    }

    #[test]
    fn tab_keeps_shift_for_the_engine_to_send_backtab() {
        let modifiers = mods(false, false, true, false);
        assert_eq!(key_code("tab", modifiers), Some(KeyCode::Tab));
        assert!(key_modifiers(modifiers).shift);
    }
}
