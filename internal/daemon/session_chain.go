package daemon

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"pairfob/internal/journal"
	"pairfob/internal/runtime"
)

// Interface revision session-chain-1: a per-terminal chain of the agent
// sessions a pane has left behind. Session ids stay inside the daemon.
const (
	sessionChainFile     = "session-chain.json"
	maxChainPerTerminal  = 16
	maxChainTerminals    = 64
	maxChainFieldLen     = 1024
	maxChainFileBytes    = 1 << 20
	maxChainSessionIndex = maxChainPerTerminal
)

type chainEntry struct {
	TerminalID string    `json:"terminal_id"`
	Agent      string    `json:"agent"`
	Source     string    `json:"source"`
	Kind       string    `json:"kind"`
	Value      string    `json:"value"`
	ObservedAt time.Time `json:"observed_at"`
}

func (c chainEntry) ref() journal.Ref {
	return journal.Ref{Source: c.Source, Agent: c.Agent, Kind: c.Kind, Value: c.Value}
}

type sessionChain struct {
	mu     sync.Mutex
	loaded bool
	// byTerminal holds each chain oldest first.
	byTerminal map[string][]chainEntry
}

type sessionChainFileV1 struct {
	Entries []chainEntry `json:"entries"`
}

// observeSessionChange records the session a pane left. previous and next are
// the pane's AgentSession in consecutive observations of the same terminal.
func (e *Engine) observeSessionChange(previous, next runtime.Pane, now time.Time) {
	terminal := next.TerminalID
	if terminal == "" || previous.TerminalID != terminal {
		return
	}
	c := &e.chain
	c.mu.Lock()
	defer c.mu.Unlock()
	e.loadChainLocked()
	changed := false
	if chain := c.byTerminal[terminal]; len(chain) > 0 && next.Agent != "" && chain[len(chain)-1].Agent != next.Agent {
		delete(c.byTerminal, terminal)
		changed = true
	}
	old := previous.AgentSession
	if old != nil && old.Value != "" && (next.AgentSession == nil || *next.AgentSession != *old) {
		chain := c.byTerminal[terminal]
		if len(chain) == 0 || chain[len(chain)-1].ref() != journalRef(old) {
			if c.byTerminal == nil {
				c.byTerminal = map[string][]chainEntry{}
			}
			chain = append(chain, chainEntry{TerminalID: terminal, Agent: old.Agent, Source: old.Source, Kind: old.Kind, Value: old.Value, ObservedAt: now})
			if len(chain) > maxChainPerTerminal {
				chain = append([]chainEntry(nil), chain[len(chain)-maxChainPerTerminal:]...)
			}
			c.byTerminal[terminal] = chain
			dropOldestTerminals(c.byTerminal)
			changed = true
		}
	}
	if changed {
		e.saveChainLocked()
	}
}

func dropOldestTerminals(chains map[string][]chainEntry) {
	for len(chains) > maxChainTerminals {
		oldest, at := "", time.Time{}
		for id, chain := range chains {
			last := chain[len(chain)-1].ObservedAt
			if oldest == "" || last.Before(at) {
				oldest, at = id, last
			}
		}
		delete(chains, oldest)
	}
}

// chainAt returns the n-th past session of terminal counted from the newest
// (n >= 1) and whether a session older than it exists.
func (e *Engine) chainAt(terminal string, n int) (entry chainEntry, hasEarlier, ok bool) {
	c := &e.chain
	c.mu.Lock()
	defer c.mu.Unlock()
	e.loadChainLocked()
	chain := c.byTerminal[terminal]
	if terminal == "" || n < 1 || n > len(chain) {
		return chainEntry{}, false, false
	}
	entry = chain[len(chain)-n]
	if entry.TerminalID != terminal {
		return chainEntry{}, false, false
	}
	return entry, n < len(chain), true
}

// hasPastSession reports whether terminal has at least one past session.
func (e *Engine) hasPastSession(terminal string) bool {
	c := &e.chain
	c.mu.Lock()
	defer c.mu.Unlock()
	e.loadChainLocked()
	return terminal != "" && len(c.byTerminal[terminal]) > 0
}

func (e *Engine) chainPath() string {
	if e.Store == nil || e.Store.Dir == "" {
		return ""
	}
	return filepath.Join(e.Store.Dir, sessionChainFile)
}

// loadChainLocked reads the file once. The file is untrusted: every entry must
// pass Reader.Supports, and a file that does not parse is moved aside.
func (e *Engine) loadChainLocked() {
	c := &e.chain
	if c.loaded {
		return
	}
	c.loaded = true
	c.byTerminal = map[string][]chainEntry{}
	path := e.chainPath()
	if path == "" {
		return
	}
	raw, err := readSmallFile(path)
	if os.IsNotExist(err) {
		return
	}
	var file sessionChainFileV1
	if err == nil {
		err = json.Unmarshal(raw, &file)
	}
	if err != nil {
		_ = os.Rename(path, fmt.Sprintf("%s.corrupt-%d", path, time.Now().UnixNano()))
		return
	}
	for _, entry := range file.Entries {
		if entry.TerminalID == "" || len(entry.TerminalID) > maxChainFieldLen ||
			len(entry.Value) > maxChainFieldLen || len(entry.Agent) > maxChainFieldLen ||
			len(entry.Source) > maxChainFieldLen || len(entry.Kind) > maxChainFieldLen {
			continue
		}
		if e.Journal == nil || !e.Journal.Supports(entry.ref()) {
			continue
		}
		chain := c.byTerminal[entry.TerminalID]
		if n := len(chain); n > 0 && chain[n-1].Agent != entry.Agent {
			chain = nil
		}
		chain = append(chain, entry)
		if len(chain) > maxChainPerTerminal {
			chain = chain[len(chain)-maxChainPerTerminal:]
		}
		c.byTerminal[entry.TerminalID] = chain
	}
	dropOldestTerminals(c.byTerminal)
}

func readSmallFile(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxChainFileBytes {
		return nil, fmt.Errorf("unexpected chain file")
	}
	return io.ReadAll(io.LimitReader(f, maxChainFileBytes))
}

func (e *Engine) saveChainLocked() {
	path := e.chainPath()
	if path == "" {
		return
	}
	var file sessionChainFileV1
	for _, chain := range e.chain.byTerminal {
		file.Entries = append(file.Entries, chain...)
	}
	sort.SliceStable(file.Entries, func(i, j int) bool { return file.Entries[i].ObservedAt.Before(file.Entries[j].ObservedAt) })
	raw, err := json.Marshal(file)
	if err != nil {
		return
	}
	_ = writeFile0600(path, raw)
}

// writeFile0600 replaces path atomically: temp file, chmod 0600, fsync, rename.
func writeFile0600(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".session-chain-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	fail := func(err error) error {
		_ = tmp.Close()
		_ = os.Remove(name)
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		return fail(err)
	}
	if _, err := tmp.Write(data); err != nil {
		return fail(err)
	}
	if err := tmp.Sync(); err != nil {
		return fail(err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(name)
		return err
	}
	if err := os.Rename(name, path); err != nil {
		_ = os.Remove(name)
		return err
	}
	return nil
}
