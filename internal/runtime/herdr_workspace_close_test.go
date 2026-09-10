package runtime

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func closeVersionReply(request scriptedRequest, version string) scriptedReply {
	reply := standardReply(request)
	if request.Method == "session.snapshot" {
		reply.Result.(map[string]any)["snapshot"].(map[string]any)["version"] = version
	}
	return reply
}

func TestHerdrWorkspaceCloseFailureDoesNotReplay(t *testing.T) {
	for _, afterSend := range []bool{false, true} {
		t.Run(map[bool]string{false: "snapshot failed", true: "close response lost"}[afterSend], func(t *testing.T) {
			socket, log := startScriptedHerdr(t, func(req scriptedRequest) scriptedReply {
				if !afterSend && req.Method == "session.snapshot" {
					return scriptedReply{Error: &scriptedError{Code: "unavailable"}}
				}
				reply := closeVersionReply(req, "0.9.0")
				if req.Method == "workspace.close" {
					reply.Delay = 150 * time.Millisecond
				}
				return reply
			})
			ctx, cancel := context.WithTimeout(context.Background(), 75*time.Millisecond)
			defer cancel()
			receipt, err := NewHerdr(socket).Execute(ctx, DefaultSession(), "close-failure", CloseWorkspaceCommand{WorkspaceID: "w1"})
			wantOutcome, wantCloses := OutcomeNotApplied, 0
			if afterSend {
				wantOutcome, wantCloses = OutcomeUnknown, 1
			}
			if err == nil || receipt.Outcome != wantOutcome {
				t.Fatalf("receipt=%+v err=%v", receipt, err)
			}
			closes := 0
			for _, req := range log.snapshot() {
				if req.Method == "workspace.close" {
					closes++
				}
			}
			if closes != wantCloses {
				t.Fatalf("close calls=%d want=%d", closes, wantCloses)
			}
		})
	}
}

func TestHerdrWorkspaceCloseRejectsUnprotectedRuntime(t *testing.T) {
	for _, version := range []string{"0.8.2", "0.8.99", "0.9.0-rc.1", "dev", "0.9", "0.09.0", "99999999999999999.0.0"} {
		t.Run(version, func(t *testing.T) {
			socket, log := startScriptedHerdr(t, func(req scriptedRequest) scriptedReply { return closeVersionReply(req, version) })
			receipt, err := NewHerdr(socket).Execute(context.Background(), DefaultSession(), "close-old", CloseWorkspaceCommand{WorkspaceID: "w1"})
			fault, ok := AsFault(err)
			if !ok || fault.Code != CodeUnsupported || receipt.Outcome != OutcomeNotApplied {
				t.Fatalf("receipt=%+v err=%v", receipt, err)
			}
			for _, req := range log.snapshot() {
				if req.Method != "session.snapshot" {
					t.Fatalf("unsafe request: %s", req.Method)
				}
			}
		})
	}
}

func TestHerdrWorkspaceCloseUsesRuntimeAtomicScopeGuard(t *testing.T) {
	for _, version := range []string{"0.9.0", "v0.9.1", "0.9.0+build.123", "0.10.0", "1.0.0"} {
		for _, group := range []bool{false, true} {
			t.Run(version+"/group="+map[bool]string{true: "yes", false: "no"}[group], func(t *testing.T) {
				closes := 0
				socket, _ := startScriptedHerdr(t, func(req scriptedRequest) scriptedReply {
					if req.Method == "workspace.close" {
						closes++
						var params struct {
							WorkspaceID string `json:"workspace_id"`
							CloseGroup  *bool  `json:"close_group"`
						}
						if json.Unmarshal(req.Params, &params) != nil || params.WorkspaceID != "w1" || params.CloseGroup == nil || *params.CloseGroup {
							t.Error("single-workspace intent missing")
						}
						// The group may have changed since snapshot; only the runtime
						// mutation can authorize the actual current scope atomically.
						if group {
							return scriptedReply{Error: &scriptedError{Code: "workspace_group_close_required"}}
						}
					}
					return closeVersionReply(req, version)
				})
				receipt, err := NewHerdr(socket).Execute(context.Background(), DefaultSession(), "close", CloseWorkspaceCommand{WorkspaceID: "w1"})
				if closes != 1 {
					t.Fatalf("close calls=%d", closes)
				}
				if group {
					fault, ok := AsFault(err)
					if !ok || fault.Code != CodeConflict || receipt.Outcome != OutcomeNotApplied || len(receipt.Removed) != 0 {
						t.Fatalf("receipt=%+v err=%v", receipt, err)
					}
				} else if err != nil || receipt.Outcome != OutcomeApplied || len(receipt.Removed) != 1 {
					t.Fatalf("receipt=%+v err=%v", receipt, err)
				}
			})
		}
	}
}

func TestHerdrWorkspaceCloseGuardCoversCompensation(t *testing.T) {
	for _, version := range []string{"0.8.2", "0.9.0"} {
		t.Run(version, func(t *testing.T) {
			socket, log := startScriptedHerdr(t, func(req scriptedRequest) scriptedReply {
				if req.Method == "agent.start" {
					return scriptedReply{Error: &scriptedError{Code: "agent_not_ready"}}
				}
				if req.Method == "workspace.close" {
					return scriptedReply{Error: &scriptedError{Code: "workspace_group_close_required"}}
				}
				return closeVersionReply(req, version)
			})
			receipt, err := NewHerdr(socket).Execute(context.Background(), DefaultSession(), "create-compensation", CreateConversationCommand{CWD: "/repo", AgentKind: "codex"})
			if err == nil || receipt.Outcome != OutcomePartial || len(receipt.Created) != 3 || len(receipt.Removed) != 0 {
				t.Fatalf("receipt=%+v err=%v", receipt, err)
			}
			closes := 0
			for _, req := range log.snapshot() {
				if req.Method == "workspace.close" {
					closes++
				}
			}
			want := 0
			if version == "0.9.0" {
				want = 1
			}
			if closes != want {
				t.Fatalf("close calls=%d want=%d", closes, want)
			}
		})
	}
}
