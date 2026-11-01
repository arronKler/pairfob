//! The workspace, tab, pane, and agent snapshot.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientShellSnapshot {
    pub boot_id: String,
    pub revision: u64,
    pub config_diagnostic: Option<String>,
    pub product_announcement: Option<ClientShellProductAnnouncement>,
    pub update_available: Option<String>,
    pub update_install_command: String,
    pub server_keybindings_toml: Option<String>,
    pub latest_release_notes_available: bool,
    pub integration_updates_available: bool,
    pub worktree_directory: String,
    pub release_notes: Option<ClientShellReleaseNotes>,
    pub focused_workspace_id: Option<String>,
    pub focused_tab_id: Option<String>,
    pub focused_pane_id: Option<String>,
    pub tab_bar_right: Vec<ClientShellTabStatusSegment>,
    pub tab_bar_right_separator: String,
    pub agent_view_label: Option<String>,
    pub agent_order: Vec<String>,
    pub workspaces: Vec<ClientShellWorkspace>,
    pub tabs: Vec<ClientShellTab>,
    pub panes: Vec<ClientShellPane>,
    pub agents: Vec<ClientShellAgent>,
    pub commands: Vec<ClientShellCommand>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientShellProductAnnouncement {
    pub version: String,
    pub id: String,
    pub title: String,
    pub body: String,
    pub preview: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientShellReleaseNotes {
    pub version: String,
    pub body: String,
    pub preview: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClientShellCommandAction {
    Shell,
    Pane,
    Popup,
    PluginAction,
    /// A newer Herdr may add an action this build does not run. The snapshot
    /// still parses so the rest of the workspace keeps working.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientShellCommand {
    pub command_id: String,
    pub binding_label: String,
    pub binding_labels: Vec<String>,
    pub action: ClientShellCommandAction,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientShellTabStatusSegment {
    pub text: String,
    pub accent: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientShellWorkspace {
    pub workspace_id: String,
    pub active_tab_id: String,
    pub new_workspace_cwd: String,
    pub number: usize,
    pub label: String,
    pub custom_label: bool,
    pub branch: Option<String>,
    pub git_ahead_behind: Option<(usize, usize)>,
    pub tokens: Vec<(String, String)>,
    pub worktree: Option<ClientShellWorktree>,
    pub focused: bool,
    #[serde(deserialize_with = "deserialize_agent_status")]
    pub agent_status: AgentStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientShellWorktree {
    pub key: String,
    pub label: String,
    pub is_linked_worktree: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientShellTab {
    pub tab_id: String,
    pub workspace_id: String,
    pub number: usize,
    pub label: String,
    pub custom_label: bool,
    pub zoomed: bool,
    pub focused: bool,
    #[serde(deserialize_with = "deserialize_agent_status")]
    pub agent_status: AgentStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientShellPane {
    pub pane_id: String,
    pub workspace_id: String,
    pub tab_id: String,
    pub label: Option<String>,
    pub cwd: Option<String>,
    pub foreground_cwd: Option<String>,
    pub focused: bool,
    pub right_click_passthrough: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientShellAgent {
    pub pane_id: String,
    pub workspace_id: String,
    pub tab_id: String,
    pub name: Option<String>,
    pub display_agent: Option<String>,
    pub agent: Option<String>,
    pub title: Option<String>,
    pub terminal_title: Option<String>,
    pub terminal_title_stripped: Option<String>,
    #[serde(deserialize_with = "deserialize_agent_status")]
    pub agent_status: AgentStatus,
    pub state_change_seq: u64,
    pub state_labels: Vec<(String, String)>,
    pub tokens: Vec<(String, String)>,
    pub focused: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Idle,
    Working,
    Blocked,
    Done,
    Unknown,
}

/// Herdr adds agent states over time. A state this build does not know is
/// `Unknown`, not a reason to reject the whole snapshot.
fn deserialize_agent_status<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<AgentStatus, D::Error> {
    if !deserializer.is_human_readable() {
        return AgentStatus::deserialize(deserializer);
    }
    Ok(match String::deserialize(deserializer)?.as_str() {
        "idle" => AgentStatus::Idle,
        "working" => AgentStatus::Working,
        "blocked" => AgentStatus::Blocked,
        "done" => AgentStatus::Done,
        _ => AgentStatus::Unknown,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Status {
        #[serde(deserialize_with = "deserialize_agent_status")]
        agent_status: AgentStatus,
    }

    #[test]
    fn a_new_agent_state_from_a_newer_herdr_reads_as_unknown() {
        let status: Status = serde_json::from_str(r#"{"agent_status":"reviewing"}"#).unwrap();
        assert_eq!(status.agent_status, AgentStatus::Unknown);

        let status: Status = serde_json::from_str(r#"{"agent_status":"working"}"#).unwrap();
        assert_eq!(status.agent_status, AgentStatus::Working);
    }

    #[test]
    fn an_action_this_build_does_not_know_keeps_the_snapshot() {
        let action: ClientShellCommandAction = serde_json::from_str(r#""RevealPane""#).unwrap();
        assert_eq!(action, ClientShellCommandAction::Unknown);
        let action: ClientShellCommandAction = serde_json::from_str(r#""PluginAction""#).unwrap();
        assert_eq!(action, ClientShellCommandAction::PluginAction);
    }
}
