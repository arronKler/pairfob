use super::*;

use std::sync::Arc;

use crate::app::{Connection, Notice, ServerInfo};
use crate::herdr::search::SearchOutcome;
use crate::model::{Frame, Session, Size};

fn frame(cols: u16) -> AppEvent {
    AppEvent::Frame(Arc::new(Frame {
        size: Size::new(cols, 1),
        ..Frame::default()
    }))
}

fn columns(event: &AppEvent) -> Option<u16> {
    match event {
        AppEvent::Frame(frame) => Some(frame.size.cols),
        _ => None,
    }
}

fn server(version: &str) -> AppEvent {
    AppEvent::Server(ServerInfo {
        version: version.into(),
        generation: 1,
        snapshot_codec: "snapshot".into(),
        surface_codec: "surface".into(),
        methods: Vec::new(),
        capabilities: Vec::new(),
    })
}

fn session(pane: &str) -> AppEvent {
    AppEvent::Session(Session {
        workspaces: Vec::new(),
        focused_workspace: None,
        focused_tab: None,
        focused_pane: Some(pane.into()),
    })
}

fn search(request_id: u64) -> AppEvent {
    AppEvent::Search {
        request_id,
        outcome: SearchOutcome::Stale,
    }
}

fn search_id(event: &AppEvent) -> Option<u64> {
    match event {
        AppEvent::Search { request_id, .. } => Some(*request_id),
        _ => None,
    }
}

#[test]
fn state_events_coalesce_to_the_latest_value_of_each_kind() {
    let mut queue = VecDeque::new();
    enqueue(&mut queue, frame(1));
    enqueue(&mut queue, frame(2));
    enqueue(&mut queue, AppEvent::Notice(Notice::warning("old")));
    enqueue(&mut queue, AppEvent::Notice(Notice::error("new")));
    enqueue(
        &mut queue,
        AppEvent::Connection(Connection::Reconnecting {
            attempt: 1,
            reason: "reset".into(),
        }),
    );
    enqueue(&mut queue, AppEvent::Connection(Connection::Ready));

    assert_eq!(queue.len(), 3, "one frame, one notice, one connection");
    assert_eq!(queue.front().and_then(columns), Some(2));
    assert!(matches!(
        queue.get(1),
        Some(AppEvent::Notice(notice)) if notice.text == "new"
    ));
    assert!(matches!(
        queue.get(2),
        Some(AppEvent::Connection(Connection::Ready))
    ));
}

#[test]
fn a_lone_session_is_not_evicted_by_other_state_events() {
    let mut queue = VecDeque::new();
    enqueue(&mut queue, server("1.0"));
    enqueue(&mut queue, session("w1:p1"));
    enqueue(&mut queue, AppEvent::Connection(Connection::Ready));
    for cols in 0..MAILBOX_LIMIT as u16 {
        enqueue(&mut queue, frame(cols));
    }

    assert_eq!(
        queue
            .iter()
            .filter(|event| matches!(event, AppEvent::Session(_)))
            .count(),
        1,
        "a lone session is the latest possible state and must survive"
    );
    assert!(queue
        .iter()
        .any(|event| matches!(event, AppEvent::Server(_))));
    assert!(queue
        .iter()
        .any(|event| matches!(event, AppEvent::Connection(Connection::Ready))));
}

#[test]
fn search_replies_are_not_replaced_by_state_events() {
    let mut queue = VecDeque::new();
    enqueue(&mut queue, search(7));
    enqueue(&mut queue, frame(1));
    enqueue(&mut queue, session("w1:p1"));
    enqueue(&mut queue, server("1.0"));
    enqueue(&mut queue, AppEvent::Notice(Notice::info("hello")));
    enqueue(&mut queue, AppEvent::Connection(Connection::Ready));

    assert_eq!(
        queue.iter().filter_map(search_id).collect::<Vec<_>>(),
        vec![7],
        "the search reply is still deliverable"
    );
}

