//! Wheel input in the shape Herdr's own client sends it: scrollback gets one
//! event carrying the whole count, an application that reads the wheel gets
//! one single-step event per step.

use super::wire::{ClientMouseKind, ClientMousePosition, ClientPaneInputEvent};

/// A pane that reports the wheel turns each event into one report, so a large
/// count would otherwise become an unbounded batch of events.
const STEPWISE_LIMIT: u32 = 200;

/// One wire field carries at most [`u16::MAX`] lines, and a jump to the bottom
/// of a deep scrollback needs more; past this many chunks the count is capped.
const CHUNK_LIMIT: usize = 8;

/// The events for `lines` rows of scroll, positive being up into history. A
/// scrollback count above [`u16::MAX`] travels as several events; a stepwise
/// count above [`STEPWISE_LIMIT`] is dropped beyond it.
pub(crate) fn scroll_events(
    stepwise: bool,
    lines: i32,
    column: u16,
    row: u16,
) -> Vec<ClientPaneInputEvent> {
    if lines == 0 {
        return Vec::new();
    }
    let kind = if lines > 0 {
        ClientMouseKind::ScrollUp
    } else {
        ClientMouseKind::ScrollDown
    };
    let count = lines.unsigned_abs();
    if stepwise {
        return (0..count.min(STEPWISE_LIMIT))
            .map(|_| mouse_event(kind, 1, column, row))
            .collect();
    }
    let mut events = Vec::new();
    let mut left = count;
    while left > 0 && events.len() < CHUNK_LIMIT {
        let chunk = left.min(u32::from(u16::MAX)) as u16;
        events.push(mouse_event(kind, chunk, column, row));
        left -= u32::from(chunk);
    }
    events
}

fn mouse_event(kind: ClientMouseKind, lines: u16, column: u16, row: u16) -> ClientPaneInputEvent {
    ClientPaneInputEvent::Mouse {
        kind,
        position: ClientMousePosition::Cell { column, row },
        geometry: None,
        modifiers: 0,
        lines,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parts(event: &ClientPaneInputEvent) -> (ClientMouseKind, u16, u16, u16) {
        let ClientPaneInputEvent::Mouse {
            kind,
            position,
            lines,
            ..
        } = event
        else {
            panic!("expected a mouse event");
        };
        let ClientMousePosition::Cell { column, row } = position else {
            panic!("expected a cell position");
        };
        (*kind, *lines, *column, *row)
    }

    #[test]
    fn scrollback_carries_the_whole_count_in_one_event() {
        let events = scroll_events(false, 7, 3, 4);
        assert_eq!(events.len(), 1);
        assert_eq!(parts(&events[0]), (ClientMouseKind::ScrollUp, 7, 3, 4));
        let down = scroll_events(false, -7, 3, 4);
        assert_eq!(parts(&down[0]), (ClientMouseKind::ScrollDown, 7, 3, 4));
    }

    #[test]
    fn a_count_above_the_wire_field_splits_into_whole_chunks() {
        let events = scroll_events(false, 200_000, 0, 0);
        assert_eq!(events.len(), 4);
        assert_eq!(parts(&events[0]).1, u16::MAX);
        assert_eq!(parts(&events[1]).1, u16::MAX);
        assert_eq!(
            parts(&events[3]).1,
            (200_000 - 3 * u32::from(u16::MAX)) as u16
        );
        assert_eq!(scroll_events(false, i32::MIN, 0, 0).len(), CHUNK_LIMIT);
    }

    #[test]
    fn a_wheel_reading_pane_gets_one_single_step_event_per_line() {
        let events = scroll_events(true, 3, 1, 2);
        assert_eq!(events.len(), 3);
        assert!(events
            .iter()
            .all(|event| parts(event) == (ClientMouseKind::ScrollUp, 1, 1, 2)));
        assert_eq!(scroll_events(true, -3, 1, 2).len(), 3);
        assert!(scroll_events(true, -3, 1, 2)
            .iter()
            .all(|event| parts(event).0 == ClientMouseKind::ScrollDown));
    }

    #[test]
    fn a_stepwise_batch_is_capped_and_no_lines_means_no_events() {
        assert_eq!(scroll_events(true, 1_000, 0, 0).len(), 200);
        assert!(scroll_events(false, 0, 0, 0).is_empty());
        assert!(scroll_events(true, 0, 0, 0).is_empty());
    }
}
