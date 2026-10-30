//! The endpoint drops input sent to a pane that is not in the focused tab,
//! and answers `Ok(())` while doing it. The gate replaces that silent drop
//! with an ordered focus-then-send: queue the keystrokes, ask for focus, flush
//! only once a frame reports the target focused.

use std::time::{Duration, Instant};

use crate::model::PaneId;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyCode {
    Enter,
    Escape,
    Tab,
    Backspace,
    Delete,
    Insert,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    Char(char),
    Function(u8),
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Modifiers {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub platform: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeyInput {
    /// Text committed by the keyboard or an input method.
    Text(String),
    Paste(String),
    Key {
        code: KeyCode,
        modifiers: Modifiers,
    },
}

/// What the caller should do after handing the gate input.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Submit {
    SendNow {
        pane: PaneId,
        inputs: Vec<KeyInput>,
    },
    FocusThenSend {
        pane: PaneId,
        /// Inputs discarded because the operator moved to another pane while
        /// the previous focus request was still in flight.
        dropped: usize,
    },
    Queued,
}

/// What happened to the pending batch after a frame or a tick.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GateOutcome {
    Idle,
    Flush {
        pane: PaneId,
        inputs: Vec<KeyInput>,
    },
    /// The pane never became focused. The batch is gone; the caller reports it.
    TimedOut {
        pane: PaneId,
        dropped: usize,
    },
}

struct Pending {
    pane: PaneId,
    inputs: Vec<KeyInput>,
    since: Instant,
}

pub struct InputGate {
    focused: Option<PaneId>,
    pending: Option<Pending>,
    timeout: Duration,
}

impl InputGate {
    pub fn new(timeout: Duration) -> Self {
        Self {
            focused: None,
            pending: None,
            timeout,
        }
    }

    pub fn focused(&self) -> Option<&PaneId> {
        self.focused.as_ref()
    }

    pub fn is_pending(&self) -> bool {
        self.pending.is_some()
    }

    pub fn submit(&mut self, pane: &PaneId, inputs: Vec<KeyInput>, now: Instant) -> Submit {
        if inputs.is_empty() {
            return Submit::Queued;
        }
        if self.pending.is_none() && self.focused.as_ref() == Some(pane) {
            return Submit::SendNow {
                pane: pane.clone(),
                inputs,
            };
        }
        match &mut self.pending {
            Some(pending) if &pending.pane == pane => {
                pending.inputs.extend(inputs);
                Submit::Queued
            }
            Some(pending) => {
                let dropped = pending.inputs.len();
                *pending = Pending {
                    pane: pane.clone(),
                    inputs,
                    since: now,
                };
                Submit::FocusThenSend {
                    pane: pane.clone(),
                    dropped,
                }
            }
            None => {
                self.pending = Some(Pending {
                    pane: pane.clone(),
                    inputs,
                    since: now,
                });
                Submit::FocusThenSend {
                    pane: pane.clone(),
                    dropped: 0,
                }
            }
        }
    }

    /// A surface frame arrived. Flushes the pending batch when the frame
    /// reports its pane focused.
    pub fn observe(&mut self, focused: Option<&PaneId>, _now: Instant) -> GateOutcome {
        self.focused = focused.cloned();
        let ready = matches!(
            (&self.pending, focused),
            (Some(pending), Some(focused)) if &pending.pane == focused
        );
        if !ready {
            return GateOutcome::Idle;
        }
        let pending = self.pending.take().expect("checked above");
        GateOutcome::Flush {
            pane: pending.pane,
            inputs: pending.inputs,
        }
    }

    /// Frames do not arrive while a switch is stuck, so expiry is polled.
    pub fn tick(&mut self, now: Instant) -> GateOutcome {
        let expired = self
            .pending
            .as_ref()
            .is_some_and(|pending| now.duration_since(pending.since) >= self.timeout);
        if !expired {
            return GateOutcome::Idle;
        }
        let pending = self.pending.take().expect("checked above");
        GateOutcome::TimedOut {
            pane: pending.pane,
            dropped: pending.inputs.len(),
        }
    }