#[test]
fn a_search_flood_drops_only_the_oldest_replies_and_keeps_state() {
    let mut queue = VecDeque::new();
    enqueue(&mut queue, AppEvent::Connection(Connection::Ready));
    enqueue(&mut queue, session("w1:p1"));
    enqueue(&mut queue, server("1.0"));
    for request_id in 0..MAILBOX_LIMIT as u64 {
        enqueue(&mut queue, search(request_id));
    }

    assert_eq!(queue.len(), MAILBOX_LIMIT);
    assert_eq!(
        queue.iter().filter_map(search_id).collect::<Vec<_>>(),
        (3..MAILBOX_LIMIT as u64).collect::<Vec<_>>(),
        "only the three oldest replies made room for the state events"
    );
    assert!(queue
        .iter()
        .any(|event| matches!(event, AppEvent::Connection(Connection::Ready))));
    assert!(queue
        .iter()
        .any(|event| matches!(event, AppEvent::Session(_))));
    assert!(queue
        .iter()
        .any(|event| matches!(event, AppEvent::Server(_))));
}

#[test]
fn state_still_coalesces_when_the_queue_is_at_the_bound() {
    let mut queue = VecDeque::new();
    for request_id in 0..MAILBOX_LIMIT as u64 {
        enqueue(&mut queue, search(request_id));
    }
    enqueue(
        &mut queue,
        AppEvent::Connection(Connection::Reconnecting {
            attempt: 1,
            reason: "reset".into(),
        }),
    );
    enqueue(&mut queue, AppEvent::Connection(Connection::Ready));

    assert_eq!(queue.len(), MAILBOX_LIMIT);
    assert_eq!(
        queue
            .iter()
            .filter(|event| matches!(event, AppEvent::Connection(_)))
            .count(),
        1,
        "only the latest connection transition remains"
    );
    assert_eq!(
        queue.iter().filter_map(search_id).count(),
        MAILBOX_LIMIT - 1
    );
}

#[test]
fn a_frame_before_a_search_is_not_collapsed_across_it() {
    let mut queue = VecDeque::new();
    enqueue(&mut queue, frame(1));
    enqueue(&mut queue, search(7));
    enqueue(&mut queue, frame(2));

    assert_eq!(queue.len(), 3);
    assert_eq!(columns(&queue[0]), Some(1), "the reply must see this frame");
    assert_eq!(search_id(&queue[1]), Some(7));
    assert_eq!(columns(&queue[2]), Some(2));
}

#[test]
fn frames_after_the_last_search_still_coalesce() {
    let mut queue = VecDeque::new();
    enqueue(&mut queue, frame(1));
    enqueue(&mut queue, search(7));
    enqueue(&mut queue, frame(2));
    enqueue(&mut queue, frame(3));

    assert_eq!(queue.len(), 3);
    assert_eq!(columns(&queue[0]), Some(1));
    assert_eq!(search_id(&queue[1]), Some(7));
    assert_eq!(columns(&queue[2]), Some(3));
}

#[test]
fn a_pending_ready_survives_a_later_disconnect() {
    let mut queue = VecDeque::new();
    enqueue(&mut queue, AppEvent::Connection(Connection::Ready));
    enqueue(
        &mut queue,
        AppEvent::Connection(Connection::Reconnecting {
            attempt: 1,
            reason: "reset".into(),
        }),
    );
    enqueue(
        &mut queue,
        AppEvent::Connection(Connection::Offline {
            reason: "gone".into(),
        }),
    );

    assert_eq!(queue.len(), 2);
    assert!(matches!(queue[0], AppEvent::Connection(Connection::Ready)));
    assert!(matches!(
        queue[1],
        AppEvent::Connection(Connection::Offline { .. })
    ));
}

