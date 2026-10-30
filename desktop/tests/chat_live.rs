//! Live check against a running `pairfob-chat` process. Ignored by default:
//! it needs a real socket, and it types into the agent. Run with
//!
//! ```text
//! PF_CHAT_ID=<id> cargo test --test chat_live -- --ignored --nocapture
//! ```

use std::time::{Duration, Instant};

use pairfob_desktop::chat::{attach, ChatEvent, ChatState};

fn id_from_env() -> String {
    std::env::var("PF_CHAT_ID").expect("set PF_CHAT_ID to the id pairfob-chat printed")
}

#[test]
#[ignore = "needs a running pairfob-chat process"]
fn a_chat_process_answers_a_prompt_and_a_permission() {
    let id = id_from_env();
    let connection = attach(&id, None).expect("attach to pairfob-chat");
    let mut state = ChatState::default();
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut prompted = false;
    let mut answered = false;
    let mut done = false;

    while Instant::now() < deadline && !done {
        let Ok(event) = connection.events.recv_timeout(Duration::from_millis(200)) else {
            continue;
        };
        match event {
            ChatEvent::Snapshot {
                epoch,
                seq,
                state: snapshot,
            } => {
                state.apply_snapshot(&epoch, seq, *snapshot);
                eprintln!(
                    "snapshot: status={} modes={} options={} entries={}",
                    state.state.status,
                    state.state.modes.len(),
                    state.state.options.len(),
                    state.state.entries.len()
                );
                if !prompted {
                    assert!(connection.handle.prompt("make the fake change"));
                    prompted = true;
                }
            }
            ChatEvent::Changes { epoch, changes } => {
                for change in &changes {
                    state.apply_change(&epoch, change).expect("apply change");
                }
                if let Some(permission) = state.state.permission.as_ref() {
                    if !answered {
                        let option = permission.options.first().expect("permission options");
                        assert!(
                            connection.handle.answer(&permission.id, &option.id),
                            "answer the permission"
                        );
                        answered = true;
                    }
                }
                done = state.state.status == "idle"
                    && state
                        .state
                        .entries
                        .iter()
                        .any(|entry| entry.text.contains("Done."));
            }
            ChatEvent::Result { ok, error, .. } => {
                assert!(ok, "command failed: {error:?}");
            }
            ChatEvent::Welcome { .. } => {}
            ChatEvent::Closed(reason) => panic!("chat closed: {reason}"),
        }
    }

    for entry in &state.state.entries {
        eprintln!("{:>7} {}: {}", entry.kind, entry.id, entry.text);
    }
    assert!(prompted, "no snapshot arrived");
    assert!(answered, "the agent never asked for permission");
    assert!(done, "the agent never finished the turn");
    assert!(state.state.entries.iter().any(|entry| {
        entry.kind == "tool"
            && entry
                .tool
                .as_ref()
                .is_some_and(|tool| !tool.title.is_empty())
    }));
    assert_eq!(state.state.status, "idle");
}