    /// Dropping the connection must not leave keys to arrive later.
    pub fn cancel(&mut self) -> Option<PaneId> {
        self.focused = None;
        self.pending.take().map(|pending| pending.pane)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TIMEOUT: Duration = Duration::from_secs(2);

    fn gate() -> (InputGate, Instant) {
        let now = Instant::now();
        let mut gate = InputGate::new(TIMEOUT);
        gate.observe(Some(&"w1:p1".into()), now);
        (gate, now)
    }

    fn text(value: &str) -> KeyInput {
        KeyInput::Text(value.into())
    }

    #[test]
    fn input_to_the_focused_pane_is_sent_immediately() {
        let (mut gate, now) = gate();
        let submit = gate.submit(&"w1:p1".into(), vec![text("a")], now);
        assert_eq!(
            submit,
            Submit::SendNow {
                pane: "w1:p1".into(),
                inputs: vec![text("a")]
            }
        );
    }

    #[test]
    fn input_to_another_pane_waits_for_its_frame() {
        let (mut gate, now) = gate();
        let submit = gate.submit(&"w1:p2".into(), vec![text("b")], now);
        assert_eq!(
            submit,
            Submit::FocusThenSend {
                pane: "w1:p2".into(),
                dropped: 0
            }
        );
        assert_eq!(
            gate.observe(Some(&"w1:p1".into()), now),
            GateOutcome::Idle,
            "the old pane's frame must not flush the new target"
        );
        assert_eq!(
            gate.observe(Some(&"w1:p2".into()), now),
            GateOutcome::Flush {
                pane: "w1:p2".into(),
                inputs: vec![text("b")]
            }
        );
        assert!(!gate.is_pending());
    }

    #[test]
    fn keystrokes_typed_during_the_switch_keep_their_order() {
        let (mut gate, now) = gate();
        gate.submit(&"w1:p2".into(), vec![text("l")], now);
        let second = gate.submit(&"w1:p2".into(), vec![text("s")], now);
        assert_eq!(second, Submit::Queued);
        assert_eq!(
            gate.observe(Some(&"w1:p2".into()), now),
            GateOutcome::Flush {
                pane: "w1:p2".into(),
                inputs: vec![text("l"), text("s")]
            }
        );
    }

    #[test]
    fn moving_to_another_pane_replaces_the_pending_batch() {
        let (mut gate, now) = gate();
        gate.submit(&"w1:p2".into(), vec![text("lost")], now);
        let submit = gate.submit(&"w2:p1".into(), vec![text("kept")], now);
        assert_eq!(
            submit,
            Submit::FocusThenSend {
                pane: "w2:p1".into(),
                dropped: 1
            }
        );
        assert_eq!(
            gate.observe(Some(&"w2:p1".into()), now),
            GateOutcome::Flush {
                pane: "w2:p1".into(),
                inputs: vec![text("kept")]
            }
        );
    }

    #[test]
    fn a_stuck_switch_times_out_instead_of_holding_keys() {
        let (mut gate, now) = gate();
        gate.submit(&"w1:p2".into(), vec![text("x"), text("y")], now);
        assert_eq!(gate.tick(now + TIMEOUT / 2), GateOutcome::Idle);
        assert_eq!(
            gate.tick(now + TIMEOUT),
            GateOutcome::TimedOut {
                pane: "w1:p2".into(),
                dropped: 2
            }
        );
        assert_eq!(gate.observe(Some(&"w1:p2".into()), now), GateOutcome::Idle);
    }

    #[test]
    fn a_new_frame_updates_which_pane_is_sent_immediately() {
        let (mut gate, now) = gate();
        gate.observe(Some(&"w1:p2".into()), now);
        assert_eq!(
            gate.submit(&"w1:p2".into(), vec![text("z")], now),
            Submit::SendNow {
                pane: "w1:p2".into(),
                inputs: vec![text("z")]
            }
        );
    }

    #[test]
    fn cancelling_forgets_the_pending_batch_and_the_focus() {
        let (mut gate, now) = gate();
        gate.submit(&"w1:p2".into(), vec![text("x")], now);
        assert_eq!(gate.cancel(), Some("w1:p2".into()));
        assert!(gate.focused().is_none());
        assert!(!gate.is_pending());
        assert_eq!(
            gate.submit(&"w1:p1".into(), vec![text("x")], now),
            Submit::FocusThenSend {
                pane: "w1:p1".into(),
                dropped: 0
            }
        );
    }
}
