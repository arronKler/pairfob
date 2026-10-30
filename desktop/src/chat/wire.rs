//! The pairfob-chat.v1 frames, as frozen in `proto/pairfob-chat.md`. One JSON
//! object per line; every field name matches the Go implementation so the two
//! ends stay interchangeable.

use serde::{Deserialize, Serialize};

pub const VERSION: i64 = 1;
/// One line on the wire, and one text field. The server enforces the same cap.
pub const MAX_LINE: usize = 4 << 20;

/// The last change a view applied, sent in the hello.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cursor {
    pub epoch: String,
    pub seq: i64,
}

/// A process-to-view frame. An unknown `type` is a protocol error and closes
/// the connection rather than being guessed at.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerFrame {
    Welcome {
        #[serde(default)]
        v: i64,
        epoch: String,
        seq: i64,
    },
    Snapshot {
        #[serde(default)]
        v: i64,
        epoch: String,
        seq: i64,
        state: Box<State>,
    },
    Changes {
        #[serde(default)]
        v: i64,
        epoch: String,
        seq: i64,
        changes: Vec<Change>,
    },
    Result {
        #[serde(default)]
        v: i64,
        id: String,
        ok: bool,
        #[serde(default)]
        error: Option<FrameError>,
    },
    Ping {
        #[serde(default)]
        v: i64,
    },
    Pong {
        #[serde(default)]
        v: i64,
    },
}

