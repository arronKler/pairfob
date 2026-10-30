//! The transcript a view holds: a snapshot plus every change applied since.
//! The rules are the contract's, not a best guess: a gap or a new epoch means
//! the view reconnects without a cursor, and a mutation that names a missing
//! entry is an error rather than a silent drop.

use std::fmt;

use super::wire::{Change, Entry, Op, State};

#[derive(Clone, Debug, Default)]
pub struct ChatState {
    pub epoch: String,
    pub seq: i64,
    pub state: State,
    /// Bumped on every applied change, so a view can tell whether the entry it
    /// last measured grew.
    pub revision: u64,
    /// Entry indices changed by the last applied change. A view remeasures
    /// only these rows; remeasuring the whole transcript on every streamed
    /// token would make scrolling quadratic.
    pub touched: Vec<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApplyError {
    EpochChanged,
    Gap { expected: i64, got: i64 },
    MissingEntry,
    DuplicateEntry,
}

impl fmt::Display for ApplyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EpochChanged => write!(f, "the transcript epoch changed"),
            Self::Gap { expected, got } => {
                write!(f, "expected change {expected}, received {got}")
            }
            Self::MissingEntry => {
                write!(f, "a change named an entry that is not in the transcript")
            }
            Self::DuplicateEntry => write!(f, "a change appended an entry id twice"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Applied {
    Applied,
    /// A change already seen. Command results are deduplicated, and a view may
    /// safely see the same change twice after a resume.
    Duplicate,
}

impl ChatState {
    /// A snapshot replaces everything, whatever the previous epoch or seq.
    pub fn apply_snapshot(&mut self, epoch: &str, seq: i64, state: State) {
        self.epoch.clear();
        self.epoch.push_str(epoch);
        self.seq = seq;
        let count = state.entries.len();
        self.state = state;
        self.revision = self.revision.wrapping_add(1);
        self.touched = (0..count).collect();
    }

    pub fn apply_change(&mut self, epoch: &str, change: &Change) -> Result<Applied, ApplyError> {
        if epoch != self.epoch {
            return Err(ApplyError::EpochChanged);
        }
        if change.seq <= self.seq {
            return Ok(Applied::Duplicate);
        }
        if change.seq != self.seq + 1 {
            return Err(ApplyError::Gap {
                expected: self.seq + 1,
                got: change.seq,
            });
        }
        self.touched.clear();
        for op in &change.ops {
            if let Some(index) = apply_op(&mut self.state, op)? {
                self.touched.push(index);
            }
        }
        self.seq = change.seq;
        self.revision = self.revision.wrapping_add(1);
        Ok(Applied::Applied)
    }

    pub fn cursor(&self) -> Option<super::wire::Cursor> {
        (!self.epoch.is_empty()).then(|| super::wire::Cursor {
            epoch: self.epoch.clone(),
            seq: self.seq,
        })
    }

    pub fn entry(&self, id: &str) -> Option<&Entry> {
        self.state.entries.iter().find(|entry| entry.id == id)
    }

    pub fn index_of(&self, id: &str) -> Option<usize> {
        self.state.entries.iter().position(|entry| entry.id == id)
    }
}

/// Applies one op. The returned index is the entry whose height may have
/// changed; state-only ops return `None`.
fn apply_op(state: &mut State, op: &Op) -> Result<Option<usize>, ApplyError> {
    match op {
        Op::AppendEntry { entry } => {
            if state.entries.iter().any(|existing| existing.id == entry.id) {
                return Err(ApplyError::DuplicateEntry);
            }
            state.entries.push(entry.clone());
            return Ok(Some(state.entries.len() - 1));
        }
        Op::SetEntry { entry } => {
            let index = index_of(state, &entry.id)?;
            state.entries[index] = entry.clone();
            return Ok(Some(index));
        }
        Op::AppendText { id, text } => {
            let index = index_of(state, id)?;
            state.entries[index].text.push_str(text);
            return Ok(Some(index));
        }
        Op::SetStreaming { id, streaming } => {
            let index = index_of(state, id)?;
            state.entries[index].streaming = *streaming;
            return Ok(Some(index));
        }
        Op::RemoveEntry { id } => {
            let index = index_of(state, id)?;
            state.entries.remove(index);
            return Ok(Some(index));
        }
        Op::SetStatus { status } => {
            state.status.clear();
            state.status.push_str(status);
        }
        Op::SetPermission { permission } => state.permission = permission.clone(),
        Op::SetPlan { plan } => state.plan = plan.clone(),
        Op::SetModes { modes, mode } => {
            state.modes = modes.clone();
            state.mode.clear();
            state.mode.push_str(mode);
        }
        Op::SetOptions { options } => state.options = options.clone(),
        Op::SetQueue { queue } => state.queue = queue.clone(),
        Op::SetAutoAccept { enabled } => state.auto_accept = *enabled,
        Op::SetTitle { title } => {
            state.title.clear();
            state.title.push_str(title);
        }
        Op::SetUsage { usage } => state.usage = usage.clone(),
        Op::SetError { error } => {
            state.error.clear();
            state.error.push_str(error);
        }
    }
    Ok(None)
}

fn index_of(state: &State, id: &str) -> Result<usize, ApplyError> {
    state
        .entries
        .iter()
        .position(|entry| entry.id == id)
        .ok_or(ApplyError::MissingEntry)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, text: &str) -> Entry {
        Entry {
            id: id.into(),
            kind: "agent".into(),
            text: text.into(),
            ..Entry::default()
        }
    }

    fn change(seq: i64, ops: Vec<Op>) -> Change {
        Change { seq, ops }
    }

    fn state_with(entries: Vec<Entry>) -> ChatState {
        let mut chat = ChatState::default();
        chat.apply_snapshot(
            "e1",
            4,
            State {
                entries,
                status: "idle".into(),
                ..State::default()
            },
        );
        chat
    }

    #[test]
    fn a_change_applies_atomically_and_advances_the_cursor() {
        let mut chat = state_with(vec![entry("a", "one")]);
        let applied = chat
            .apply_change(
                "e1",
                &change(
                    5,
                    vec![
                        Op::AppendText {
                            id: "a".into(),
                            text: " two".into(),
                        },
                        Op::SetStreaming {
                            id: "a".into(),
                            streaming: true,
                        },
                        Op::SetStatus {
                            status: "working".into(),
                        },
                    ],
                ),
            )
            .unwrap();
        assert_eq!(applied, Applied::Applied);
        assert_eq!(chat.seq, 5);
        assert_eq!(chat.state.entries[0].text, "one two");
        assert!(chat.state.entries[0].streaming);
        assert_eq!(chat.state.status, "working");
        assert_eq!(chat.cursor().unwrap().seq, 5);
    }

    #[test]
    fn a_gap_or_epoch_change_asks_for_a_fresh_snapshot() {
        let mut chat = state_with(Vec::new());
        assert_eq!(
            chat.apply_change("e1", &change(6, Vec::new())),
            Err(ApplyError::Gap {
                expected: 5,
                got: 6
            })
        );
        assert_eq!(
            chat.apply_change("e2", &change(5, Vec::new())),
            Err(ApplyError::EpochChanged)
        );
        assert_eq!(chat.seq, 4);
    }

    #[test]
    fn a_repeated_change_is_ignored_not_reapplied() {
        let mut chat = state_with(vec![entry("a", "one")]);
        let delta = change(
            5,
            vec![Op::AppendText {
                id: "a".into(),
                text: "!".into(),
            }],
        );
        assert_eq!(chat.apply_change("e1", &delta).unwrap(), Applied::Applied);
        assert_eq!(chat.apply_change("e1", &delta), Ok(Applied::Duplicate));
        assert_eq!(chat.state.entries[0].text, "one!");
    }

    #[test]
    fn a_mutation_that_names_a_missing_entry_is_an_error() {
        let mut chat = state_with(vec![entry("a", "one")]);
        assert_eq!(
            chat.apply_change(
                "e1",
                &change(
                    5,
                    vec![Op::AppendText {
                        id: "gone".into(),
                        text: "x".into(),
                    }]
                )
            ),
            Err(ApplyError::MissingEntry)
        );
        assert_eq!(chat.seq, 4, "a failed change does not advance the cursor");
    }

    #[test]
    fn the_whole_op_table_mutates_the_transcript() {
        let mut chat = state_with(Vec::new());
        let mut permission = crate::chat::wire::Permission {
            id: "0".into(),
            ..Default::default()
        };
        permission
            .options
            .push(crate::chat::wire::PermissionOption {
                id: "allow".into(),
                ..Default::default()
            });
        chat.apply_change(
            "e1",
            &change(
                5,
                vec![
                    Op::AppendEntry {
                        entry: entry("a", "x"),
                    },
                    Op::SetEntry {
                        entry: entry("a", "y"),
                    },
                    Op::SetPermission {
                        permission: Some(permission),
                    },
                    Op::SetPlan {
                        plan: vec![crate::chat::wire::PlanItem {
                            content: "step".into(),
                            ..Default::default()
                        }],
                    },
                    Op::SetModes {
                        modes: vec![crate::chat::wire::Mode {
                            id: "default".into(),
                            ..Default::default()
                        }],
                        mode: "default".into(),
                    },
                    Op::SetQueue {
                        queue: vec![crate::chat::wire::QueuedPrompt {
                            id: "q1".into(),
                            ..Default::default()
                        }],
                    },
                    Op::SetAutoAccept { enabled: true },
                    Op::SetTitle {
                        title: "claude".into(),
                    },
                    Op::SetUsage {
                        usage: Some(crate::chat::wire::Usage {
                            used: 5,
                            ..Default::default()
                        }),
                    },
                    Op::SetError {
                        error: "boom".into(),
                    },
                ],
            ),
        )
        .unwrap();
        assert_eq!(chat.state.entries[0].text, "y");
        assert!(chat.touched.contains(&0));
        assert_eq!(chat.state.permission.as_ref().unwrap().id, "0");
        assert_eq!(chat.state.plan.len(), 1);
        assert_eq!(chat.state.mode, "default");
        assert_eq!(chat.state.queue[0].id, "q1");
        assert!(chat.state.auto_accept);
        assert_eq!(chat.state.title, "claude");
        assert_eq!(chat.state.usage.as_ref().unwrap().used, 5);
        assert_eq!(chat.state.error, "boom");

        let removal = change(6, vec![Op::RemoveEntry { id: "a".into() }]);
        chat.apply_change("e1", &removal).unwrap();
        assert!(chat.state.entries.is_empty());

        let clear = change(7, vec![Op::SetPermission { permission: None }]);
        chat.apply_change("e1", &clear).unwrap();
        assert!(chat.state.permission.is_none());
    }

    #[test]
    fn an_appended_id_is_never_duplicated() {
        let mut chat = state_with(vec![entry("a", "one")]);
        assert_eq!(
            chat.apply_change(
                "e1",
                &change(
                    5,
                    vec![Op::AppendEntry {
                        entry: entry("a", "again"),
                    }]
                )
            ),
            Err(ApplyError::DuplicateEntry)
        );
    }
}
