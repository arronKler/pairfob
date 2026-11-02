package daemon

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"pairfob/internal/journal"
	"pairfob/internal/mux"
	"pairfob/internal/runtime"
)

const (
	chainOldID = "session_aaaaaaaa"
	chainNewID = "session_bbbbbbbb"
)

func chainUserLine(text string) string {
	return `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"` + text + `"}]}}` + "\n"
}

func writeChainTranscript(t *testing.T, root, id string, lines ...string) string {
	t.Helper()
	path := filepath.Join(root, "sessions", "2026", "08", "28", "rollout-"+id+".jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	body := ""
	for _, l := range lines {
		body += l
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// chainFixture has a pane whose current session is chainNewID and whose chain
// holds chainOldID.
func chainFixture(t *testing.T) (*Engine, *runtime.Fake, string) {
	root := t.TempDir()
	writeChainTranscript(t, root, chainOldID, chainUserLine("old one"), chainUserLine("old two"))
	writeChainTranscript(t, root, chainNewID, chainUserLine("new one"), chainUserLine("new two"))
	fake := runtime.NewFake()
	fake.Snap.Panes[0].Agent = "codex"
	fake.Snap.Panes[0].TerminalID = "t1"
	fake.Snap.Panes[0].AgentSession = &runtime.AgentSessionRef{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: chainNewID}
	relay, _ := mux.NewPipePair(8)
	e := NewEngine(nil, relay, fake)
	e.Journal = &journal.Reader{CodexRoot: root}
	e.observeSessionChange(chainPane("t1", "codex", chainOldID), chainPane("t1", "codex", chainNewID), time.Unix(1, 0))
	return e, fake, root
}

func summaryTexts(t *testing.T, result map[string]any) []string {
	t.Helper()
	var out []string
	for _, item := range result["items"].([]any) {
		out = append(out, item.(map[string]any)["text"].(string))
	}
	return out
}

func TestAgentTraceSummarySessionIndexReadsPastSession(t *testing.T) {
	e, fake, _ := chainFixture(t)
	engine, client := runtimeRPCClient(t, fake)
	engine.Journal = e.Journal
	engine.chain.loaded, engine.chain.byTerminal = true, e.chain.byTerminal

	raw, err := client.RPC("AgentTraceSummary", map[string]any{"pane_id": "w0:p1", "limit": 20, "session_index": 1})
	if err != nil {
		t.Fatal(err)
	}
	result := decodeResult(t, raw)
	if got := summaryTexts(t, result); len(got) != 2 || got[0] != "old one" {
		t.Fatalf("items=%v", got)
	}
	if v, ok := result["has_earlier_session"].(bool); !ok || v {
		t.Fatalf("has_earlier_session=%v", result["has_earlier_session"])
	}
	raw, err = client.RPC("AgentTraceSummary", map[string]any{"pane_id": "w0:p1", "limit": 20, "session_index": 0})
	if err != nil {
		t.Fatal(err)
	}
	result = decodeResult(t, raw)
	if got := summaryTexts(t, result); got[0] != "new one" || result["has_earlier_session"] != true {
		t.Fatalf("current: %v %v", got, result["has_earlier_session"])
	}
	if _, err := client.RPC("AgentTraceSummary", map[string]any{"pane_id": "w0:p1", "session_index": 2}); err == nil || err.Error() != "invalid_argument" {
		t.Fatalf("out of range: %v", err)
	}
	if _, err := client.RPC("AgentTraceSummary", map[string]any{"pane_id": "w0:p1", "session_index": -1}); err == nil || err.Error() != "invalid_argument" {
		t.Fatalf("negative: %v", err)
	}
}

func TestAgentTraceSummaryRefusesEntryOfAnotherTerminal(t *testing.T) {
	e, fake, _ := chainFixture(t)
	engine, client := runtimeRPCClient(t, fake)
	engine.Journal = e.Journal
	other := e.chain.byTerminal["t1"]
	// A chain of another terminal is invisible to this pane.
	engine.chain.loaded, engine.chain.byTerminal = true, map[string][]chainEntry{"t2": other}
	if _, err := client.RPC("AgentTraceSummary", map[string]any{"pane_id": "w0:p1", "session_index": 1}); err == nil || err.Error() != "invalid_argument" {
		t.Fatalf("other terminal chain: %v", err)
	}
	// An entry that claims another terminal inside this pane's chain is refused.
	forged := append([]chainEntry(nil), other...)
	forged[0].TerminalID = "t2"
	engine.chain.byTerminal = map[string][]chainEntry{"t1": forged}
	if _, err := client.RPC("AgentTraceSummary", map[string]any{"pane_id": "w0:p1", "session_index": 1}); err == nil || err.Error() != "invalid_argument" {
		t.Fatalf("forged entry: %v", err)
	}
}

func TestAgentTraceSummaryWithoutSessionIndexKeepsItsKeys(t *testing.T) {
	e, fake, _ := chainFixture(t)
	engine, client := runtimeRPCClient(t, fake)
	engine.Journal = e.Journal
	engine.chain.loaded, engine.chain.byTerminal = true, e.chain.byTerminal
	raw, err := client.RPC("AgentTraceSummary", map[string]any{"pane_id": "w0:p1", "limit": 20})
	if err != nil {
		t.Fatal(err)
	}
	var keys []string
	for k := range decodeResult(t, raw) {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if len(keys) != 3 || keys[0] != "items" || keys[1] != "next_cursor" || keys[2] != "truncated" {
		t.Fatalf("keys=%v", keys)
	}
}

func TestAgentTraceSummaryCursorOfOneSessionConflictsOnAnother(t *testing.T) {
	e, fake, _ := chainFixture(t)
	engine, client := runtimeRPCClient(t, fake)
	engine.Journal = e.Journal
	engine.chain.loaded, engine.chain.byTerminal = true, e.chain.byTerminal
	raw, err := client.RPC("AgentTraceSummary", map[string]any{"pane_id": "w0:p1", "limit": 1})
	if err != nil {
		t.Fatal(err)
	}
	cursor, _ := decodeResult(t, raw)["next_cursor"].(string)
	if cursor == "" {
		t.Fatalf("no cursor: %s", raw)
	}
	if _, err := client.RPC("AgentTraceSummary", map[string]any{"pane_id": "w0:p1", "limit": 1, "cursor": cursor, "session_index": 1}); err == nil || err.Error() != "conflict" {
		t.Fatalf("cross-session cursor: %v", err)
	}
}

func TestAgentTraceSummaryPastSessionReadLeavesTheWatchOnTheCurrentSession(t *testing.T) {
	e, fake, root := chainFixture(t)
	h := &watchHarness{t: t, eng: e}
	c := h.addSession(1)
	current := filepath.Join(root, "sessions", "2026", "08", "28", "rollout-"+chainNewID+".jsonl")

	e.dispatch(c.s, "r1", "AgentTraceSummary", json.RawMessage(`{"pane_id":"w0:p1","limit":20}`))
	e.dispatch(c.s, "r2", "AgentTraceSummary", json.RawMessage(`{"pane_id":"w0:p1","limit":20,"session_index":1}`))
	c.s.watchMu.Lock()
	ref := c.s.watchRef
	c.s.watchMu.Unlock()
	if ref.Value != chainNewID {
		t.Fatalf("watch moved to %q", ref.Value)
	}
	_ = fake
	e.traceWatchTick() // baseline
	f, err := os.OpenFile(current, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString(chainUserLine("new three"))
	f.Close()
	e.traceWatchTick()
	if got := c.pokes(t); len(got) != 1 || got[0] != "w0:p1" {
		t.Fatalf("pokes=%v", got)
	}
}

func TestReconcileRuntimeSessionChainsAClearedSession(t *testing.T) {
	e, fake, _ := chainFixture(t)
	e.chain = sessionChain{}
	state := sessionMonitorState{panes: map[string]monitoredPane{}}
	noop := func(string, string) {}
	e.reconcileRuntimeSession(t.Context(), runtime.DefaultSession(), false, &state, noop, func(HerdPush) {})
	fake.Snap.Panes[0].AgentSession = &runtime.AgentSessionRef{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: "session_cccccccc"}
	e.reconcileRuntimeSession(t.Context(), runtime.DefaultSession(), false, &state, noop, func(HerdPush) {})
	if entry, _, ok := e.chainAt("t1", 1); !ok || entry.Value != chainNewID {
		t.Fatalf("chain=%v %v", entry, ok)
	}
}
