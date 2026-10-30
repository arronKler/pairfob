//! Window key input to the endpoint's semantic input events. Platform
//! shortcuts are the window's; they never reach the pane.

use crate::app::input::{KeyCode, KeyInput, Modifiers};
use crate::herdr::wire::{ClientKeyCode, ClientKeyKind, ClientPaneInputEvent};

pub(super) fn wire_inputs(inputs: &[KeyInput]) -> Vec<ClientPaneInputEvent> {
    inputs
        .iter()
        .filter_map(|input| match input {
            KeyInput::Text(text) => Some(ClientPaneInputEvent::TextCommit(text.clone())),
            KeyInput::Paste(text) => Some(ClientPaneInputEvent::Paste(text.clone())),
            KeyInput::Key { code, modifiers } => {
                // The window owns platform shortcuts and sends them itself.
                if modifiers.platform {
                    return None;
                }
                Some(ClientPaneInputEvent::Key {
                    code: key_code(*code, *modifiers),
                    modifiers: u8::from(modifiers.shift)
                        | (u8::from(modifiers.ctrl) << 1)
                        | (u8::from(modifiers.alt) << 2),
                    kind: ClientKeyKind::Press,
                    repeat_count: 1,
                    shifted_codepoint: None,
                    generated_text: None,
                    tracks_release: false,
                    physical_key_id: None,
                    windows_record: None,
                })
            }
        })
        .collect()
}

fn key_code(code: KeyCode, modifiers: Modifiers) -> ClientKeyCode {
    match code {
        KeyCode::Enter => ClientKeyCode::Enter,
        KeyCode::Escape => ClientKeyCode::Esc,
        KeyCode::Tab if modifiers.shift => ClientKeyCode::BackTab,
        KeyCode::Tab => ClientKeyCode::Tab,
        KeyCode::Backspace => ClientKeyCode::Backspace,
        KeyCode::Delete => ClientKeyCode::Delete,
        KeyCode::Insert => ClientKeyCode::Insert,
        KeyCode::Up => ClientKeyCode::Up,
        KeyCode::Down => ClientKeyCode::Down,
        KeyCode::Left => ClientKeyCode::Left,
        KeyCode::Right => ClientKeyCode::Right,
        KeyCode::Home => ClientKeyCode::Home,
        KeyCode::End => ClientKeyCode::End,
        KeyCode::PageUp => ClientKeyCode::PageUp,
        KeyCode::PageDown => ClientKeyCode::PageDown,
        KeyCode::Char(ch) => ClientKeyCode::Char(ch),
        KeyCode::Function(number) => ClientKeyCode::F(number),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(code: KeyCode, shift: bool) -> KeyInput {
        KeyInput::Key {
            code,
            modifiers: Modifiers {
                shift,
                ..Modifiers::default()
            },
        }
    }

    #[test]
    fn text_and_paste_keep_their_kind() {
        let events = wire_inputs(&[
            KeyInput::Text("hi".into()),
            KeyInput::Paste("pasted".into()),
        ]);
        assert_eq!(
            events,
            vec![
                ClientPaneInputEvent::TextCommit("hi".into()),
                ClientPaneInputEvent::Paste("pasted".into())
            ]
        );
    }

    #[test]
    fn shift_tab_becomes_back_tab_with_the_shift_bit() {
        let events = wire_inputs(&[key(KeyCode::Tab, true)]);
        let ClientPaneInputEvent::Key {
            code, modifiers, ..
        } = &events[0]
        else {
            panic!("expected a key");
        };
        assert_eq!(*code, ClientKeyCode::BackTab);
        assert_eq!(*modifiers, 1);
    }

    #[test]
    fn platform_keys_are_left_to_the_window() {
        let events = wire_inputs(&[KeyInput::Key {
            code: KeyCode::Char('q'),
            modifiers: Modifiers {
                platform: true,
                ..Modifiers::default()
            },
        }]);
        assert!(events.is_empty());
    }

    #[test]
    fn function_and_character_keys_map_one_to_one() {
        let events = wire_inputs(&[
            key(KeyCode::Function(5), false),
            key(KeyCode::Char('x'), false),
        ]);
        assert!(matches!(
            &events[0],
            ClientPaneInputEvent::Key {
                code: ClientKeyCode::F(5),
                kind: ClientKeyKind::Press,
                repeat_count: 1,
                ..
            }
        ));
        assert!(matches!(
            &events[1],
            ClientPaneInputEvent::Key {
                code: ClientKeyCode::Char('x'),
                ..
            }
        ));
    }
}
