package acp

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"
	"testing"
	"time"
)

// The fake adapter runs this test binary as a child process. The parent sets
// helperEnv and talks to it over stdin/stdout like any ACP adapter.

const (
	helperEnv   = "PAIRFOB_ACP_HELPER"
	scenarioEnv = "PAIRFOB_ACP_SCENARIO"
	logEnv      = "PAIRFOB_ACP_LOG"
)

const (
	scenarioFull           = "full"
	scenarioModes          = "modes"
	scenarioCancel         = "cancel"
	scenarioUnknown        = "unknown"
	scenarioExit           = "exit"
	scenarioUnknownRequest = "unknown-request"
)

// TestACPHelperProcess is the fake adapter entry point. It only runs when the
// parent asked for it; in a normal test run it returns immediately.
func TestACPHelperProcess(t *testing.T) {
	if os.Getenv(helperEnv) != "1" {
		return
	}
	os.Exit(runHelper())
}

func runHelper() int {
	scenario := os.Getenv(scenarioEnv)
	if scenario == scenarioExit {
		fmt.Fprintln(os.Stderr, "helper: adapter exploded")
		return 3
	}
	adapter := &fakeAdapter{
		scenario: scenario,
		logPath:  os.Getenv(logEnv),
		encoder:  json.NewEncoder(os.Stdout),
		answers:  make(chan json.RawMessage, 1),
	}
	return adapter.serve(os.Stdin)
}

type fakeAdapter struct {
	scenario string
	logPath  string
	encoder  *json.Encoder

	writeMu sync.Mutex
	logMu   sync.Mutex
	answers chan json.RawMessage
}

func (a *fakeAdapter) serve(input io.Reader) int {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 0, 64<<10), maxLineBytes)
	for scanner.Scan() {
		line := append([]byte(nil), scanner.Bytes()...)
		a.record(line)

		var frame incomingFrame
		if json.Unmarshal(line, &frame) != nil {
			continue
		}
		if frame.Method == "" {
			if len(frame.ID) > 0 {
				select {
				case a.answers <- frame.ID:
				default:
				}
			}
			continue
		}
		switch frame.Method {
		case "initialize":
			a.initialize(frame.ID)
		case "session/new", "session/load":
			a.openSession(frame.ID)
		case "session/prompt":
			go a.prompt(frame.ID, frame.Params)
		case "session/set_mode":
			a.setMode(frame.ID, frame.Params)
		case "session/set_config_option":
			a.setConfigOption(frame.ID, frame.Params)
		case "session/cancel":
			a.cancel(frame.Params)
		}
	}
	if scanner.Err() != nil {
		return 1
	}
	return 0
}

func (a *fakeAdapter) initialize(id json.RawMessage) {
	a.respond(id, map[string]any{
		"protocolVersion": 1,
		"agentCapabilities": map[string]any{
			"loadSession":        true,
			"promptCapabilities": map[string]any{"image": true, "embeddedContext": true},
			"mcpCapabilities":    map[string]any{"http": true},
		},
		"agentInfo": map[string]any{"name": "fake-agent", "title": "Fake Agent", "version": "0.0.1"},
	})
	if a.scenario == scenarioUnknownRequest {
		go a.unknownRequest()
	}
}

func (a *fakeAdapter) openSession(id json.RawMessage) {
	a.respond(id, map[string]any{
		"sessionId": "sess-1",
		"modes": map[string]any{
			"currentModeId": "default",
			"availableModes": []map[string]any{
				{"id": "default", "name": "Default", "description": "Default mode"},
				{"id": "plan", "name": "Plan", "description": "Plan mode"},
			},
		},
		"configOptions": []map[string]any{{
			"id":           "model",
			"name":         "Model",
			"description":  "Model to use",
			"category":     "model",
			"type":         "select",
			"currentValue": "sonnet",
			"options": []map[string]any{
				{"value": "sonnet", "name": "Sonnet", "description": "Balanced"},
				{"value": "haiku", "name": "Haiku"},
			},
		}},
	})
}

func (a *fakeAdapter) prompt(id json.RawMessage, params json.RawMessage) {
	var request struct {
		SessionID string `json:"sessionId"`
	}
	_ = json.Unmarshal(params, &request)
	switch a.scenario {
	case scenarioUnknown:
		a.update(request.SessionID, map[string]any{
			"sessionUpdate": "future_thing",
			"payload":       map[string]any{"x": 1},
		})
	case scenarioFull:
		a.streamTurn(request.SessionID)
	}
	a.respond(id, map[string]any{
		"stopReason": "end_turn",
		"usage":      map[string]any{"inputTokens": 12, "outputTokens": 34, "totalTokens": 46},
	})
}

