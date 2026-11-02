package daemon

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pairfob/internal/journal"
	"pairfob/internal/mux"
	"pairfob/internal/runtime"
	"pairfob/internal/state"
)

func chainPane(terminal, agent, value string) runtime.Pane {
	p := runtime.Pane{PaneID: "w0:p1", TerminalID: terminal, Agent: agent}
	if value != "" {
		p.AgentSession = &runtime.AgentSessionRef{Source: "herdr:" + agent, Agent: agent, Kind: "id", Value: value}
	}
	return p
}

func chainEngine(t *testing.T) *Engine {
	t.Helper()
	relay, _ := mux.NewPipePair(8)
	e := NewEngine(nil, relay, runtime.NewFake())
	e.Journal = &journal.Reader{CodexRoot: t.TempDir()}
	e.Store = &state.Store{Dir: t.TempDir()}
	return e
}

func chainValues(e *Engine, terminal string) []string {
	var out []string
	for _, c := range e.chain.byTerminal[terminal] {
		out = append(out, c.Value)
	}
	return out
}

func TestSessionChainRecordsLeftSessions(t *testing.T) {
	e := chainEngine(t)
	now := time.Unix(100, 0)
	a, b := "session_aaaaaaaa", "session_bbbbbbbb"
	e.observeSessionChange(chainPane("t1", "codex", a), chainPane("t1", "codex", b), now)
	if got := chainValues(e, "t1"); len(got) != 1 || got[0] != a {
		t.Fatalf("after change: %v", got)
	}
	// B -> none -> B pushes B once.
	e.observeSessionChange(chainPane("t1", "codex", b), chainPane("t1", "codex", ""), now)
	e.observeSessionChange(chainPane("t1", "codex", ""), chainPane("t1", "codex", b), now)
	if got := chainValues(e, "t1"); len(got) != 2 || got[1] != b {
		t.Fatalf("after none and back: %v", got)
	}
	// B -> none again must not duplicate the head.
	e.observeSessionChange(chainPane("t1", "codex", b), chainPane("t1", "codex", ""), now)
	if got := chainValues(e, "t1"); len(got) != 2 {
		t.Fatalf("head duplicated: %v", got)
	}
	// Never push none.
	e.observeSessionChange(chainPane("t1", "codex", ""), chainPane("t1", "codex", a), now)
	if got := chainValues(e, "t1"); len(got) != 2 {
		t.Fatalf("none pushed: %v", got)
	}
	// Another agent on the terminal resets the chain.
	e.observeSessionChange(chainPane("t1", "claude", "c1"), chainPane("t1", "claude", "c2"), now)
	if got := chainValues(e, "t1"); len(got) != 1 || got[0] != "c1" {
		t.Fatalf("after agent change: %v", got)
	}
	// An empty terminal id adds nothing.
	e.observeSessionChange(chainPane("", "codex", a), chainPane("", "codex", b), now)
	if len(e.chain.byTerminal[""]) != 0 {
		t.Fatal("empty terminal chained")
	}
}

func TestSessionChainKeepsAtMostSixteenPerPaneAnd64Terminals(t *testing.T) {
	e := chainEngine(t)
	for i := 0; i < 20; i++ {
		e.observeSessionChange(chainPane("t1", "codex", "session_"+strings.Repeat("a", 7)+string(rune('a'+i))), chainPane("t1", "codex", "next_session"), time.Unix(int64(i), 0))
	}
	if n := len(e.chain.byTerminal["t1"]); n != maxChainPerTerminal {
		t.Fatalf("len=%d", n)
	}
	for i := 0; i < 70; i++ {
		term := "term" + string(rune('A'+i))
		e.observeSessionChange(chainPane(term, "codex", "session_aaaaaaaa"), chainPane(term, "codex", "session_bbbbbbbb"), time.Unix(int64(1000+i), 0))
	}
	if n := len(e.chain.byTerminal); n != maxChainTerminals {
		t.Fatalf("terminals=%d", n)
	}
	if _, ok := e.chain.byTerminal["t1"]; ok {
		t.Fatal("oldest terminal kept")
	}
}

func TestSessionChainFileIsWrittenOnlyOnChange(t *testing.T) {
	e := chainEngine(t)
	path := filepath.Join(e.Store.Dir, sessionChainFile)
	a, b := "session_aaaaaaaa", "session_bbbbbbbb"
	e.observeSessionChange(chainPane("t1", "codex", a), chainPane("t1", "codex", a), time.Unix(1, 0))
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("file without change: %v", err)
	}
	e.observeSessionChange(chainPane("t1", "codex", a), chainPane("t1", "codex", b), time.Unix(2, 0))
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode=%v", info.Mode())
	}
	old := time.Unix(5, 0)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	e.observeSessionChange(chainPane("t1", "codex", b), chainPane("t1", "codex", b), time.Unix(3, 0))
	after, _ := os.Stat(path)
	if !after.ModTime().Equal(old) {
		t.Fatal("file rewritten without a change")
	}
}

func TestSessionChainLoadDropsUnsupportedAndMovesCorruptAside(t *testing.T) {
	e := chainEngine(t)
	path := filepath.Join(e.Store.Dir, sessionChainFile)
	raw := `{"entries":[` +
		`{"terminal_id":"t1","agent":"codex","source":"herdr:codex","kind":"id","value":"session_aaaaaaaa","observed_at":"2026-01-01T00:00:00Z"},` +
		`{"terminal_id":"t1","agent":"codex","source":"herdr:codex","kind":"id","value":"../evil","observed_at":"2026-01-01T00:00:01Z"}]}`
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := e.chainAt("t1", 1); !ok {
		t.Fatal("supported entry dropped")
	}
	if _, _, ok := e.chainAt("t1", 2); ok || len(e.chain.byTerminal["t1"]) != 1 {
		t.Fatalf("unsupported entry kept: %v", chainValues(e, "t1"))
	}

	c := chainEngine(t)
	cpath := filepath.Join(c.Store.Dir, sessionChainFile)
	if err := os.WriteFile(cpath, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if c.hasPastSession("t1") {
		t.Fatal("corrupt file produced a chain")
	}
	if _, err := os.Stat(cpath); !os.IsNotExist(err) {
		t.Fatalf("corrupt file still in place: %v", err)
	}
	matches, _ := filepath.Glob(cpath + ".*")
	if len(matches) != 1 {
		t.Fatalf("moved aside: %v", matches)
	}
}

func TestSessionChainSurvivesRestart(t *testing.T) {
	e := chainEngine(t)
	e.observeSessionChange(chainPane("t1", "codex", "session_aaaaaaaa"), chainPane("t1", "codex", "session_bbbbbbbb"), time.Unix(2, 0))
	again := NewEngine(nil, e.Conn, runtime.NewFake())
	again.Journal, again.Store = e.Journal, e.Store
	if entry, _, ok := again.chainAt("t1", 1); !ok || entry.Value != "session_aaaaaaaa" {
		t.Fatalf("not reloaded: %v %v", entry, ok)
	}
}
