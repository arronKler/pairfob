package daemon

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"pairfob/internal/crypto/aead"
	"pairfob/internal/envelope"
	"pairfob/internal/journal"
	"pairfob/internal/mux"
	"pairfob/internal/runtime"
)

type watchClient struct {
	s    *sess
	peer *mux.Pipe
	rx   *aead.Direction
}

type watchHarness struct {
	t       *testing.T
	eng     *Engine
	path    string
	now     time.Time
	mu      sync.Mutex
	stats   int
	clients []*watchClient
}

var watchRef = journal.Ref{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: "session_12345678"}

func newWatchHarness(t *testing.T) *watchHarness {
	t.Helper()
	root := t.TempDir()
	h := &watchHarness{t: t, path: filepath.Join(root, "a.jsonl"), now: time.Unix(1000, 0)}
	h.write("one\n")
	relay, _ := mux.NewPipePair(8)
	h.eng = NewEngine(nil, relay, runtime.NewFake())
	h.eng.Journal = &journal.Reader{CodexRoot: root}
	h.eng.traceWatch.now = func() time.Time { return h.now }
	h.eng.traceWatch.resolve = func(journal.Ref) (string, error) { return h.path, nil }
	h.eng.traceWatch.stat = func(p string) (os.FileInfo, error) {
		h.mu.Lock()
		h.stats++
		h.mu.Unlock()
		return os.Stat(p)
	}
	return h
}

func (h *watchHarness) write(text string) {
	h.t.Helper()
	f, err := os.OpenFile(h.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		h.t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(text); err != nil {
		h.t.Fatal(err)
	}
}

func (h *watchHarness) addSession(id byte) *watchClient {
	h.t.Helper()
	link, peer := mux.NewPipePair(16)
	key := make([]byte, 32)
	for i := range key {
		key[i] = id + byte(i)
	}
	rid := [16]byte{id}
	s := &sess{routeID: rid, deviceID: "dev_watch", state: "established", link: link,
		s2c: &aead.Direction{Key: append([]byte(nil), key...), Dir: aead.DirServer}}
	h.eng.mu.Lock()
	h.eng.sessions[rid] = s
	h.eng.mu.Unlock()
	c := &watchClient{s: s, peer: peer, rx: &aead.Direction{Key: key, Dir: aead.DirServer}}
	h.clients = append(h.clients, c)
	return c
}

func (h *watchHarness) statCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.stats
}

// pokes drains the Pokes the client received as pane ids.
func (c *watchClient) pokes(t *testing.T) []string {
	t.Helper()
	var out []string
	for {
		frame, ok := c.peer.RecvTimeout(20 * time.Millisecond)
		if !ok {
			return out
		}
		if frame.Typ != envelope.TypFWD {
			continue
		}
		plain, err := aead.Open(c.rx, c.s.routeID, frame.Payload)
		if err != nil {
			t.Fatal(err)
		}
		var msg struct {
			Op     string `json:"op"`
			Params struct {
				Reason string `json:"reason"`
				PaneID string `json:"pane_id"`
			} `json:"params"`
		}
		if json.Unmarshal(plain, &msg) == nil && msg.Op == "" {
			continue // a reply to a request
		}
		if msg.Op != "Poke" || msg.Params.Reason != "agent_trace" {
			t.Fatalf("unexpected frame: %s", plain)
		}
		out = append(out, msg.Params.PaneID)
	}
}

func TestTraceWatchPokesEachWatchingSessionOnceAndStatsOnce(t *testing.T) {
	h := newWatchHarness(t)
	a, b := h.addSession(1), h.addSession(2)
	h.eng.watchTrace(a.s, "w0:p1", watchRef)
	h.eng.watchTrace(b.s, "w0:p1", watchRef)
	h.eng.traceWatchTick() // baseline
	h.write("two\n")
	before := h.statCount()
	h.eng.traceWatchTick()
	if n := h.statCount() - before; n != 1 {
		t.Fatalf("journal statted %d times in one tick", n)
	}
	for _, c := range []*watchClient{a, b} {
		if got := c.pokes(t); len(got) != 1 || got[0] != "w0:p1" {
			t.Fatalf("pokes=%v", got)
		}
	}
}

func TestTraceWatchSeveralAppendsInOneTickGiveOnePoke(t *testing.T) {
	h := newWatchHarness(t)
	a := h.addSession(1)
	h.eng.watchTrace(a.s, "w0:p1", watchRef)
	h.eng.traceWatchTick()
	h.write("two\n")
	h.write("three\n")
	h.write("four\n")
	h.eng.traceWatchTick()
	h.eng.traceWatchTick() // unchanged since the last tick
	if got := a.pokes(t); len(got) != 1 {
		t.Fatalf("pokes=%v", got)
	}
}

func TestTraceWatchPathChangeGivesPoke(t *testing.T) {
	h := newWatchHarness(t)
	a := h.addSession(1)
	h.eng.watchTrace(a.s, "w0:p1", watchRef)
	h.eng.traceWatchTick()
	other := filepath.Join(filepath.Dir(h.path), "b.jsonl")
	if err := os.Rename(h.path, other); err != nil {
		t.Fatal(err)
	}
	h.path = other
	h.eng.traceWatchTick()
	if got := a.pokes(t); len(got) != 1 {
		t.Fatalf("pokes=%v", got)
	}
}

