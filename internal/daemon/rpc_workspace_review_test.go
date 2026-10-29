package daemon

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pairfob/internal/workspace"
)

func TestGitStatusStatsAreOptIn(t *testing.T) {
	root, fake := workspaceRPCFixture(t)
	if err := os.WriteFile(filepath.Join(root, "notes.md"), []byte("one\ntwo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, client := runtimeRPCClient(t, fake)

	plainRaw, err := client.RPCTimeout("GitStatus", map[string]any{"pane_id": "w0:p1"}, 8*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	// Existing clients reject unknown keys: without the param nothing is added.
	if strings.Contains(string(plainRaw), `"stat"`) || strings.Contains(string(plainRaw), `"modified_ms"`) {
		t.Fatalf("stats without opt-in: %s", plainRaw)
	}
	offRaw, err := client.RPCTimeout("GitStatus", map[string]any{"pane_id": "w0:p1", "stats": false}, 8*time.Second)
	if err != nil || strings.Contains(string(offRaw), `"stat"`) {
		t.Fatalf("stats:false = %s err=%v", offRaw, err)
	}

	raw, err := client.RPCTimeout("GitStatus", map[string]any{"pane_id": "w0:p1", "stats": true}, 8*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var status struct {
		Revision string `json:"revision"`
		Changes  []struct {
			Path       string                `json:"path"`
			Stat       *workspace.ChangeStat `json:"stat"`
			ModifiedMS *int64                `json:"modified_ms"`
		} `json:"changes"`
	}
	if err := json.Unmarshal(raw, &status); err != nil || len(status.Changes) != 2 || len(status.Revision) != 64 {
		t.Fatalf("GitStatus stats=%s err=%v", raw, err)
	}
	counts := map[string]workspace.LineCount{}
	for _, change := range status.Changes {
		if change.Stat == nil || change.Stat.Worktree == nil || change.Stat.Staged != nil || change.ModifiedMS == nil || *change.ModifiedMS <= 0 {
			t.Fatalf("change=%+v raw=%s", change, raw)
		}
		counts[change.Path] = *change.Stat.Worktree
	}
	if counts["src/app.ts"] != (workspace.LineCount{Additions: 1, Deletions: 1}) || counts["notes.md"] != (workspace.LineCount{Additions: 2}) {
		t.Fatalf("counts=%+v", counts)
	}
	if _, err := client.RPCTimeout("GitStatus", map[string]any{"pane_id": "w0:p1", "stats": "yes"}, 8*time.Second); err == nil || err.Error() != "invalid_argument" {
		t.Fatalf("stats of the wrong type err=%v", err)
	}
}

func TestWorkspaceSearchIsBoundToTheShownRoot(t *testing.T) {
	root, fake := workspaceRPCFixture(t)
	canonical, err := workspace.CanonicalRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "application.md"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, client := runtimeRPCClient(t, fake)

	raw, err := client.RPC("WorkspaceSearch", map[string]any{"pane_id": "w0:p1", "root": canonical, "query": "app"})
	if err != nil {
		t.Fatal(err)
	}
	var page workspace.SearchPage
	if err := json.Unmarshal(raw, &page); err != nil || len(page.Items) != 2 || page.Items[0].Path != "src/app.ts" || page.Items[0].Name != "app.ts" || page.Truncated {
		t.Fatalf("WorkspaceSearch=%s err=%v", raw, err)
	}
	limited, err := client.RPC("WorkspaceSearch", map[string]any{"pane_id": "w0:p1", "root": canonical, "query": "app", "limit": 1})
	if err != nil || json.Unmarshal(limited, &page) != nil || len(page.Items) != 1 || !page.Truncated {
		t.Fatalf("limited=%s err=%v", limited, err)
	}
	empty, err := client.RPC("WorkspaceSearch", map[string]any{"pane_id": "w0:p1", "root": canonical, "query": ""})
	if err != nil || json.Unmarshal(empty, &page) != nil || len(page.Items) != 0 || !strings.Contains(string(empty), `"items":[]`) {
		t.Fatalf("empty=%s err=%v", empty, err)
	}

	for name, bad := range map[string]struct {
		params map[string]any
		code   string
	}{
		"no root":      {map[string]any{"pane_id": "w0:p1", "query": "app"}, "invalid_argument"},
		"no query":     {map[string]any{"pane_id": "w0:p1", "root": canonical}, "invalid_argument"},
		"null query":   {map[string]any{"pane_id": "w0:p1", "root": canonical, "query": nil}, "invalid_argument"},
		"unknown key":  {map[string]any{"pane_id": "w0:p1", "root": canonical, "query": "app", "extra": true}, "invalid_argument"},
		"long query":   {map[string]any{"pane_id": "w0:p1", "root": canonical, "query": strings.Repeat("a", workspace.MaxSearchQueryRunes+1)}, "invalid_argument"},
		"large limit":  {map[string]any{"pane_id": "w0:p1", "root": canonical, "query": "app", "limit": workspace.MaxSearchLimit + 1}, "invalid_argument"},
		"missing pane": {map[string]any{"pane_id": "missing", "root": canonical, "query": "app"}, "workspace_not_found"},
	} {
		if raw, err := client.RPC("WorkspaceSearch", bad.params); err == nil || err.Error() != bad.code {
			t.Fatalf("%s: reply=%s err=%v, want %s", name, raw, err, bad.code)
		}
	}
	// The pane has moved to another directory: a search for the root the client still shows is refused.
	other := t.TempDir()
	otherCanonical, err := workspace.CanonicalRoot(other)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.RPC("WorkspaceSearch", map[string]any{"pane_id": "w0:p1", "root": otherCanonical, "query": "app"}); err == nil || err.Error() != "conflict" {
		t.Fatalf("another root err=%v", err)
	}
}