#[test]
fn a_ready_after_a_search_stays_before_the_disconnect() {
    let mut queue = VecDeque::new();
    enqueue(&mut queue, frame(1));
    enqueue(&mut queue, search(7));
    enqueue(&mut queue, AppEvent::Connection(Connection::Ready));
    enqueue(
        &mut queue,
        AppEvent::Connection(Connection::Reconnecting {
            attempt: 1,
            reason: "reset".into(),
        }),
    );

    assert_eq!(queue.len(), 4);
    assert_eq!(columns(&queue[0]), Some(1));
    assert_eq!(search_id(&queue[1]), Some(7));
    assert!(matches!(queue[2], AppEvent::Connection(Connection::Ready)));
    assert!(matches!(
        queue[3],
        AppEvent::Connection(Connection::Reconnecting { .. })
    ));
}

#[test]
fn a_ready_before_a_search_is_still_queued() {
    let mut queue = VecDeque::new();
    enqueue(&mut queue, AppEvent::Connection(Connection::Ready));
    enqueue(&mut queue, search(7));
    enqueue(
        &mut queue,
        AppEvent::Connection(Connection::Reconnecting {
            attempt: 1,
            reason: "reset".into(),
        }),
    );

    assert_eq!(queue.len(), 3);
    assert!(matches!(queue[0], AppEvent::Connection(Connection::Ready)));
    assert_eq!(search_id(&queue[1]), Some(7));
    assert!(matches!(
        queue[2],
        AppEvent::Connection(Connection::Reconnecting { .. })
    ));
}

#[test]
fn a_newer_ready_replaces_queued_transitions() {
    let mut queue = VecDeque::new();
    enqueue(
        &mut queue,
        AppEvent::Connection(Connection::Reconnecting {
            attempt: 1,
            reason: "reset".into(),
        }),
    );
    enqueue(
        &mut queue,
        AppEvent::Connection(Connection::Offline {
            reason: "gone".into(),
        }),
    );
    enqueue(&mut queue, AppEvent::Connection(Connection::Ready));

    assert_eq!(queue.len(), 1);
    assert!(matches!(queue[0], AppEvent::Connection(Connection::Ready)));
}

#[test]
fn ready_offline_ready_still_delivers_the_side_effect() {
    let mut queue = VecDeque::new();
    enqueue(&mut queue, AppEvent::Connection(Connection::Ready));
    enqueue(
        &mut queue,
        AppEvent::Connection(Connection::Offline {
            reason: "gone".into(),
        }),
    );
    enqueue(&mut queue, AppEvent::Connection(Connection::Ready));

    assert_eq!(queue.len(), 1);
    assert!(matches!(queue[0], AppEvent::Connection(Connection::Ready)));
}

#[test]
fn each_search_keeps_the_state_of_its_own_interval() {
    let mut queue = VecDeque::new();
    enqueue(&mut queue, frame(1));
    enqueue(&mut queue, session("w1:p1"));
    enqueue(&mut queue, search(7));
    enqueue(&mut queue, frame(2));
    enqueue(&mut queue, AppEvent::Notice(Notice::info("between")));
    enqueue(&mut queue, session("w1:p2"));
    enqueue(&mut queue, search(8));
    enqueue(&mut queue, frame(3));

    assert_eq!(queue.len(), 8);
    assert_eq!(columns(&queue[0]), Some(1));
    assert!(matches!(queue[1], AppEvent::Session(_)));
    assert_eq!(search_id(&queue[2]), Some(7));
    assert_eq!(columns(&queue[3]), Some(2));
    assert!(matches!(queue[4], AppEvent::Notice(_)));
    assert!(matches!(
        &queue[5],
        AppEvent::Session(session)
            if session.focused_pane.as_ref().is_some_and(|pane| pane.as_str() == "w1:p2")
    ));
    assert_eq!(search_id(&queue[6]), Some(8));
    assert_eq!(columns(&queue[7]), Some(3));
}