// streamTurn emits the update sequence of one full turn. It blocks in
// requestPermission until the client answers, exactly like a real adapter.
func (a *fakeAdapter) streamTurn(sessionID string) {
	a.update(sessionID, map[string]any{
		"sessionUpdate": "agent_message_chunk",
		"content":       map[string]any{"type": "text", "text": "Hel"},
		"messageId":     "msg-1",
	})
	a.update(sessionID, map[string]any{
		"sessionUpdate": "tool_call",
		"toolCallId":    "call-1",
		"title":         "Read a file",
		"kind":          "read",
		"status":        "pending",
		"content": []map[string]any{
			{"type": "text", "text": "reading /work/a.txt"},
			{"type": "diff", "path": "/work/a.txt", "oldText": "old", "newText": "new"},
		},
		"locations": []map[string]any{{"path": "/work/a.txt", "line": 1}},
		"rawInput":  map[string]any{"path": "/work/a.txt"},
	})
	a.update(sessionID, map[string]any{
		"sessionUpdate": "tool_call_update",
		"toolCallId":    "call-1",
		"status":        "completed",
		"content": []map[string]any{
			{"type": "diff", "path": "/work/a.txt", "oldText": "old", "newText": "new"},
		},
	})
	a.update(sessionID, map[string]any{
		"sessionUpdate": "plan",
		"entries": []map[string]any{
			{"content": "Read the file", "priority": "high", "status": "completed"},
			{"content": "Change the file", "priority": "medium", "status": "in_progress"},
		},
	})
	a.update(sessionID, map[string]any{
		"sessionUpdate": "usage_update",
		"used":          31994,
		"size":          1000000,
		"cost":          map[string]any{"amount": 0.16, "currency": "USD"},
	})
	a.requestPermission(sessionID)
	a.update(sessionID, map[string]any{
		"sessionUpdate": "agent_message_chunk",
		"content":       map[string]any{"type": "text", "text": "lo"},
		"messageId":     "msg-1",
	})
}

func (a *fakeAdapter) requestPermission(sessionID string) {
	a.write(map[string]any{
		"jsonrpc": "2.0",
		"id":      0,
		"method":  "session/request_permission",
		"params": map[string]any{
			"sessionId": sessionID,
			"options": []map[string]any{
				{"optionId": "allow", "name": "Allow", "kind": "allow_once"},
				{"optionId": "reject", "name": "Reject", "kind": "reject_once"},
			},
			"toolCall": map[string]any{"toolCallId": "call-1", "title": "Read a file", "status": "pending"},
		},
	})
	<-a.answers
}

func (a *fakeAdapter) setMode(id json.RawMessage, params json.RawMessage) {
	var request struct {
		SessionID string `json:"sessionId"`
		ModeID    string `json:"modeId"`
	}
	_ = json.Unmarshal(params, &request)
	a.update(request.SessionID, map[string]any{
		"sessionUpdate": "current_mode_update",
		"currentModeId": request.ModeID,
	})
	a.respond(id, map[string]any{})
}

func (a *fakeAdapter) setConfigOption(id json.RawMessage, params json.RawMessage) {
	var request struct {
		SessionID string `json:"sessionId"`
		ConfigID  string `json:"configId"`
		Value     string `json:"value"`
	}
	_ = json.Unmarshal(params, &request)
	a.update(request.SessionID, map[string]any{
		"sessionUpdate": "config_option_update",
		"configOptions": []map[string]any{{
			"id":           request.ConfigID,
			"name":         "Model",
			"type":         "select",
			"currentValue": request.Value,
		}},
	})
	a.respond(id, map[string]any{})
}

func (a *fakeAdapter) cancel(params json.RawMessage) {
	var request struct {
		SessionID string `json:"sessionId"`
	}
	_ = json.Unmarshal(params, &request)
	a.update(request.SessionID, map[string]any{
		"sessionUpdate": "agent_message_chunk",
		"content":       map[string]any{"type": "text", "text": "cancelled"},
		"messageId":     "cancel-ack",
	})
}

// unknownRequest exercises the client's dispatch for an agent-to-client
// method it does not implement: the client must answer with method-not-found
// rather than leave the agent waiting.
func (a *fakeAdapter) unknownRequest() {
	a.write(map[string]any{
		"jsonrpc": "2.0",
		"id":      7,
		"method":  "fs/read_text_file",
		"params":  map[string]any{"path": "/etc/passwd"},
	})
	select {
	case <-a.answers:
	case <-time.After(5 * time.Second):
		return
	}
	a.update("", map[string]any{
		"sessionUpdate": "agent_message_chunk",
		"content":       map[string]any{"type": "text", "text": "unknown-request-answered"},
		"messageId":     "ack",
	})
}

func (a *fakeAdapter) update(sessionID string, update any) {
	a.write(map[string]any{
		"jsonrpc": "2.0",
		"method":  "session/update",
		"params":  map[string]any{"sessionId": sessionID, "update": update},
	})
}

func (a *fakeAdapter) respond(id json.RawMessage, result any) {
	a.write(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func (a *fakeAdapter) write(frame any) {
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	_ = a.encoder.Encode(frame)
}

// record appends every received line to the log the parent reads, so tests
// can assert the exact JSON the client put on the wire.
func (a *fakeAdapter) record(line []byte) {
	if a.logPath == "" {
		return
	}
	a.logMu.Lock()
	defer a.logMu.Unlock()
	file, err := os.OpenFile(a.logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer file.Close()
	_, _ = file.Write(append(line, '\n'))
}
