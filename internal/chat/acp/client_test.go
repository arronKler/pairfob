package acp

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func startHelper(t *testing.T, scenario string) (*Client, string) {
	t.Helper()
	logPath := filepath.Join(t.TempDir(), "rpc.log")
	env := append(os.Environ(),
		helperEnv+"=1",
		scenarioEnv+"="+scenario,
		logEnv+"="+logPath,
	)
	client, err := Start(Options{
		Command: []string{os.Args[0], "-test.run=^TestACPHelperProcess$"},
		Dir:     t.TempDir(),
		Env:     env,
	})
	if err != nil {
		t.Fatalf("start fake adapter: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client, logPath
}

func testContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func nextEvent(t *testing.T, client *Client, timeout time.Duration) Event {
	t.Helper()
	select {
	case event, ok := <-client.Events():
		if !ok {
			t.Fatal("event stream closed")
		}
		return event
	case <-time.After(timeout):
		t.Fatal("timed out waiting for an event")
		return Event{}
	}
}

func TestPromptRoundTrip(t *testing.T) {
	client, logPath := startHelper(t, scenarioFull)
	ctx := testContext(t)

	initialized, err := client.Initialize(ctx)
	if err != nil {
		t.Fatalf("initialize: %v", err)
	}
	if initialized.ProtocolVersion != 1 {
		t.Fatalf("protocol version = %d, want 1", initialized.ProtocolVersion)
	}
	if !initialized.AgentCapabilities.LoadSession {
		t.Fatal("agent loadSession capability was not parsed")
	}
	if !initialized.AgentCapabilities.PromptCapabilities.Image {
		t.Fatal("agent image capability was not parsed")
	}
	if initialized.AgentInfo == nil || initialized.AgentInfo.Name != "fake-agent" {
		t.Fatalf("agent info = %+v", initialized.AgentInfo)
	}

	session, err := client.NewSession(ctx, "/work", nil)
	if err != nil {
		t.Fatalf("new session: %v", err)
	}
	if session.SessionID != "sess-1" {
		t.Fatalf("session id = %q", session.SessionID)
	}
	if session.Modes == nil || session.Modes.CurrentModeID != "default" || len(session.Modes.AvailableModes) != 2 {
		t.Fatalf("modes = %+v", session.Modes)
	}
	if session.Modes.AvailableModes[1].ID != "plan" || session.Modes.AvailableModes[1].Name != "Plan" {
		t.Fatalf("second mode = %+v", session.Modes.AvailableModes[1])
	}
	if len(session.ConfigOptions) != 1 {
		t.Fatalf("config options = %+v", session.ConfigOptions)
	}
	model := session.ConfigOptions[0]
	if model.ID != "model" || model.Name != "Model" || model.Category != "model" || model.Type != "select" {
		t.Fatalf("model option = %+v", model)
	}
	if model.CurrentValue != "sonnet" {
		t.Fatalf("model current value = %v", model.CurrentValue)
	}
	if len(model.Options) != 2 || model.Options[1].Value != "haiku" {
		t.Fatalf("model choices = %+v", model.Options)
	}

	type outcome struct {
		result PromptResult
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		result, err := client.Prompt(ctx, session.SessionID, []ContentBlock{TextBlock("hello")})
		done <- outcome{result: result, err: err}
	}()

	var updates []Update
	var permission *PermissionRequest
	for permission == nil {
		event := nextEvent(t, client, 10*time.Second)
		switch event.Kind {
		case EventUpdate:
			if event.Update == nil {
				t.Fatal("update event without an update")
			}
			updates = append(updates, *event.Update)
		case EventPermission:
			permission = event.Permission
		case EventExit:
			t.Fatalf("adapter exited during the turn: %+v", event.Exit)
		}
	}
	if permission.RequestID != "0" {
		t.Fatalf("permission request id = %q, want the numeric id 0 as \"0\"", permission.RequestID)
	}
	if permission.SessionID != "sess-1" {
		t.Fatalf("permission session id = %q", permission.SessionID)
	}
	if len(permission.Options) != 2 || permission.Options[0].OptionID != "allow" || permission.Options[0].Kind != "allow_once" {
		t.Fatalf("permission options = %+v", permission.Options)
	}
	if permission.ToolCall == nil || permission.ToolCall.ToolCallID != "call-1" {
		t.Fatalf("permission tool call = %+v", permission.ToolCall)
	}

	// A permission request must block the turn until the caller answers.
	select {
	case out := <-done:
		t.Fatalf("prompt returned before the permission was answered: %+v", out)
	case event := <-client.Events():
		t.Fatalf("unexpected event before the answer: %+v", event)
	case <-time.After(200 * time.Millisecond):
	}

	if err := client.AnswerPermission(permission.RequestID, "allow"); err != nil {
		t.Fatalf("answer permission: %v", err)
	}

	var turn outcome
	select {
	case turn = <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for the prompt result")
	}
	if turn.err != nil {
		t.Fatalf("prompt: %v", turn.err)
	}
	if turn.result.StopReason != "end_turn" {
		t.Fatalf("stop reason = %q", turn.result.StopReason)
	}
	if turn.result.Usage == nil || turn.result.Usage.TotalTokens != 46 || turn.result.Usage.InputTokens != 12 {
		t.Fatalf("prompt usage = %+v", turn.result.Usage)
	}

	final := nextEvent(t, client, 10*time.Second)
	if final.Kind != EventUpdate || final.Update == nil {
		t.Fatalf("event after the answer = %+v", final)
	}
	updates = append(updates, *final.Update)

	if len(updates) != 6 {
		t.Fatalf("got %d updates, want 6: %+v", len(updates), updates)
	}
	if updates[0].Kind != UpdateAgentMessageChunk || updates[0].Content.Text != "Hel" || updates[0].MessageID != "msg-1" {
		t.Fatalf("first update = %+v", updates[0])
	}
	tool := updates[1].ToolCall
	if updates[1].Kind != UpdateToolCall || tool == nil {
		t.Fatalf("tool call update = %+v", updates[1])
	}
	if tool.ToolCallID != "call-1" || tool.Title != "Read a file" || tool.Kind != "read" || tool.Status != "pending" {
		t.Fatalf("tool call = %+v", tool)
	}
	if len(tool.Content) != 2 {
		t.Fatalf("tool content = %+v", tool.Content)
	}
	if tool.Content[0].Type != "text" || tool.Content[0].Text != "reading /work/a.txt" {
		t.Fatalf("tool text content = %+v", tool.Content[0])
	}
	if diff := tool.Content[1].Diff; diff == nil || diff.Path != "/work/a.txt" || diff.OldText != "old" || diff.NewText != "new" {
		t.Fatalf("tool diff content = %+v", tool.Content[1])
	}
	if len(tool.Locations) != 1 || tool.Locations[0].Path != "/work/a.txt" || tool.Locations[0].Line == nil || *tool.Locations[0].Line != 1 {
		t.Fatalf("tool locations = %+v", tool.Locations)
	}
	if updates[2].Kind != UpdateToolCallUpdate || updates[2].ToolCall == nil || updates[2].ToolCall.Status != "completed" {
		t.Fatalf("tool call update = %+v", updates[2])
	}
	if updates[3].Kind != UpdatePlan || len(updates[3].Plan) != 2 {
		t.Fatalf("plan update = %+v", updates[3])
	}
	if updates[3].Plan[0].Content != "Read the file" || updates[3].Plan[0].Priority != "high" || updates[3].Plan[0].Status != "completed" {
		t.Fatalf("plan entry = %+v", updates[3].Plan[0])
	}
	if updates[4].Kind != UpdateUsage || updates[4].Usage == nil {
		t.Fatalf("usage update = %+v", updates[4])
	}
	if updates[4].Usage.Used != 31994 || updates[4].Usage.Size != 1000000 {
		t.Fatalf("usage = %+v", updates[4].Usage)
	}
	if cost := updates[4].Usage.Cost; cost == nil || cost.Amount != 0.16 || cost.Currency != "USD" {
		t.Fatalf("usage cost = %+v", updates[4].Usage.Cost)
	}
	if updates[5].Kind != UpdateAgentMessageChunk || updates[5].Content.Text != "lo" || updates[5].MessageID != "msg-1" {
		t.Fatalf("final update = %+v", updates[5])
	}

	frames := readLog(t, logPath)
	wantInitialize := map[string]any{
		"protocolVersion": float64(1),
		"clientCapabilities": map[string]any{
			"fs":       map[string]any{"readTextFile": false, "writeTextFile": false},
			"terminal": false,
		},
	}
	if params := asMap(t, frameWithMethod(t, frames, "initialize")["params"]); !reflect.DeepEqual(params, wantInitialize) {
		t.Fatalf("initialize params = %#v", params)
	}
	wantNew := map[string]any{"cwd": "/work", "mcpServers": []any{}}
	if params := asMap(t, frameWithMethod(t, frames, "session/new")["params"]); !reflect.DeepEqual(params, wantNew) {
		t.Fatalf("session/new params = %#v", params)
	}
	wantPrompt := map[string]any{
		"sessionId": "sess-1",
		"prompt":    []any{map[string]any{"type": "text", "text": "hello"}},
	}
	if params := asMap(t, frameWithMethod(t, frames, "session/prompt")["params"]); !reflect.DeepEqual(params, wantPrompt) {
		t.Fatalf("session/prompt params = %#v", params)
	}
	wantAnswer := map[string]any{
		"jsonrpc": "2.0",
		"id":      float64(0),
		"result": map[string]any{
			"outcome": map[string]any{"outcome": "selected", "optionId": "allow"},
		},
	}
	if answer := frameWithID(t, frames, float64(0)); !reflect.DeepEqual(answer, wantAnswer) {
		t.Fatalf("permission answer = %#v", answer)
	}
}

func TestSetModeAndConfigOption(t *testing.T) {
	client, logPath := startHelper(t, scenarioModes)
	ctx := testContext(t)

	if _, err := client.Initialize(ctx); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	session, err := client.LoadSession(ctx, "sess-1", "/work", []any{map[string]any{"name": "fake"}})
	if err != nil {
		t.Fatalf("load session: %v", err)
	}
	if session.SessionID != "sess-1" || session.Modes == nil || session.Modes.CurrentModeID != "default" {
		t.Fatalf("loaded session = %+v", session)
	}

	if err := client.SetMode(ctx, session.SessionID, "plan"); err != nil {
		t.Fatalf("set mode: %v", err)
	}
	if err := client.SetConfigOption(ctx, session.SessionID, "model", "haiku"); err != nil {
		t.Fatalf("set config option: %v", err)
	}

	modeEvent := nextEvent(t, client, 10*time.Second)
	if modeEvent.Kind != EventUpdate || modeEvent.Update == nil || modeEvent.Update.Kind != UpdateCurrentMode {
		t.Fatalf("mode event = %+v", modeEvent)
	}
	if modeEvent.Update.ModeID != "plan" {
		t.Fatalf("current mode = %q", modeEvent.Update.ModeID)
	}

	configEvent := nextEvent(t, client, 10*time.Second)
	if configEvent.Kind != EventUpdate || configEvent.Update == nil || configEvent.Update.Kind != UpdateConfigOption {
		t.Fatalf("config event = %+v", configEvent)
	}
	if len(configEvent.Update.ConfigOptions) != 1 || configEvent.Update.ConfigOptions[0].CurrentValue != "haiku" {
		t.Fatalf("config options = %+v", configEvent.Update.ConfigOptions)
	}

	frames := readLog(t, logPath)
	wantLoad := map[string]any{
		"sessionId":  "sess-1",
		"cwd":        "/work",
		"mcpServers": []any{map[string]any{"name": "fake"}},
	}
	if params := asMap(t, frameWithMethod(t, frames, "session/load")["params"]); !reflect.DeepEqual(params, wantLoad) {
		t.Fatalf("session/load params = %#v", params)
	}
	wantMode := map[string]any{"sessionId": "sess-1", "modeId": "plan"}
	if params := asMap(t, frameWithMethod(t, frames, "session/set_mode")["params"]); !reflect.DeepEqual(params, wantMode) {
		t.Fatalf("session/set_mode params = %#v", params)
	}
	wantConfig := map[string]any{"sessionId": "sess-1", "configId": "model", "value": "haiku"}
	if params := asMap(t, frameWithMethod(t, frames, "session/set_config_option")["params"]); !reflect.DeepEqual(params, wantConfig) {
		t.Fatalf("session/set_config_option params = %#v", params)
	}
}

func TestCancelSendsNotification(t *testing.T) {
	client, logPath := startHelper(t, scenarioCancel)
	ctx := testContext(t)

	if _, err := client.Initialize(ctx); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	session, err := client.NewSession(ctx, "/work", nil)
	if err != nil {
		t.Fatalf("new session: %v", err)
	}
	if err := client.Cancel(session.SessionID); err != nil {
		t.Fatalf("cancel: %v", err)
	}

	event := nextEvent(t, client, 10*time.Second)
	if event.Kind != EventUpdate || event.Update == nil || event.Update.Content.Text != "cancelled" {
		t.Fatalf("cancel acknowledgement = %+v", event)
	}

	frames := readLog(t, logPath)
	cancel := frameWithMethod(t, frames, "session/cancel")
	if _, hasID := cancel["id"]; hasID {
		t.Fatalf("session/cancel carried an id: %#v", cancel)
	}
	wantParams := map[string]any{"sessionId": "sess-1"}
	if params := asMap(t, cancel["params"]); !reflect.DeepEqual(params, wantParams) {
		t.Fatalf("session/cancel params = %#v", params)
	}
}

func TestUnknownUpdateIsPreserved(t *testing.T) {
	client, _ := startHelper(t, scenarioUnknown)
	ctx := testContext(t)

	if _, err := client.Initialize(ctx); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	session, err := client.NewSession(ctx, "/work", nil)
	if err != nil {
		t.Fatalf("new session: %v", err)
	}
	result, err := client.Prompt(ctx, session.SessionID, []ContentBlock{TextBlock("hi")})
	if err != nil {
		t.Fatalf("prompt: %v", err)
	}
	if result.StopReason != "end_turn" {
		t.Fatalf("stop reason = %q", result.StopReason)
	}

	event := nextEvent(t, client, 10*time.Second)
	if event.Kind != EventUpdate || event.Update == nil {
		t.Fatalf("unknown update event = %+v", event)
	}
	if event.Update.Kind != UpdateUnknown {
		t.Fatalf("kind = %q, want %q", event.Update.Kind, UpdateUnknown)
	}
	var got, want any
	if err := json.Unmarshal(event.Update.Raw, &got); err != nil {
		t.Fatalf("raw update: %v", err)
	}
	if err := json.Unmarshal([]byte(`{"sessionUpdate":"future_thing","payload":{"x":1}}`), &want); err != nil {
		t.Fatalf("fixture: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("raw update = %s", event.Update.Raw)
	}
}

func TestUnknownAgentRequestGetsMethodNotFound(t *testing.T) {
	client, logPath := startHelper(t, scenarioUnknownRequest)
	ctx := testContext(t)

	if _, err := client.Initialize(ctx); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	event := nextEvent(t, client, 10*time.Second)
	if event.Kind != EventUpdate || event.Update == nil || event.Update.Content.Text != "unknown-request-answered" {
		t.Fatalf("acknowledgement = %+v", event)
	}

	frames := readLog(t, logPath)
	answer := frameWithID(t, frames, float64(7))
	if _, hasResult := answer["result"]; hasResult {
		t.Fatalf("unknown request was answered with a result: %#v", answer)
	}
	wantError := map[string]any{"code": float64(codeMethodNotFound), "message": "method not found: fs/read_text_file"}
	if !reflect.DeepEqual(answer["error"], wantError) {
		t.Fatalf("error = %#v", answer["error"])
	}
}

func TestProcessExitEmitsExitOnce(t *testing.T) {
	client, _ := startHelper(t, scenarioExit)

	event := nextEvent(t, client, 15*time.Second)
	if event.Kind != EventExit || event.Exit == nil {
		t.Fatalf("first event = %+v, want exit", event)
	}
	if event.Exit.Code != 3 {
		t.Fatalf("exit code = %d, want 3", event.Exit.Code)
	}
	if event.Exit.Err == nil {
		t.Fatal("exit did not carry an error")
	}
	if !strings.Contains(event.Exit.Stderr, "adapter exploded") {
		t.Fatalf("exit stderr = %q", event.Exit.Stderr)
	}
	if _, ok := <-client.Events(); ok {
		t.Fatal("event stream stayed open after the exit event")
	}

	ctx := testContext(t)
	if _, err := client.Initialize(ctx); err == nil {
		t.Fatal("initialize after the adapter exited succeeded")
	}
	if err := client.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
}

func TestAnswerPermissionWithoutRequest(t *testing.T) {
	client, _ := startHelper(t, scenarioModes)
	if err := client.AnswerPermission("missing", "allow"); !errors.Is(err, ErrPermissionGone) {
		t.Fatalf("answer for a missing request = %v, want ErrPermissionGone", err)
	}
}

func TestContentBlockShapes(t *testing.T) {
	encoded, err := json.Marshal([]ContentBlock{
		TextBlock("hi"),
		TextBlock(""),
		ImageBlock("image/png", "aGk="),
	})
	if err != nil {
		t.Fatalf("marshal content blocks: %v", err)
	}
	want := `[{"type":"text","text":"hi"},{"type":"text","text":""},{"type":"image","mimeType":"image/png","data":"aGk="}]`
	if string(encoded) != want {
		t.Fatalf("content blocks = %s, want %s", encoded, want)
	}
}

func TestStartRequiresCommand(t *testing.T) {
	if _, err := Start(Options{}); err == nil {
		t.Fatal("start without a command succeeded")
	}
}

func readLog(t *testing.T, path string) []map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read rpc log: %v", err)
	}
	var frames []map[string]any
	for _, line := range strings.Split(strings.TrimSuffix(string(data), "\n"), "\n") {
		if line == "" {
			continue
		}
		var frame map[string]any
		if err := json.Unmarshal([]byte(line), &frame); err != nil {
			t.Fatalf("rpc log line %q: %v", line, err)
		}
		frames = append(frames, frame)
	}
	return frames
}

func frameWithMethod(t *testing.T, frames []map[string]any, method string) map[string]any {
	t.Helper()
	for _, frame := range frames {
		if frame["method"] == method {
			return frame
		}
	}
	t.Fatalf("no %s frame in the rpc log", method)
	return nil
}

func frameWithID(t *testing.T, frames []map[string]any, id float64) map[string]any {
	t.Helper()
	for _, frame := range frames {
		if _, hasMethod := frame["method"]; hasMethod {
			continue
		}
		if frame["id"] == id {
			return frame
		}
	}
	t.Fatalf("no response with id %v in the rpc log", id)
	return nil
}

func asMap(t *testing.T, value any) map[string]any {
	t.Helper()
	mapped, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("want a JSON object, got %T", value)
	}
	return mapped
}