#[test]
fn interleaved_frames_and_searches_stay_within_the_bound() {
    let mut queue = VecDeque::new();
    for index in 0..MAILBOX_LIMIT as u16 {
        enqueue(&mut queue, frame(index));
        assert!(queue.len() <= MAILBOX_LIMIT);
        enqueue(&mut queue, search(index as u64));
        assert!(queue.len() <= MAILBOX_LIMIT);
    }
    enqueue(&mut queue, session("w1:p1"));

    assert!(
        queue.len() <= MAILBOX_LIMIT,
        "the bound holds while frames and replies interleave"
    );
    assert!(matches!(queue.back(), Some(AppEvent::Session(_))));
    let searches: Vec<(usize, u64)> = queue
        .iter()
        .enumerate()
        .filter_map(|(index, event)| search_id(event).map(|id| (index, id)))
        .collect();
    assert_eq!(
        searches.iter().map(|(_, id)| *id).collect::<Vec<_>>(),
        (MAILBOX_LIMIT as u64 / 2 + 1..MAILBOX_LIMIT as u64).collect::<Vec<_>>(),
        "only the oldest replies made room"
    );
    for (index, id) in searches {
        assert_eq!(
            index
                .checked_sub(1)
                .and_then(|before| columns(&queue[before])),
            Some(id as u16),
            "reply {id} still sees its own frame"
        );
    }
    assert_eq!(
        queue.iter().rev().find_map(columns),
        Some(MAILBOX_LIMIT as u16 - 1),
        "the final state keeps the newest frame"
    );
}

#[test]
fn compaction_collapses_each_interval_to_what_its_reader_needs() {
    let mut queue = VecDeque::new();
    enqueue(&mut queue, frame(1));
    enqueue(&mut queue, AppEvent::Notice(Notice::info("old")));
    enqueue(&mut queue, session("w1:p1"));
    enqueue(&mut queue, server("1.0"));
    enqueue(&mut queue, search(7));
    enqueue(&mut queue, frame(2));
    enqueue(&mut queue, AppEvent::Notice(Notice::info("new")));
    enqueue(&mut queue, session("w1:p2"));
    enqueue(&mut queue, server("2.0"));
    enqueue(&mut queue, AppEvent::Connection(Connection::Ready));
    enqueue(
        &mut queue,
        AppEvent::Connection(Connection::Offline {
            reason: "gone".into(),
        }),
    );
    enqueue(&mut queue, search(8));
    enqueue(&mut queue, frame(3));

    queue.remove(4);
    compact(&mut queue);

    assert_eq!(queue.len(), 8);
    assert_eq!(columns(&queue[0]), Some(2));
    assert!(matches!(
        &queue[1],
        AppEvent::Notice(notice) if notice.text == "new"
    ));
    assert!(matches!(
        &queue[2],
        AppEvent::Session(session)
            if session.focused_pane.as_ref().is_some_and(|pane| pane.as_str() == "w1:p2")
    ));
    assert!(matches!(
        &queue[3],
        AppEvent::Server(server) if server.version == "2.0"
    ));
    assert!(matches!(queue[4], AppEvent::Connection(Connection::Ready)));
    assert!(matches!(
        queue[5],
        AppEvent::Connection(Connection::Offline { .. })
    ));
    assert_eq!(search_id(&queue[6]), Some(8));
    assert_eq!(columns(&queue[7]), Some(3));
}

#[test]
fn compaction_keeps_a_ready_that_supersedes_an_earlier_disconnect() {
    let mut queue = VecDeque::new();
    enqueue(
        &mut queue,
        AppEvent::Connection(Connection::Offline {
            reason: "gone".into(),
        }),
    );
    enqueue(&mut queue, search(1));
    enqueue(&mut queue, AppEvent::Connection(Connection::Ready));
    enqueue(&mut queue, search(2));

    queue.remove(1);
    compact(&mut queue);

    assert_eq!(queue.len(), 2);
    assert!(matches!(queue[0], AppEvent::Connection(Connection::Ready)));
    assert_eq!(search_id(&queue[1]), Some(2));
}
