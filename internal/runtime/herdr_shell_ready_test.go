package runtime

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

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
