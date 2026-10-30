//! One chat process attached to the focused pane: the socket, the transcript
//! it sends, and the commands the view answers with. The TUI and the chat view
//! are two ways to look at the same pane; switching never resizes the program,
//! because the terminal is simply not laid out while the chat is on screen.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::thread;

use crossbeam_channel::Receiver;
use gpui::{px, Context, ListAlignment, ListState, Window};

use crate::app::Notice;
use crate::chat::attach::PendingAttachment;
use crate::chat::{self, ChatEvent, ChatHandle, ChatState};
use crate::model::PaneId;

use super::window::PairfobWindow;

/// How many notices the chat column queues past the last painted one.
const CHAT_BACKLOG: usize = 512;

pub(crate) struct ChatSession {
    pub(crate) pane: PaneId,
    pub(crate) id: String,
    /// Shared with the list's render closure, which reads rows while they are
    /// laid out. In place mutation keeps a streamed token from cloning the
    /// whole transcript.
    pub(crate) state: Rc<RefCell<ChatState>>,
    pub(crate) handle: ChatHandle,
    pub(crate) connected: bool,
    pub(crate) error: Option<String>,
    /// Images picked, dropped or pasted for the next prompt. They leave this
    /// list only when the chat accepts the prompt.
    pub(crate) attachments: Vec<PendingAttachment>,
    /// A local refusal from an attachment, kept apart from the socket's own
    /// error so the next good pick clears it.
    pub(crate) attach_error: Option<String>,
    /// Set when the view fell behind the transcript and needs a new snapshot.
    pub(crate) resync: bool,
    pub(crate) menu: Option<ChatMenu>,
    pub(crate) list: ListState,
    pub(crate) list_count: usize,
    pub(crate) measured_revision: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MenuKind {
    Modes,
    Option(usize),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ChatMenu {
    pub(crate) kind: MenuKind,
}

impl ChatSession {
    fn new(pane: PaneId, id: String, handle: ChatHandle) -> Self {
        let list = ListState::new(0, ListAlignment::Top, px(600.));
        Self {
            pane,
            id,
            state: Rc::new(RefCell::new(ChatState::default())),
            handle,
            connected: false,
            error: None,
            attachments: Vec::new(),
            attach_error: None,
            resync: false,
            menu: None,
            list,
            list_count: 0,
            measured_revision: 0,
        }
    }
}

impl PairfobWindow {
    pub(crate) fn chat_target(&self) -> Option<(PaneId, String)> {
        let pane = self.app.focused_pane()?;
        let id = self.app.pane(&pane)?.chat_id()?.to_owned();
        Some((pane, id))
    }

    pub(crate) fn chat_visible(&self) -> bool {
        self.chat_target()
            .is_some_and(|(pane, _)| self.chat_panes.contains(&pane))
    }

    /// Open or close the chat column for the focused pane. The pane's PTY is
    /// untouched either way.
    pub(crate) fn toggle_chat(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((pane, _)) = self.chat_target() else {
            self.notify(
                Notice::warning("This pane has no chat; run pairfob-chat in it first."),
                cx,
            );
            return;
        };
        if !self.chat_panes.insert(pane.clone()) {
            self.chat_panes.remove(&pane);
        }
        self.chat_error = None;
        self.chat_attempted = None;
        self.chat = None;
        self.sync_chat(cx);
        self.focus_canvas(window, cx);
        cx.notify();
    }

    /// Keep exactly the focused pane's chat attached while its column shows.
    /// Called on every tick, so a token that appears later opens the chat
    /// without the user reopening it.
    pub(crate) fn sync_chat(&mut self, cx: &mut Context<Self>) {
        let Some((pane, id)) = self.chat_target() else {
            return;
        };
        if self.chat_visible() {
            let current = self
                .chat
                .as_ref()
                .is_some_and(|chat| chat.pane == pane && chat.id == id && !chat.resync);
            if current {
                return;
            }
            if self.chat.as_ref().is_some_and(|chat| chat.resync) {
                self.chat_attempted = None;
            }
            if self
                .chat_attempted
                .as_ref()
                .is_some_and(|(attempted_pane, attempted_id)| {
                    attempted_pane == &pane && attempted_id == &id
                })
            {
                return;
            }
            self.attach_chat(pane, &id, cx);
        }
    }

    fn attach_chat(&mut self, pane: PaneId, id: &str, cx: &mut Context<Self>) {
        self.chat = None;
        self.chat_attempted = Some((pane.clone(), id.to_owned()));
        match chat::attach(id, None) {
            Ok(connection) => {
                spawn_chat_pump(
                    connection.events,
                    Arc::clone(&self.chat_mailbox),
                    self.wake.clone(),
                );
                self.chat = Some(ChatSession::new(pane, id.to_owned(), connection.handle));
                self.chat_error = None;
            }
            Err(error) => {
                self.chat_error = Some(error.to_string());
            }
        }
        cx.notify();
    }

    pub(crate) fn retry_chat(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.chat_error = None;
        self.chat_attempted = None;
        self.chat = None;
        self.sync_chat(cx);
        self.focus_canvas(window, cx);
    }

    pub(crate) fn apply_chat_event(&mut self, event: ChatEvent) {
        let Some(chat) = self.chat.as_mut() else {
            return;
        };
        match event {
            ChatEvent::Welcome { .. } => {
                chat.connected = true;
            }
            ChatEvent::Snapshot { epoch, seq, state } => {
                chat.state.borrow_mut().apply_snapshot(&epoch, seq, *state);
                chat.connected = true;
                chat.error = None;
                chat.resync = false;
            }
            ChatEvent::Changes { epoch, changes } => {
                for change in &changes {
                    if let Err(error) = chat.state.borrow_mut().apply_change(&epoch, change) {
                        chat.error = Some(error.to_string());
                        chat.resync = true;
                        break;
                    }
                }
            }
            ChatEvent::Result { ok, error, .. } => {
                if !ok {
                    chat.error = Some(match error {
                        Some(error) => format!("{}: {}", error.code, error.message),
                        None => "the command failed".to_owned(),
                    });
                }
            }
            ChatEvent::Closed(reason) => {
                chat.connected = false;
                chat.error = Some(reason);
            }
        }
    }

    pub(crate) fn send_chat(&mut self, cx: &mut Context<Self>) {
        let text = std::mem::take(&mut self.composer);
        let text = text.trim_end().to_owned();
        let Some(chat) = self.chat.as_mut() else {
            if !text.is_empty() {
                self.composer = text;
            }
            return;
        };
        if text.trim().is_empty() && chat.attachments.is_empty() {
            return;
        }
        if !crate::chat::attach::fits_frame(&text, &chat.attachments) {
            chat.attach_error = Some(
                "These attachments do not fit one chat frame (4 MiB); remove one and try again."
                    .into(),
            );
            self.composer = text;
            cx.notify();
            return;
        }
        let attachments = chat
            .attachments
            .iter()
            .map(PendingAttachment::to_wire)
            .collect();
        if !chat.handle.send_prompt_with(&text, attachments) {
            chat.error = Some("the chat process is not accepting commands".into());
            self.composer = text;
            cx.notify();
            return;
        }
        chat.attachments.clear();
        chat.attach_error = None;
        cx.notify();
    }

    pub(crate) fn cancel_chat_turn(&mut self, cx: &mut Context<Self>) {
        if let Some(chat) = self.chat.as_mut() {
            if !chat.handle.cancel() {
                chat.error = Some("the chat process is not accepting commands".into());
            }
        }
        cx.notify();
    }

    pub(crate) fn open_chat_menu(&mut self, kind: MenuKind, cx: &mut Context<Self>) {
        if let Some(chat) = self.chat.as_mut() {
            chat.menu = Some(ChatMenu { kind });
        }
        cx.notify();
    }

    pub(crate) fn close_chat_menu(&mut self, cx: &mut Context<Self>) {
        if let Some(chat) = self.chat.as_mut() {
            chat.menu = None;
        }
        cx.notify();
    }

    pub(crate) fn choose_chat_mode(&mut self, mode: &str, cx: &mut Context<Self>) {
        if let Some(chat) = self.chat.as_mut() {
            chat.handle.set_mode(mode);
            chat.menu = None;
        }
        cx.notify();
    }

    pub(crate) fn choose_chat_option(&mut self, option: &str, value: &str, cx: &mut Context<Self>) {
        if let Some(chat) = self.chat.as_mut() {
            chat.handle.set_option(option, value);
            chat.menu = None;
        }
        cx.notify();
    }

    pub(crate) fn answer_permission(
        &mut self,
        request_id: &str,
        option_id: &str,
        cx: &mut Context<Self>,
    ) {
        if let Some(chat) = self.chat.as_mut() {
            if !chat.handle.answer(request_id, option_id) {
                chat.error = Some("the chat process is not accepting commands".into());
            }
        }
        cx.notify();
    }

    pub(crate) fn unqueue_prompt(&mut self, queue_id: &str, cx: &mut Context<Self>) {
        if let Some(chat) = self.chat.as_mut() {
            chat.handle.unqueue(queue_id);
        }
        cx.notify();
    }

    pub(crate) fn set_chat_auto_accept(&mut self, enabled: bool, cx: &mut Context<Self>) {
        if let Some(chat) = self.chat.as_mut() {
            chat.handle.set_auto_accept(enabled);
        }
        cx.notify();
    }

    /// Keep the list element's measured rows in step with the transcript.
    /// A streamed token grows one row; only that row is remeasured. The list
    /// stays pinned to the newest entry while it is already at the end, so
    /// reading history is not interrupted by an arriving message.
    pub(crate) fn sync_chat_list(&mut self) {
        let Some(chat) = self.chat.as_mut() else {
            return;
        };
        let mut state = chat.state.borrow_mut();
        let count = state.state.entries.len();
        let at_end = chat.list.is_scrolled_to_end().unwrap_or(true);
        if count != chat.list_count {
            let top = chat.list.logical_scroll_top();
            chat.list.reset(count);
            chat.list_count = count;
            chat.measured_revision = state.revision;
            if at_end {
                chat.list.scroll_to_end();
            } else {
                // `reset` drops the scroll anchor; a reader who scrolled up
                // keeps their place instead of jumping to the top.
                chat.list.scroll_to(top);
            }
            return;
        }
        if chat.measured_revision != state.revision {
            let touched = std::mem::take(&mut state.touched);
            for range in ranges(&touched, count) {
                chat.list.remeasure_items(range);
            }
            chat.measured_revision = state.revision;
            if at_end {
                chat.list.scroll_to_end();
            }
        }
    }
}

/// Sorted, merged index runs, so a burst of ops on neighbouring rows costs one
/// remeasure rather than one per index.
fn ranges(indices: &[usize], count: usize) -> Vec<std::ops::Range<usize>> {
    let mut sorted: Vec<usize> = indices
        .iter()
        .copied()
        .filter(|index| *index < count)
        .collect();
    sorted.sort_unstable();
    sorted.dedup();
    let mut runs: Vec<std::ops::Range<usize>> = Vec::new();
    for index in sorted {
        match runs.last_mut() {
            Some(run) if run.end == index => run.end = index + 1,
            _ => runs.push(index..index + 1),
        }
    }
    runs
}

/// The chat's reader blocks on the socket; this thread forwards each event to
/// the window's mailbox and wakes it, so a streamed token paints at once.
fn spawn_chat_pump(
    events: Receiver<ChatEvent>,
    mailbox: Arc<Mutex<std::collections::VecDeque<ChatEvent>>>,
    wake: async_channel::Sender<()>,
) {
    thread::spawn(move || {
        while let Ok(event) = events.recv() {
            match mailbox.lock() {
                Ok(mut queue) => {
                    queue.push_back(event);
                    if queue.len() > CHAT_BACKLOG {
                        queue.pop_front();
                    }
                }
                Err(_) => break,
            }
            let _ = wake.try_send(());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn touched_rows_merge_into_one_remeasure_run() {
        assert!(ranges(&[], 10).is_empty());
        assert_eq!(ranges(&[3, 1, 2, 7], 10), vec![1..4, 7..8]);
        assert_eq!(ranges(&[0, 0, 9, 12], 10), vec![0..1, 9..10]);
    }

    #[test]
    fn a_menu_names_one_section() {
        assert_eq!(MenuKind::Modes, MenuKind::Modes);
        assert_ne!(MenuKind::Modes, MenuKind::Option(0));
    }
}