func TestTraceWatchWithoutWatchedPaneDoesNotStat(t *testing.T) {
	h := newWatchHarness(t)
	h.addSession(1)
	if n := h.eng.traceWatchTick(); n != 0 {
		t.Fatalf("watched=%d", n)
	}
	if h.statCount() != 0 {
		t.Fatalf("statted %d times with nothing watched", h.statCount())
	}
}

func TestTraceWatchExpiredSessionGetsNoPoke(t *testing.T) {
	h := newWatchHarness(t)
	a := h.addSession(1)
	h.eng.watchTrace(a.s, "w0:p1", watchRef)
	h.eng.traceWatchTick()
	h.now = h.now.Add(traceWatchTTL + time.Second)
	h.write("two\n")
	before := h.statCount()
	h.eng.traceWatchTick()
	if got := a.pokes(t); len(got) != 0 {
		t.Fatalf("expired session poked: %v", got)
	}
	if h.statCount() != before {
		t.Fatal("expired watch still statted")
	}
}

func TestTraceWatchReadRefreshesTTL(t *testing.T) {
	h := newWatchHarness(t)
	a := h.addSession(1)
	h.eng.watchTrace(a.s, "w0:p1", watchRef)
	h.eng.traceWatchTick()
	h.now = h.now.Add(traceWatchTTL - time.Second)
	h.eng.watchTrace(a.s, "w0:p1", watchRef)
	h.now = h.now.Add(traceWatchTTL - time.Second)
	h.write("two\n")
	h.eng.traceWatchTick()
	if got := a.pokes(t); len(got) != 1 {
		t.Fatalf("pokes=%v", got)
	}
}

func TestTraceWatchFailedSessionDoesNotStopTheOthers(t *testing.T) {
	h := newWatchHarness(t)
	a, b := h.addSession(1), h.addSession(2)
	a.s.epochFailed.Store(true)
	h.eng.watchTrace(a.s, "w0:p1", watchRef)
	h.eng.watchTrace(b.s, "w0:p1", watchRef)
	h.eng.traceWatchTick()
	h.write("two\n")
	h.eng.traceWatchTick()
	if got := b.pokes(t); len(got) != 1 {
		t.Fatalf("healthy session pokes=%v", got)
	}
}

func TestAgentTraceReadStartsTheWatchInsideTheEngine(t *testing.T) {
	root := t.TempDir()
	sessionID := "session_12345678"
	transcript := filepath.Join(root, "sessions", "2026", "08", "28", "rollout-"+sessionID+".jsonl")
	if err := os.MkdirAll(filepath.Dir(transcript), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(transcript, []byte(`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	fake := runtime.NewFake()
	fake.Snap.Panes[0].Agent = "codex"
	fake.Snap.Panes[0].AgentSession = &runtime.AgentSessionRef{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: sessionID}
	engine, client := runtimeRPCClient(t, fake)
	engine.Journal = &journal.Reader{CodexRoot: root}
	if n := len(engine.watchedSessions()); n != 0 {
		t.Fatalf("watched before any read: %d", n)
	}
	if _, err := client.RPC("AgentTrace", map[string]any{"pane_id": "w0:p1", "limit": 20}); err != nil {
		t.Fatal(err)
	}
	if w := engine.watchedSessions()["w0:p1"]; w == nil || len(w.sessions) != 1 {
		t.Fatalf("read did not register the watch: %v", engine.watchedSessions())
	}
}

func TestAgentTraceSummaryReadStartsTheWatch(t *testing.T) {
	root := t.TempDir()
	sessionID := "session_12345678"
	transcript := filepath.Join(root, "sessions", "2026", "08", "28", "rollout-"+sessionID+".jsonl")
	if err := os.MkdirAll(filepath.Dir(transcript), 0o700); err != nil {
		t.Fatal(err)
	}
	line := `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}` + "\n"
	if err := os.WriteFile(transcript, []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}
	fake := runtime.NewFake()
	fake.Snap.Panes[0].Agent = "codex"
	fake.Snap.Panes[0].AgentSession = &runtime.AgentSessionRef{Source: "herdr:codex", Agent: "codex", Kind: "id", Value: sessionID}
	relay, _ := mux.NewPipePair(8)
	h := &watchHarness{t: t}
	h.eng = NewEngine(nil, relay, fake)
	h.eng.Journal = &journal.Reader{CodexRoot: root}
	c := h.addSession(1)
	h.eng.dispatch(c.s, "req_summary", "AgentTraceSummary", json.RawMessage(`{"pane_id":"w0:p1","limit":20}`))
	h.eng.traceWatchTick() // baseline
	f, err := os.OpenFile(transcript, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(line); err != nil {
		t.Fatal(err)
	}
	f.Close()
	h.eng.traceWatchTick()
	if got := c.pokes(t); len(got) != 1 || got[0] != "w0:p1" {
		t.Fatalf("pokes=%v", got)
	}
}
