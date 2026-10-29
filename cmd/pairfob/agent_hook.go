package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"pairfob/internal/runtime"
)

// Agent hooks are advisory: no output, no injected context, and no propagation
// of a reporting failure into the agent's permissions or turn result.
func agentHook(args []string, input io.Reader) error {
	if os.Getenv("HERDR_ENV") != "1" {
		return nil
	}
	socket, pane := os.Getenv("HERDR_SOCKET_PATH"), os.Getenv("HERDR_PANE_ID")
	if !filepath.IsAbs(socket) || pane == "" {
		return nil
	}
	report, err := parseAgentHook(args, input)
	if err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = runtime.NewHerdr(socket).ReportAgentBinding(ctx, pane, report)
	return nil
}

func parseAgentHook(args []string, input io.Reader) (runtime.AgentBindingReport, error) {
	var report runtime.AgentBindingReport
	if len(args) == 0 {
		return report, errors.New("missing agent")
	}
	report.Agent = args[0]
	if report.Agent == "cmd" {
		data, err := io.ReadAll(io.LimitReader(input, 4097))
		if err != nil || len(data) > 4096 || len(args) != 1 {
			return report, errors.New("invalid Command Code event")
		}
		var event struct {
			SessionID string                `json:"session_id"`
			Leaf      *string               `json:"leaf"`
			Sequence  int64                 `json:"sequence"`
			Clear     bool                  `json:"clear"`
			Activity  *runtime.PaneActivity `json:"activity"`
		}
		if err := json.Unmarshal(data, &event); err != nil {
			return report, err
		}
		report.SessionID, report.Leaf, report.Sequence, report.Clear, report.Activity = event.SessionID, event.Leaf, event.Sequence, event.Clear, event.Activity
		return report, nil
	}
	if report.Agent == "amp" || report.Agent == "maki" {
		if len(args) != 4 || (args[3] != "bind" && args[3] != "clear") {
			return report, errors.New("invalid plugin event")
		}
		report.SessionID = args[1]
		seq, err := strconv.ParseInt(args[2], 10, 64)
		report.Sequence, report.Clear = seq, args[3] == "clear"
		return report, err
	}
	if len(args) != 1 || (report.Agent != "gemini" && report.Agent != "cline") {
		return report, errors.New("unknown hook")
	}
	data, err := io.ReadAll(io.LimitReader(input, (1<<20)+1))
	if err != nil || len(data) > 1<<20 {
		return report, errors.New("oversized hook input")
	}
	var event struct {
		SessionID     string  `json:"session_id"`
		Event         string  `json:"hook_event_name"`
		Timestamp     string  `json:"timestamp"`
		TaskID        string  `json:"taskId"`
		HookName      string  `json:"hookName"`
		ParentAgentID *string `json:"parent_agent_id"`
		AgentID       string  `json:"agent_id"`
		Source        string  `json:"source"`
	}
	if json.Unmarshal(data, &event) != nil {
		return report, errors.New("invalid hook input")
	}
	at, err := time.Parse(time.RFC3339Nano, event.Timestamp)
	if err != nil {
		return report, err
	}
	report.Sequence = at.UnixNano()
	if report.Agent == "gemini" {
		if event.Event != "SessionStart" && event.Event != "BeforeAgent" && event.Event != "SessionEnd" {
			return report, errors.New("unrelated Gemini event")
		}
		if event.Event == "SessionStart" && event.Source != "startup" && event.Source != "resume" && event.Source != "clear" {
			return report, errors.New("unknown Gemini session source")
		}
		report.SessionID, report.Clear = event.SessionID, event.Event == "SessionEnd"
	} else {
		// Current Cline SDK supplies both fields; old extension task hooks are a
		// different persistence format and must not masquerade as SDK sessions.
		if event.ParentAgentID != nil || event.AgentID == "" {
			return report, errors.New("not a root Cline SDK session")
		}
		switch event.HookName {
		case "agent_start", "agent_resume", "prompt_submit", "session_shutdown":
		default:
			return report, errors.New("unrelated Cline event")
		}
		report.SessionID, report.Clear = event.TaskID, event.HookName == "session_shutdown"
	}
	return report, nil
}

func installAgentObservation(args []string) error {
	if len(args) != 1 {
		return errors.New("usage: pairfob agent-observation gemini|cline|amp|maki|cmd")
	}
	binary, err := os.Executable()
	if err != nil {
		return err
	}
	return runtime.InstallAgentObservation(args[0], binary)
}