impl ServerFrame {
    pub fn version(&self) -> i64 {
        match self {
            Self::Welcome { v, .. }
            | Self::Snapshot { v, .. }
            | Self::Changes { v, .. }
            | Self::Result { v, .. }
            | Self::Ping { v }
            | Self::Pong { v } => *v,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FrameError {
    pub code: String,
    pub message: String,
}

/// A view-to-process frame. `hello` is always first, and carries a `null`
/// cursor when the view has none.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientFrame {
    Hello {
        v: i64,
        client: &'static str,
        cursor: Option<Cursor>,
    },
    Command {
        v: i64,
        id: String,
        command: Command,
    },
    Ping {
        v: i64,
    },
    Pong {
        v: i64,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Command {
    Prompt {
        #[serde(skip_serializing_if = "String::is_empty")]
        text: String,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        attachments: Vec<Attachment>,
    },
    Cancel,
    Answer {
        request_id: String,
        option_id: String,
    },
    SetMode {
        mode_id: String,
    },
    SetOption {
        option_id: String,
        value: String,
    },
    Unqueue {
        queue_id: String,
    },
    SetAutoAccept {
        enabled: bool,
    },
}

/// Only image attachments are forwarded by the server; the view never invents
/// a mime type it was not given.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Attachment {
    pub name: String,
    pub mime: String,
    pub data: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct State {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub agent: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub entries: Vec<Entry>,
    #[serde(default)]
    pub permission: Option<Permission>,
    #[serde(default)]
    pub plan: Vec<PlanItem>,
    #[serde(default)]
    pub modes: Vec<Mode>,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub options: Vec<ConfigOption>,
    #[serde(default)]
    pub queue: Vec<QueuedPrompt>,
    #[serde(default)]
    pub auto_accept: bool,
    #[serde(default)]
    pub usage: Option<Usage>,
    #[serde(default)]
    pub error: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Entry {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub streaming: bool,
    #[serde(default)]
    pub level: String,
    #[serde(default)]
    pub tool: Option<Tool>,
    #[serde(default)]
    pub at: i64,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Tool {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub content: Vec<ToolContent>,
    #[serde(default)]
    pub locations: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct ToolContent {
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub old: String,
    #[serde(default)]
    pub new: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Permission {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub tool_call_id: String,
    #[serde(default)]
    pub options: Vec<PermissionOption>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct PermissionOption {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub kind: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct PlanItem {
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub priority: String,
    #[serde(default)]
    pub status: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Mode {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct ConfigOption {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub current_value: String,
    #[serde(default)]
    pub choices: Vec<OptionChoice>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct OptionChoice {
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct QueuedPrompt {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub text: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Usage {
    #[serde(default)]
    pub used: i64,
    #[serde(default)]
    pub size: i64,
    #[serde(default)]
    pub cost_usd: f64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Change {
    pub seq: i64,
    #[serde(default)]
    pub ops: Vec<Op>,
}

/// One mutation. Payload fields are optional on the wire; a missing field and
/// an explicit null both mean the zero value, and `set_permission` treats both
/// as a clear.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    AppendEntry {
        entry: Entry,
    },
    SetEntry {
        entry: Entry,
    },
    AppendText {
        id: String,
        #[serde(default)]
        text: String,
    },
    SetStreaming {
        id: String,
        #[serde(default)]
        streaming: bool,
    },
    RemoveEntry {
        id: String,
    },
    SetStatus {
        #[serde(default)]
        status: String,
    },
    SetPermission {
        #[serde(default)]
        permission: Option<Permission>,
    },
    SetPlan {
        #[serde(default)]
        plan: Vec<PlanItem>,
    },
    SetModes {
        #[serde(default)]
        modes: Vec<Mode>,
        #[serde(default)]
        mode: String,
    },
    SetOptions {
        #[serde(default)]
        options: Vec<ConfigOption>,
    },
    SetQueue {
        #[serde(default)]
        queue: Vec<QueuedPrompt>,
    },
    SetAutoAccept {
        #[serde(default)]
        enabled: bool,
    },
    SetTitle {
        #[serde(default)]
        title: String,
    },
    SetUsage {
        #[serde(default)]
        usage: Option<Usage>,
    },
    SetError {
        #[serde(default)]
        error: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_snapshot_parses_with_every_documented_field() {
        let json = r#"{"v":1,"type":"snapshot","epoch":"9f2c","seq":42,"state":{
            "id":"0123456789abcdef","title":"claude · pairfob","agent":"claude",
            "status":"working","entries":[
              {"id":"user-1","kind":"user","text":"fix it","streaming":false,"at":1},
              {"id":"t1","kind":"tool","text":"","streaming":false,"level":"warning",
               "tool":{"title":"Edit","kind":"edit","status":"completed",
                       "content":[{"type":"diff","path":"a.rs","old":"x","new":"y"}],
                       "locations":["a.rs"]},"at":2}],
            "permission":{"id":"0","title":"Allow?","tool_call_id":"t1",
              "options":[{"id":"allow","name":"Allow","kind":"allow_once"}]},
            "plan":[{"content":"step","priority":"high","status":"pending"}],
            "modes":[{"id":"default","name":"Default","description":""}],
            "mode":"default",
            "options":[{"id":"model","name":"Model","category":"model",
              "current_value":"sonnet","choices":[{"value":"sonnet","name":"Sonnet","description":""}]}],
            "queue":[{"id":"q1","text":"later"}],
            "auto_accept":false,"usage":{"used":10,"size":100,"cost_usd":0.16},"error":""}}"#;
        let frame: ServerFrame = serde_json::from_str(json).unwrap();
        assert_eq!(frame.version(), 1);
        let ServerFrame::Snapshot { state, .. } = frame else {
            panic!("not a snapshot");
        };
        assert_eq!(state.entries.len(), 2);
        assert_eq!(
            state.entries[1].tool.as_ref().unwrap().content[0].kind,
            "diff"
        );
        assert_eq!(state.permission.as_ref().unwrap().options[0].id, "allow");
        assert_eq!(state.options[0].choices[0].value, "sonnet");
        assert_eq!(state.usage.unwrap().cost_usd, 0.16);
    }

    #[test]
    fn every_change_op_parses() {
        let ops = [
            r#"{"op":"append_entry","entry":{"id":"a","kind":"agent","text":"x","streaming":true,"at":0}}"#,
            r#"{"op":"set_entry","entry":{"id":"a","kind":"agent","text":"x","at":0}}"#,
            r#"{"op":"append_text","id":"a","text":" more"}"#,
            r#"{"op":"set_streaming","id":"a","streaming":false}"#,
            r#"{"op":"remove_entry","id":"a"}"#,
            r#"{"op":"set_status","status":"idle"}"#,
            r#"{"op":"set_permission","permission":null}"#,
            r#"{"op":"set_plan","plan":[]}"#,
            r#"{"op":"set_modes","modes":[],"mode":"default"}"#,
            r#"{"op":"set_options","options":[]}"#,
            r#"{"op":"set_queue","queue":[]}"#,
            r#"{"op":"set_auto_accept","enabled":true}"#,
            r#"{"op":"set_title","title":"t"}"#,
            r#"{"op":"set_usage","usage":null}"#,
            r#"{"op":"set_error","error":""}"#,
        ];
        for op in ops {
            serde_json::from_str::<Op>(op).unwrap_or_else(|error| panic!("{op}: {error}"));
        }
        let clear: Op = serde_json::from_str(r#"{"op":"set_permission"}"#).unwrap();
        assert!(matches!(clear, Op::SetPermission { permission: None }));
    }

    #[test]
    fn a_command_carries_only_the_fields_its_kind_uses() {
        let frame = ClientFrame::Command {
            v: VERSION,
            id: "c1".into(),
            command: Command::Prompt {
                text: "fix the test".into(),
                attachments: Vec::new(),
            },
        };
        let json = serde_json::to_value(&frame).unwrap();
        assert_eq!(json["type"], "command");
        assert_eq!(json["command"]["kind"], "prompt");
        assert_eq!(json["command"]["text"], "fix the test");
        assert!(json["command"].get("attachments").is_none());
        assert_eq!(
            serde_json::to_value(Command::Cancel).unwrap(),
            serde_json::json!({"kind": "cancel"})
        );
    }

    #[test]
    fn a_hello_always_carries_a_cursor_field() {
        let frame = ClientFrame::Hello {
            v: VERSION,
            client: "pairfob-desktop",
            cursor: None,
        };
        let json = serde_json::to_value(&frame).unwrap();
        assert_eq!(json["type"], "hello");
        assert!(json["cursor"].is_null());
        assert_eq!(json["client"], "pairfob-desktop");
    }

    #[test]
    fn an_unknown_type_is_rejected_instead_of_guessed() {
        assert!(serde_json::from_str::<ServerFrame>(r#"{"v":1,"type":"nope"}"#).is_err());
    }
}
