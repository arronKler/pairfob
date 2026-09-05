package runtime

import (
	"context"
	"encoding/json"
	"testing"
)

var paneCreationCases = []struct {
	name, createMethod, closeMethod, closeKey, closeID string
	entityCount                                        int
	command                                            func(string) Command
}{
	{"tab", "tab.create", "tab.close", "tab_id", "w1:t2", 2, func(kind string) Command {
		return CreateTabCommand{WorkspaceID: "w1", CWD: "/repo", AgentKind: kind}
	}},
	{"split", "pane.split", "pane.close", "pane_id", "w1:p2", 1, func(kind string) Command {
		return SplitPaneCommand{WorkspaceID: "w1", TargetPaneID: "w1:p1", TargetTabID: "w1:t1", Direction: SplitDown, CWD: "/repo", AgentKind: kind}
	}},
}

func TestHerdrPaneCreationRejectsMismatchedTargets(t *testing.T) {
	for _, mismatch := range []struct {
		creationIndex int
		entity, field string
		value         string
	}{
		{0, "tab", "workspace_id", "other-workspace"},
		{0, "root_pane", "workspace_id", "other-workspace"},
		{0, "root_pane", "tab_id", "old-tab"},
		{1, "pane", "pane_id", "w1:p1"},
		{1, "pane", "workspace_id", "other-workspace"},
		{1, "pane", "tab_id", "other-tab"},
	} {
		creation := paneCreationCases[mismatch.creationIndex]
		t.Run(creation.name+"/"+mismatch.entity+"/"+mismatch.field, func(t *testing.T) {
			socket, log := startScriptedHerdr(t, func(request scriptedRequest) scriptedReply {
				reply := standardReply(request)
				if request.Method == creation.createMethod {
					reply.Result.(map[string]any)[mismatch.entity].(map[string]any)[mismatch.field] = mismatch.value
				}
				return reply
			})
			receipt, err := NewHerdr(socket).Execute(context.Background(), DefaultSession(), "wrong-creation-target", creation.command("codex"))
			if err == nil || receipt.Outcome != OutcomeUnknown {
				t.Fatalf("receipt=%+v err=%v", receipt, err)
			}
			for _, request := range log.snapshot() {
				switch request.Method {
				case "agent.start", "pane.close", "tab.close", "workspace.close":
					t.Fatalf("must not mutate an unverified creation target: %+v", request)
				}
			}
		})
	}
}

func TestHerdrPaneCreationKinds(t *testing.T) {
	for _, creation := range paneCreationCases {
		for _, kind := range []string{"", "codex", "claude", "unavailable"} {
			t.Run(creation.name+"/"+kind, func(t *testing.T) {
				socket, log := startScriptedHerdr(t, func(request scriptedRequest) scriptedReply {
					if request.Method == "agent.start" {
						return scriptedReply{Result: map[string]any{"type": "agent_started", "agent": map[string]any{"pane_id": "w1:p2"}}}
					}
					return standardReply(request)
				})
				receipt, err := NewHerdr(socket).Execute(context.Background(), DefaultSession(), "pane-kind", creation.command(kind))
				if kind == "unavailable" {
					fault, ok := AsFault(err)
					if !ok || fault.Code != CodeUnsupported || receipt.Outcome != OutcomeNotApplied {
						t.Fatalf("receipt=%+v err=%v", receipt, err)
					}
				} else if err != nil || receipt.Outcome != OutcomeApplied {
					t.Fatalf("receipt=%+v err=%v", receipt, err)
				}
				created, started := 0, 0
				for _, request := range log.snapshot() {
					var params map[string]any
					if err := json.Unmarshal(request.Params, &params); err != nil {
						t.Fatal(err)
					}
					switch request.Method {
					case creation.createMethod:
						created++
						if params["focus"] != false || params["cwd"] != "/repo" {
							t.Fatalf("create params=%s", request.Params)
						}
					case "agent.start":
						started++
						if created != 1 || params["pane_id"] != "w1:p2" || params["kind"] != kind || params["name"] != generatedAgentName(kind, "pane-kind") {
							t.Fatalf("agent must start on the new pane after creation: %s", request.Params)
						}
					case "pane.send_text", "pane.send_keys", "workspace.close", "tab.close", "pane.close":
						t.Fatalf("unexpected mutation: %s", request.Method)
					}
				}
				wantCreated, wantStarted := 1, 1
				if kind == "" || kind == "unavailable" {
					wantStarted = 0
				}
				if kind == "unavailable" {
					wantCreated = 0
				}
				if created != wantCreated || started != wantStarted {
					t.Fatalf("create=%d start=%d", created, started)
				}
				if wantCreated == 1 && len(receipt.Created) != creation.entityCount+wantStarted {
					t.Fatalf("created entities=%+v", receipt.Created)
				}
			})
		}
	}
}

func TestHerdrPaneCreationStartFailures(t *testing.T) {
	for _, creation := range paneCreationCases {
		for _, failure := range []struct {
			name         string
			start, close scriptedReply
			outcome      Outcome
			remove       bool
		}{
			{"definite", scriptedReply{Error: &scriptedError{Code: "agent_not_ready", Message: "not ready"}}, scriptedReply{Result: map[string]any{"type": "ok"}}, OutcomeNotApplied, true},
			{"uncertain", scriptedReply{Result: map[string]any{"type": "agent_started", "agent": map[string]any{"pane_id": "wrong-pane"}}}, scriptedReply{}, OutcomeUnknown, false},
			{"cleanup-fails", scriptedReply{Error: &scriptedError{Code: "agent_not_ready", Message: "not ready"}}, scriptedReply{Error: &scriptedError{Code: "forbidden", Message: "cannot close"}}, OutcomePartial, true},
		} {
			t.Run(creation.name+"/"+failure.name, func(t *testing.T) {
				socket, log := startScriptedHerdr(t, func(request scriptedRequest) scriptedReply {
					if request.Method == "agent.start" {
						return failure.start
					}
					if request.Method == creation.closeMethod {
						return failure.close
					}
					return standardReply(request)
				})
				receipt, err := NewHerdr(socket).Execute(context.Background(), DefaultSession(), "pane-start-failure", creation.command("codex"))
				if err == nil || receipt.Outcome != failure.outcome {
					t.Fatalf("receipt=%+v err=%v", receipt, err)
				}
				creates, starts, closes := 0, 0, 0
				for _, request := range log.snapshot() {
					switch request.Method {
					case creation.createMethod:
						creates++
					case "agent.start":
						starts++
					case "tab.close", "pane.close", "workspace.close":
						closes++
						var params map[string]any
						_ = json.Unmarshal(request.Params, &params)
						if !failure.remove || request.Method != creation.closeMethod || params[creation.closeKey] != creation.closeID {
							t.Fatalf("must only remove the newly created entity on definite failure: %+v", request)
						}
					}
				}
				wantCloses := 0
				if failure.remove {
					wantCloses = 1
				}
				if creates != 1 || starts != 1 || closes != wantCloses {
					t.Fatalf("create=%d start=%d close=%d", creates, starts, closes)
				}
			})
		}
	}
}
