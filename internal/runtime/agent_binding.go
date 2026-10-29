package runtime

// Local hook bindings supplement Herdr's native integrations. They never pass
// through display metadata or the phone protocol. A record is useful only while
// its exact terminal and foreground process generation are still alive.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

var localSessionID = regexp.MustCompile(`^[0-9A-Za-z_-]{8,128}$`)

type AgentBindingReport struct {
	Agent     string
	SessionID string
	Sequence  int64
	Clear     bool
	Leaf      *string
	Activity  *PaneActivity
}

type localAgentBinding struct {
	Version    int           `json:"version"`
	Agent      string        `json:"agent"`
	SessionID  string        `json:"session_id"`
	TerminalID string        `json:"terminal_id"`
	ProcessID  int           `json:"process_id"`
	Birth      string        `json:"birth"`
	Sequence   int64         `json:"sequence"`
	Cleared    bool          `json:"cleared"`
	Leaf       *string       `json:"leaf,omitempty"`
	Activity   *PaneActivity `json:"activity,omitempty"`
}

func localBindingAgent(agent string) bool {
	return agent == "cmd" || agent == "gemini" || agent == "cline" || agent == "amp" || agent == "maki"
}

func (h *Herdr) bindingPath(session SessionRef, terminalID string) (string, error) {
	socket, err := h.socketFor(session)
	if err != nil || h.ConfigRoot == "" || terminalID == "" {
		return "", errors.New("local binding location unavailable")
	}
	sum := sha256.Sum256([]byte(filepath.Clean(socket) + "\x00" + terminalID))
	return filepath.Join(h.ConfigRoot, "pairfob-agent-bindings", hex.EncodeToString(sum[:])+".json"), nil
}

func (h *Herdr) bindingProcess(ctx context.Context, session SessionRef, paneID string) (int, error) {
	raw, err := h.callWithTimeout(ctx, session, "pane.process_info", map[string]any{"pane_id": paneID}, false, time.Second)
	if err != nil {
		return 0, err
	}
	var result struct {
		Type string `json:"type"`
		Info struct {
			PaneID    string `json:"pane_id"`
			ShellPID  int    `json:"shell_pid"`
			GroupID   int    `json:"foreground_process_group_id"`
			Processes []struct {
				PID int `json:"pid"`
			} `json:"foreground_processes"`
		} `json:"process_info"`
	}
	if json.Unmarshal(raw, &result) != nil || result.Type != "pane_process_info" || result.Info.PaneID != paneID || result.Info.GroupID <= 1 || result.Info.GroupID == result.Info.ShellPID {
		return 0, errors.New("agent foreground process unavailable")
	}
	for _, process := range result.Info.Processes {
		if process.PID == result.Info.GroupID {
			return process.PID, nil
		}
	}
	return 0, errors.New("agent process group leader unavailable")
}

