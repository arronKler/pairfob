package hub

import (
	"context"
	"sync"
	"testing"
	"time"

	"pairfob/internal/chat/acp"
	"pairfob/internal/chat/protocol"
)

// fakeAgent stands in for acp.Client. Prompt blocks until the test replies, so
// a test controls when a turn ends.
type fakeAgent struct {
	events   chan acp.Event
	closeOne sync.Once

	mu        sync.Mutex
	prompts   []fakePrompt
	cancels   []string
	modes     []string
	configs   []fakeConfig
	answers   []fakeAnswer
	answerErr error
	promptErr error
}

type fakePrompt struct {
	sessionID string
	blocks    []acp.ContentBlock
	reply     chan fakeReply
}

type fakeReply struct {
	result acp.PromptResult
	err    error
}

type fakeConfig struct {
	configID string
	value    string
}

type fakeAnswer struct {
	requestID string
	optionID  string
}

func newFakeAgent() *fakeAgent {
	return &fakeAgent{events: make(chan acp.Event, 256)}
}

func (f *fakeAgent) Events() <-chan acp.Event { return f.events }

func (f *fakeAgent) Prompt(_ context.Context, sessionID string, blocks []acp.ContentBlock) (acp.PromptResult, error) {
	f.mu.Lock()
	reply := make(chan fakeReply, 1)
	f.prompts = append(f.prompts, fakePrompt{sessionID: sessionID, blocks: blocks, reply: reply})
	err := f.promptErr
	f.mu.Unlock()
	if err != nil {
		return acp.PromptResult{}, err
	}
	answer := <-reply
	return answer.result, answer.err
}

func (f *fakeAgent) Cancel(sessionID string) error {
	f.mu.Lock()
	f.cancels = append(f.cancels, sessionID)
	f.mu.Unlock()
	return nil
}

func (f *fakeAgent) SetMode(_ context.Context, _, modeID string) error {
	f.mu.Lock()
	f.modes = append(f.modes, modeID)
	f.mu.Unlock()
	f.emitUpdate(acp.Update{Kind: acp.UpdateCurrentMode, ModeID: modeID})
	return nil
}

func (f *fakeAgent) SetConfigOption(_ context.Context, _, configID, value string) error {
	f.mu.Lock()
	f.configs = append(f.configs, fakeConfig{configID: configID, value: value})
	f.mu.Unlock()
	f.emitUpdate(acp.Update{
		Kind: acp.UpdateConfigOption,
		ConfigOptions: []acp.ConfigOption{{
			ID:           configID,
			Name:         "Model",
			Category:     "model",
			Type:         "select",
			CurrentValue: value,
			Options: []acp.ConfigOptionValue{
				{Value: "sonnet", Name: "Sonnet"},
				{Value: "haiku", Name: "Haiku"},
			},
		}},
	})
	return nil
}

func (f *fakeAgent) AnswerPermission(requestID, optionID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.answers = append(f.answers, fakeAnswer{requestID: requestID, optionID: optionID})
	return f.answerErr
}

func (f *fakeAgent) emit(event acp.Event) {
	f.events <- event
}

func (f *fakeAgent) emitUpdate(update acp.Update) {
	copied := update
	f.emit(acp.Event{Kind: acp.EventUpdate, Update: &copied})
}

func (f *fakeAgent) emitPermission(requestID string, options ...acp.PermissionOption) {
	f.emit(acp.Event{
		Kind: acp.EventPermission,
		Permission: &acp.PermissionRequest{
			SessionID: "sess-1",
			RequestID: requestID,
			Options:   options,
			ToolCall:  &acp.ToolCall{ToolCallID: "call-1", Title: "Read a file"},
		},
	})
}

func (f *fakeAgent) closeEvents() {
	f.closeOne.Do(func() { close(f.events) })
}

func (f *fakeAgent) promptCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.prompts)
}

func (f *fakeAgent) promptAt(t *testing.T, index int) fakePrompt {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if index >= len(f.prompts) {
		t.Fatalf("prompt %d has not reached the agent", index)
	}
	return f.prompts[index]
}

func (f *fakeAgent) complete(index int, result acp.PromptResult, err error) {
	f.mu.Lock()
	reply := f.prompts[index].reply
	f.mu.Unlock()
	reply <- fakeReply{result: result, err: err}
}

func (f *fakeAgent) answersSeen() []fakeAnswer {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]fakeAnswer(nil), f.answers...)
}

func (f *fakeAgent) cancelsSeen() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.cancels...)
}

func (f *fakeAgent) modesSet() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.modes...)
}

func (f *fakeAgent) configsSet() []fakeConfig {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]fakeConfig(nil), f.configs...)
}

func (f *fakeAgent) textOfPrompt(t *testing.T, index int) string {
	t.Helper()
	prompt := f.promptAt(t, index)
	for _, block := range prompt.blocks {
		if block.Type == "text" {
			return block.Text
		}
	}
	return ""
}

// startHub builds a ready hub with the fake agent and runs its event loop.
func startHub(t *testing.T) (*Hub, *fakeAgent) {
	t.Helper()
	h := New(Config{ID: "0123456789abcdef", Agent: "claude", Title: "claude · pairfob"})
	agent := newFakeAgent()
	h.SetAgent(agent)
	if err := h.Ready(testSession()); err != nil {
		t.Fatalf("ready: %v", err)
	}
	go h.Run()
	t.Cleanup(agent.closeEvents)
	return h, agent
}

func testSession() acp.Session {
	return acp.Session{
		SessionID: "sess-1",
		Modes: &acp.SessionModes{
			CurrentModeID: "default",
			AvailableModes: []acp.Mode{
				{ID: "default", Name: "Default"},
				{ID: "plan", Name: "Plan"},
			},
		},
		ConfigOptions: []acp.ConfigOption{{
			ID:           "model",
			Name:         "Model",
			Category:     "model",
			Type:         "select",
			CurrentValue: "sonnet",
			Options: []acp.ConfigOptionValue{
				{Value: "sonnet", Name: "Sonnet"},
				{Value: "haiku", Name: "Haiku"},
			},
		}},
	}
}

func waitFor(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func waitStatus(t *testing.T, h *Hub, status string) {
	t.Helper()
	waitFor(t, "status "+status, func() bool { return h.Snapshot().Status == status })
}

func entryByID(state *protocol.State, id string) *protocol.Entry {
	entry, ok := state.Entry(id)
	if !ok {
		return nil
	}
	return entry
}
