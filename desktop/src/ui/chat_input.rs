//! Typing into the chat composer. Printable text arrives through the input
//! method; this maps the editing keys and the image attachments, and keeps the
//! pane's PTY out of it.

use std::path::PathBuf;

use gpui::{ClipboardEntry, Context, Image, KeyDownEvent, PathPromptOptions};

use crate::chat::attach;

use super::window::PairfobWindow;

impl PairfobWindow {
    /// Returns whether the key belonged to the chat. Every key is consumed
    /// while the chat column has focus, so a keystroke never falls through to
    /// the pane underneath.
    pub(crate) fn chat_key_down(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) -> bool {
        let key = event.keystroke.key.as_str();
        let modifiers = event.keystroke.modifiers;

        // Cmd+V with a copied screenshot attaches it; without an image the key
        // keeps the behavior it had before.
        if modifiers.platform && key == "v" {
            if let Some(image) = clipboard_image(cx) {
                self.chat_attach_image(&image, cx);
                return true;
            }
            return false;
        }
        if modifiers.platform {
            return false;
        }

        if key == "escape" {
            if self.chat.as_ref().is_some_and(|chat| chat.menu.is_some()) {
                self.close_chat_menu(cx);
            } else if let Some(pane) = self.focused_pane_id() {
                self.chat_panes.remove(&pane);
                cx.notify();
            }
            return true;
        }

        match key {
            "enter" if modifiers.shift => {
                self.composer.push('\n');
                cx.notify();
            }
            "enter" => self.send_chat(cx),
            "backspace" | "back" if self.composer.pop().is_some() => cx.notify(),
            _ => {}
        }
        true
    }

    pub(crate) fn chat_insert(&mut self, text: &str, cx: &mut Context<Self>) {
        if text.is_empty() {
            return;
        }
        self.composer.push_str(text);
        cx.notify();
    }

    /// Files dropped or picked for the next prompt. Each one is checked on its
    /// own so one bad file does not discard the rest.
    pub(crate) fn chat_attach_files(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        let Some(chat) = self.chat.as_mut() else {
            return;
        };
        let mut rejected = None;
        for path in paths {
            match attach::from_path(&path) {
                Ok(attachment) => chat.attachments.push(attachment),
                Err(error) => rejected = Some(error),
            }
        }
        chat.attach_error = rejected;
        cx.notify();
    }

    /// A pasted image. GPUI hands it over already encoded, so the bytes are
    /// the same ones the clipboard carried.
    pub(crate) fn chat_attach_image(&mut self, image: &Image, cx: &mut Context<Self>) {
        let name = format!("pasted image.{}", image.format.extension());
        let result = attach::from_encoded(name, image.bytes.clone());
        let Some(chat) = self.chat.as_mut() else {
            return;
        };
        match result {
            Ok(attachment) => {
                chat.attachments.push(attachment);
                chat.attach_error = None;
            }
            Err(error) => chat.attach_error = Some(error),
        }
        cx.notify();
    }

    pub(crate) fn chat_remove_attachment(&mut self, index: usize, cx: &mut Context<Self>) {
        if let Some(chat) = self.chat.as_mut() {
            if index < chat.attachments.len() {
                chat.attachments.remove(index);
            }
            chat.attach_error = None;
        }
        cx.notify();
    }

    /// The platform file picker. The paths arrive on a oneshot receiver, so
    /// the window keeps painting while the sheet is up.
    pub(crate) fn chat_pick_attachments(&mut self, cx: &mut Context<Self>) {
        if self.chat.is_none() {
            return;
        }
        let picked = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some("Attach images".into()),
        });
        cx.spawn(async move |this, cx| match picked.await {
            Ok(Ok(Some(paths))) => {
                let _ = this.update(cx, |this, cx| this.chat_attach_files(paths, cx));
            }
            Ok(Err(error)) => {
                let _ = this.update(cx, |this, cx| {
                    if let Some(chat) = this.chat.as_mut() {
                        chat.attach_error =
                            Some(format!("Could not open the file picker: {error}"));
                    }
                    cx.notify();
                });
            }
            _ => {}
        })
        .detach();
    }

    fn focused_pane_id(&self) -> Option<crate::model::PaneId> {
        self.app.focused_pane()
    }
}

fn clipboard_image(cx: &gpui::App) -> Option<Image> {
    cx.read_from_clipboard()?
        .entries
        .into_iter()
        .find_map(|entry| match entry {
            ClipboardEntry::Image(image) => Some(image),
            _ => None,
        })
}