// ReportAgentBinding is called only by the local CLI hook. The caller must be
// in the foreground process group of the pane inherited from Herdr. Paths and
// terminal identity come from the runtime, never from the hook's JSON input.
func (h *Herdr) ReportAgentBinding(ctx context.Context, paneID string, report AgentBindingReport) error {
	if !localBindingAgent(report.Agent) || !localSessionID.MatchString(report.SessionID) || report.Sequence <= 0 || !validResourceID.MatchString(paneID) {
		return errors.New("invalid agent binding report")
	}
	if report.Agent == "cmd" && !validCommandCodeObservation(report.Leaf, report.Activity) {
		return errors.New("invalid Command Code observation")
	}
	// The inherited pane ID can be an alias after a pane move. Only the
	// runtime's caller-context resolver may translate it to the current ID.
	current, err := h.callWithTimeout(ctx, SessionRef{}, "pane.current", map[string]any{"caller_pane_id": paneID}, false, time.Second)
	if err != nil {
		return err
	}
	var resolved struct {
		Type string        `json:"type"`
		Pane herdrPaneWire `json:"pane"`
	}
	if json.Unmarshal(current, &resolved) != nil || resolved.Type != "pane_current" || !validResourceID.MatchString(resolved.Pane.PaneID) {
		return errors.New("agent caller pane unavailable")
	}
	paneID = resolved.Pane.PaneID
	pid, err := h.bindingProcess(ctx, SessionRef{}, paneID)
	if err != nil {
		return err
	}
	if !localHookDescendsFrom(ctx, pid, report.Agent) {
		return errors.New("agent hook is outside the pane foreground process")
	}
	birth, err := localProcessBirth(ctx, pid)
	if err != nil {
		return err
	}
	// Read the raw snapshot: applying bindings here would recurse through IO.
	raw, err := h.callWithTimeout(ctx, SessionRef{}, "session.snapshot", map[string]any{}, false, time.Second)
	if err != nil {
		return err
	}
	var wire herdrSnapWire
	if json.Unmarshal(raw, &wire) != nil || wire.Type != "session_snapshot" {
		return errors.New("invalid binding snapshot")
	}
	var terminal string
	for _, pane := range wire.Snapshot.Panes {
		if pane.PaneID == paneID && (pane.Agent == report.Agent || pane.Agent == "" || pane.Agent == "unknown") {
			terminal = pane.TerminalID
			break
		}
	}
	if !validResourceID.MatchString(terminal) {
		return errors.New("agent pane is not yet detected")
	}
	path, err := h.bindingPath(SessionRef{}, terminal)
	if err != nil {
		return err
	}
	record := localAgentBinding{Version: 1, Agent: report.Agent, SessionID: report.SessionID, TerminalID: terminal, ProcessID: pid, Birth: birth, Sequence: report.Sequence, Cleared: report.Clear, Leaf: report.Leaf, Activity: report.Activity}
	return saveLocalAgentBinding(path, record)
}

func readLocalAgentBinding(path string) (localAgentBinding, error) {
	var record localAgentBinding
	info, err := os.Lstat(path)
	if err != nil {
		return record, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 4096 {
		return record, errors.New("unsafe binding file")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return record, err
	}
	err = json.Unmarshal(data, &record)
	return record, err
}

func (h *Herdr) applyLocalAgentBindings(ctx context.Context, session SessionRef, snapshot *Snapshot) {
	for i := range snapshot.Panes {
		pane := &snapshot.Panes[i]
		if (pane.AgentSession != nil && pane.Agent != "cmd") || !localBindingAgent(pane.Agent) || pane.TerminalID == "" {
			continue
		}
		path, err := h.bindingPath(session, pane.TerminalID)
		if err != nil {
			continue
		}
		record, err := readLocalAgentBinding(path)
		if err != nil || record.Version != 1 || record.Cleared || record.Agent != pane.Agent || record.TerminalID != pane.TerminalID || !localSessionID.MatchString(record.SessionID) {
			continue
		}
		if record.Agent == "cmd" && !validCommandCodeObservation(record.Leaf, record.Activity) {
			continue
		}
		pid, err := h.bindingProcess(ctx, session, pane.PaneID)
		if err != nil || pid != record.ProcessID {
			continue
		}
		birth, err := localProcessBirth(ctx, pid)
		if err != nil || birth != record.Birth {
			continue
		}
		pane.AgentSession = &AgentSessionRef{Source: "pairfob:" + record.Agent, Agent: record.Agent, Kind: "id", Value: record.SessionID, Leaf: record.Leaf, LiveActivity: record.Activity}
		pane.HistoryAvailable = true
		pane.AgentInstanceID = opaqueAgentInstanceID(pane.TerminalID, pane.AgentSession)
	}
}

func validCommandCodeObservation(leaf *string, activity *PaneActivity) bool {
	if leaf == nil || (*leaf != "" && !localSessionID.MatchString(*leaf)) {
		return false
	}
	return activity == nil || (activity.Type == "tool" && len(activity.Name) > 0 && len(activity.Name) <= 80 && activity.Label == "" && activity.Turn == nil && activity.At > 0 && (activity.State == "" || activity.State == "done" || activity.State == "error"))
}
