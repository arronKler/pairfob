//! The window's bounded event mailbox. The engine thread enqueues events and
//! the UI tick drains them; a stalled window must not grow memory without
//! limit.
//!
//! Most events describe current state, so only the latest value of each kind
//! is kept: replacing an older frame or session is safe because the newer
//! value is what `App::apply` would settle on. A `Connection::Ready` is
//! different because consuming it calls `Boot::connected`; a pending Ready is
//! therefore kept even when a later disconnect is queued behind it.
//!
//! Search replies are one-shot: each one reads `App` state at its position in
//! the queue. State before the last queued reply is therefore never collapsed
//! across it, so a reply still sees the frame the search was issued against.
//! State after the last reply can be collapsed freely. In practice the find
//! bar holds one pending search; the hard bound only drops the oldest reply if
//! thousands are ever queued, and the find bar's request timeout then makes
//! the search retryable. Dropping a reply re-collapses the intervals it used
//! to protect, so interleaving state and replies cannot defeat the bound.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::thread;

use crossbeam_channel::Receiver;

use crate::app::{AppEvent, Connection};

/// Enough headroom for a long paint stall; the bound only exists so a window
/// that never drains cannot grow without limit.
const MAILBOX_LIMIT: usize = 2048;

fn is_search(event: &AppEvent) -> bool {
    matches!(event, AppEvent::Search { .. })
}

fn is_connection(event: &AppEvent) -> bool {
    matches!(event, AppEvent::Connection(_))
}

fn is_ready(event: &AppEvent) -> bool {
    matches!(event, AppEvent::Connection(Connection::Ready))
}

fn same_kind(left: &AppEvent, right: &AppEvent) -> bool {
    std::mem::discriminant(left) == std::mem::discriminant(right)
}

/// State at or before a queued search reply is what that reply will read, so
/// only events after the last reply may be collapsed.
fn coalescing_start(queue: &VecDeque<AppEvent>) -> usize {
    queue
        .iter()
        .rposition(is_search)
        .map_or(0, |index| index + 1)
}

/// Collapse one stretch of state between search replies to what it still
/// contributes: the latest event of each state kind, plus enough connection
/// history to keep a `Ready` side effect and the final connection value.
fn compact_interval(interval: &mut Vec<AppEvent>, out: &mut VecDeque<AppEvent>) {
    let mut server = None;
    let mut session = None;
    let mut frame = None;
    let mut notice = None;
    let mut ready = None;
    let mut transition = None;
    for (index, event) in interval.iter().enumerate() {
        match event {
            AppEvent::Server(_) => server = Some(index),
            AppEvent::Session(_) => session = Some(index),
            AppEvent::Frame(_) => frame = Some(index),
            AppEvent::Notice(_) => notice = Some(index),
            AppEvent::Connection(Connection::Ready) => ready = Some(index),
            AppEvent::Connection(_) => transition = Some(index),
            AppEvent::Search { .. } => unreachable!("intervals exclude search replies"),
        }
    }
    let mut keep: Vec<usize> = [server, session, frame, notice]
        .into_iter()
        .flatten()
        .collect();
    match ready {
        // Anything before the last Ready is superseded by it. A disconnect
        // after it is the connection value the next reply must observe.
        Some(ready) => {
            keep.push(ready);
            if let Some(transition) = transition.filter(|index| *index > ready) {
                keep.push(transition);
            }
        }
        None => keep.extend(transition),
    }
    keep.sort_unstable();
    keep.dedup();

    let mut keep = keep.into_iter().peekable();
    for (index, event) in interval.drain(..).enumerate() {
        if keep.peek() == Some(&index) {
            keep.next();
            out.push_back(event);
        }
    }
}

/// Re-collapse every interval after a boundary search reply was dropped. The
/// state that the dropped reply protected is now shared with the next interval,
/// so without this pass repeated interleaving would defeat the bound.
fn compact(queue: &mut VecDeque<AppEvent>) {
    let mut compacted = VecDeque::with_capacity(queue.len());
    let mut interval = Vec::new();
    for event in queue.drain(..) {
        if is_search(&event) {
            compact_interval(&mut interval, &mut compacted);
            compacted.push_back(event);
        } else {
            interval.push(event);
        }
    }
    compact_interval(&mut interval, &mut compacted);
    *queue = compacted;
}

/// Enqueue one event, collapsing only state that no queued search reply can
/// still observe. If the queue reaches its bound, the oldest search reply is
/// dropped and the remaining intervals are re-compacted; a state event is only
/// removed when a later event of the same kind supersedes it.
fn enqueue(queue: &mut VecDeque<AppEvent>, event: AppEvent) {
    let start = coalescing_start(queue);
    match &event {
        AppEvent::Search { .. } => {}
        AppEvent::Connection(Connection::Ready) => {
            // A newer Ready carries the same side effect, so it may replace
            // queued connection events after the last reply.
            let mut index = start;
            while index < queue.len() {
                if is_connection(&queue[index]) {
                    queue.remove(index);
                } else {
                    index += 1;
                }
            }
        }
        AppEvent::Connection(_) => {
            // Keep a pending Ready (its side effect has not run yet); replace
            // only a pending non-Ready transition after the last reply.
            let existing = queue
                .iter()
                .enumerate()
                .skip(start)
                .find_map(|(index, queued)| {
                    (is_connection(queued) && !is_ready(queued)).then_some(index)
                });
            if let Some(index) = existing {
                queue.remove(index);
            }
        }
        _ => {
            let existing = queue
                .iter()
                .enumerate()
                .skip(start)
                .find_map(|(index, queued)| same_kind(queued, &event).then_some(index));
            if let Some(index) = existing {
                queue.remove(index);
            }
        }
    }
    queue.push_back(event);
    if queue.len() > MAILBOX_LIMIT {
        let oldest = queue.iter().position(is_search);
        debug_assert!(
            oldest.is_some(),
            "state events coalesce; only search replies can exceed the bound"
        );
        if let Some(index) = oldest {
            queue.remove(index);
            compact(queue);
        }
    }
}

#[cfg_attr(not(feature = "gui"), allow(dead_code))]
pub(crate) fn spawn_pump(
    events: Receiver<AppEvent>,
    mailbox: Arc<Mutex<VecDeque<AppEvent>>>,
    wake: async_channel::Sender<()>,
) {
    thread::spawn(move || {
        while let Ok(event) = events.recv() {
            match mailbox.lock() {
                Ok(mut queue) => enqueue(&mut queue, event),
                Err(_) => break,
            }
            // A full wake channel already has an unmatched signal, which is
            // all this task needs to drain whatever arrived in the meantime.
            let _ = wake.try_send(());
        }
    });
}

#[cfg(test)]
mod tests;
