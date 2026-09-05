package daemon

import (
	"context"
	"maps"
	"strings"
	"testing"

	"pairfob/internal/runtime"
)

func TestPaneCreationAgentKindsAndDeduplication(t *testing.T) {
	for _, op := range []string{"CreateTab", "SplitPane"} {
		t.Run(op, func(t *testing.T) {
			fake := runtime.NewFake()
			_, client := runtimeRPCClient(t, fake)
			rootRaw, err := client.RPC("CreateConversation", map[string]any{"operation_id": "op_panekindroot0001", "cwd": "/tmp/pairfob"})
			if err != nil {
				t.Fatal(err)
			}
			root := decodeResult(t, rootRaw)
			params := map[string]any{"operation_id": "op_panekind00000001", "agent_kind": "codex"}
			if op == "CreateTab" {
				params["workspace_id"] = root["workspace_id"]
			} else {
				params["pane_id"], params["direction"] = root["pane_id"], "down"
			}
			first, err := client.RPC(op, params)
			if err != nil {
				t.Fatal(err)
			}
			created := decodeResult(t, first)
			if created["pane_id"] == "" || created["workspace_id"] != root["workspace_id"] || created["outcome"] != "applied" || len(created) != 5 {
				t.Fatalf("unexpected success response: %s", first)
			}
			snapshot := func() runtime.Snapshot {
				t.Helper()
				observed, err := fake.Observe(context.Background(), runtime.DefaultSession(), runtime.SnapshotQuery{})
				if err != nil {
					t.Fatal(err)
				}
				return observed.(runtime.SnapshotView).Snapshot
			}
			before := snapshot()
			found := false
			for _, pane := range before.Panes {
				if pane.PaneID == created["pane_id"] {
					found = true
					if pane.Agent != "codex" {
						t.Fatalf("created pane has wrong kind: %+v", pane)
					}
				}
			}
			if !found {
				t.Fatal("created pane missing from snapshot")
			}
			replayed, err := client.RPC(op, params)
			if err != nil || string(first) != string(replayed) {
				t.Fatalf("replay=%s err=%v", replayed, err)
			}
			conflict := maps.Clone(params)
			conflict["agent_kind"] = "claude"
			if _, err := client.RPC(op, conflict); err == nil || err.Error() != "conflict" {
				t.Fatalf("changed kind with same operation_id must conflict: %v", err)
			}
			for index, kind := range []any{"unavailable", "not a kind", strings.Repeat("a", 33), 7, "", nil} {
				invalid := maps.Clone(params)
				invalid["operation_id"] = "op_invalidkind0000" + string(rune('a'+index))
				invalid["agent_kind"] = kind
				want := "invalid_argument"
				if kind == "unavailable" {
					want = "unsupported"
				}
				if _, err := client.RPC(op, invalid); err == nil || err.Error() != want {
					t.Fatalf("kind=%v err=%v want=%s", kind, err, want)
				}
			}
			after := snapshot()
			if len(after.Panes) != len(before.Panes) || len(after.Tabs) != len(before.Tabs) {
				t.Fatal("replay or rejected kind created extra panes or tabs")
			}
		})
	}
}
