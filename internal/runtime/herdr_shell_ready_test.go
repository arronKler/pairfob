package runtime

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"
)

func TestCreatedShellBusyStartupAcrossCreateCommands(t *testing.T) {
	for _, tc := range []struct {
		name, pane string
		command    Command
	}{
		{"conversation", "w2:p1", CreateConversationCommand{CWD: "/repo", AgentKind: "codex"}},
		{"tab", "w1:p2", CreateTabCommand{WorkspaceID: "w1", AgentKind: "codex"}},
		{"split", "w1:p2", SplitPaneCommand{WorkspaceID: "w1", TargetPaneID: "w1:p1", Direction: SplitRight, AgentKind: "codex"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var ready atomic.Bool
			var starts atomic.Int32
			observed := make(chan struct{}, 1)
			socket, _ := startScriptedHerdr(t, func(request scriptedRequest) scriptedReply {
				switch request.Method {
				case "pane.process_info":
					if !ready.Load() {
						select {
						case observed <- struct{}{}:
						default:
						}
						return shellProcessReply(tc.pane, 43, 43)
					}
					return shellProcessReply(tc.pane, 42, 42)
				case "agent.start":
					starts.Add(1)
					// Model the native RPC contract, not the CLI's retry loop.
					if !ready.Load() {
						return scriptedReply{Error: &scriptedError{Code: "agent_pane_busy", Message: "shell initialization is running"}}
					}
					var params struct {
						PaneID string `json:"pane_id"`
						Name   string `json:"name"`
					}
					if err := json.Unmarshal(request.Params, &params); err != nil {
						t.Error(err)
					}
					return scriptedReply{Result: map[string]any{"type": "agent_started", "agent": map[string]any{"pane_id": params.PaneID, "name": params.Name}}}
				}
				return standardReply(request)
			})
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			done := make(chan struct{})
			var receipt Receipt
			var err error
			go func() {
				defer close(done)
				receipt, err = NewHerdr(socket).Execute(ctx, DefaultSession(), "busy-"+tc.name, tc.command)
			}()
			select {
			case <-done:
				t.Fatalf("creation completed before shell became ready: receipt=%+v err=%v", receipt, err)
			case <-ctx.Done():
				t.Fatal("no readiness observation")
			case <-observed:
			}
			if starts.Load() != 0 {
				t.Fatal("agent.start sent while shell initialization was running")
			}
			ready.Store(true)
			<-done
			if err != nil || receipt.Outcome != OutcomeApplied || starts.Load() != 1 {
				t.Fatalf("receipt=%+v err=%v agent.start calls=%d", receipt, err, starts.Load())
			}
		})
	}
}

func shellProcessReply(paneID string, foreground int, pids ...int) scriptedReply {
	processes := make([]any, 0, len(pids))
	for _, pid := range pids {
		processes = append(processes, map[string]any{"pid": pid})
	}
	return scriptedReply{Result: map[string]any{"type": "pane_process_info", "process_info": map[string]any{
		"pane_id": paneID, "shell_pid": 42, "foreground_process_group_id": foreground, "foreground_processes": processes,
	}}}
}

func TestCreatedShellWaitsThroughStartupBeforeSingleAgentStart(t *testing.T) {
	var reads atomic.Int32
	var starts atomic.Int32
	socket, _ := startScriptedHerdr(t, func(request scriptedRequest) scriptedReply {
		if request.Method == "pane.process_info" {
			switch reads.Add(1) {
			case 1:
				// The shell can briefly appear foreground before startup runs.
				return shellProcessReply("w2:p1", 42, 42)
			case 2, 3:
				return shellProcessReply("w2:p1", 43, 43)
			default:
				return shellProcessReply("w2:p1", 42, 42)
			}
		}
		if request.Method == "agent.start" {
			starts.Add(1)
			if reads.Load() < 5 {
				t.Error("agent started before shell settled")
			}
		}
		return standardReply(request)
	})
	receipt, err := NewHerdr(socket).Execute(context.Background(), DefaultSession(), "shell-wait", CreateConversationCommand{CWD: "/repo", AgentKind: "codex"})
	if err != nil || receipt.Outcome != OutcomeApplied || starts.Load() != 1 {
		t.Fatalf("receipt=%+v err=%v starts=%d", receipt, err, starts.Load())
	}
}

func TestCreatedShellReadinessFailsClosed(t *testing.T) {
	for _, tc := range []struct {
		name  string
		reply scriptedReply
		code  ErrorCode
	}{
		{"busy", shellProcessReply("w2:p1", 43, 43), CodeNotReady},
		{"no process evidence", shellProcessReply("w2:p1", 42), CodeNotReady},
		{"foreground child", shellProcessReply("w2:p1", 42, 42, 43), CodeNotReady},
		{"wrong pane", shellProcessReply("w9:p9", 42, 42), CodeInternal},
		{"unsupported", scriptedReply{Error: &scriptedError{Code: "unsupported", Message: "unsupported"}}, CodeUnsupported},
	} {
		t.Run(tc.name, func(t *testing.T) {
			socket, log := startScriptedHerdr(t, func(request scriptedRequest) scriptedReply { return tc.reply })
			err := NewHerdr(socket).waitCreatedShellWithin(context.Background(), DefaultSession(), "w2:p1", 40*time.Millisecond, 5*time.Millisecond, 10*time.Millisecond)
			fault, ok := AsFault(err)
			if !ok || fault.Code != tc.code || fault.Outcome != OutcomeNotApplied {
				t.Fatalf("fault=%+v err=%v", fault, err)
			}
			for _, request := range log.snapshot() {
				if request.Method != "pane.process_info" {
					t.Fatalf("unexpected mutation: %s", request.Method)
				}
			}
		})
	}
}

func TestCreatedShellInvalidReadCompensatesWithoutStartingAgent(t *testing.T) {
	socket, log := startScriptedHerdr(t, func(request scriptedRequest) scriptedReply {
		if request.Method == "pane.process_info" {
			return shellProcessReply("wrong-pane", 42, 42)
		}
		return closeVersionReply(request, "0.9.0")
	})
	receipt, err := NewHerdr(socket).Execute(context.Background(), DefaultSession(), "shell-invalid", CreateConversationCommand{CWD: "/repo", AgentKind: "codex"})
	if err == nil || receipt.Outcome != OutcomeNotApplied {
		t.Fatalf("receipt=%+v err=%v", receipt, err)
	}
	closes := 0
	for _, request := range log.snapshot() {
		if request.Method == "agent.start" {
			t.Fatal("started agent after invalid shell read")
		}
		if request.Method == "workspace.close" {
			closes++
		}
	}
	if closes != 1 {
		t.Fatalf("workspace.close calls=%d", closes)
	}
}
