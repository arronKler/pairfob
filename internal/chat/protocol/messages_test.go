package protocol

import (
	"encoding/base64"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func boolPtr(value bool) *bool {
	return &value
}

func TestClientMessageGolden(t *testing.T) {
	tests := []struct {
		name    string
		message ClientMessage
		want    string
	}{
		{
			name:    "hello with cursor",
			message: ClientMessage{V: Version, Type: TypeHello, Client: "pairfob-desktop", Cursor: &Cursor{Epoch: "9f2c", Seq: 41}},
			want:    `{"v":1,"type":"hello","client":"pairfob-desktop","cursor":{"epoch":"9f2c","seq":41}}`,
		},
		{
			name:    "prompt command",
			message: ClientMessage{V: Version, Type: TypeCommand, ID: "c1", Command: &Command{Kind: CommandPrompt, Text: "fix the test"}},
			want:    `{"v":1,"type":"command","id":"c1","command":{"kind":"prompt","text":"fix the test"}}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := test.message.Validate(); err != nil {
				t.Fatalf("Validate() = %v", err)
			}
			encoded, err := json.Marshal(test.message)
			if err != nil {
				t.Fatal(err)
			}
			if string(encoded) != test.want {
				t.Fatalf("encoded = %s, want %s", encoded, test.want)
			}
			var decoded ClientMessage
			if err := json.Unmarshal([]byte(test.want), &decoded); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(decoded, test.message) {
				t.Fatalf("decoded = %#v, want %#v", decoded, test.message)
			}
		})
	}
}

func TestClientMessageHelloWithoutCursor(t *testing.T) {
	var message ClientMessage
	if err := json.Unmarshal([]byte(`{"v":1,"type":"hello","client":"pairfob-desktop"}`), &message); err != nil {
		t.Fatal(err)
	}
	if message.Cursor != nil {
		t.Fatalf("cursor = %#v, want nil", message.Cursor)
	}
	if err := message.Validate(); err != nil {
		t.Fatalf("Validate() = %v", err)
	}
}

func TestServerMessageGolden(t *testing.T) {
	tests := []struct {
		name    string
		message ServerMessage
		want    string
	}{
		{
			name:    "welcome",
			message: ServerMessage{V: Version, Type: TypeWelcome, Epoch: "9f2c", Seq: 42},
			want:    `{"v":1,"type":"welcome","epoch":"9f2c","seq":42}`,
		},
		{
			name:    "ok result",
			message: ServerMessage{V: Version, Type: TypeResult, ID: "c1", OK: boolPtr(true)},
			want:    `{"v":1,"type":"result","id":"c1","ok":true}`,
		},
		{
			name:    "failed result",
			message: ServerMessage{V: Version, Type: TypeResult, ID: "c1", OK: boolPtr(false), Error: &Error{Code: ErrCodeUnsupported, Message: "no such command"}},
			want:    `{"v":1,"type":"result","id":"c1","ok":false,"error":{"code":"unsupported","message":"no such command"}}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := test.message.Validate(); err != nil {
				t.Fatalf("Validate() = %v", err)
			}
			encoded, err := json.Marshal(test.message)
			if err != nil {
				t.Fatal(err)
			}
			if string(encoded) != test.want {
				t.Fatalf("encoded = %s, want %s", encoded, test.want)
			}
		})
	}
}

func TestNewStateJSONShape(t *testing.T) {
	state := NewState("0123456789abcdef", "claude", "claude pairfob")
	encoded, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"id":"0123456789abcdef","title":"claude pairfob","agent":"claude","status":"starting",` +
		`"entries":[],"permission":null,"plan":[],"modes":[],"mode":"","options":[],"queue":[],` +
		`"auto_accept":false,"usage":null,"error":""}`
	if string(encoded) != want {
		t.Fatalf("encoded = %s, want %s", encoded, want)
	}
}

func TestStateJSONRoundTrip(t *testing.T) {
	state := &State{
		ID:     "0123456789abcdef",
		Title:  "claude pairfob",
		Agent:  "claude",
		Status: StatusWorking,
		Entries: []Entry{
			{ID: "user-1", Kind: KindUser, Text: "fix the test", At: 1761740000000},
			{ID: "m1", Kind: KindAgent, Text: "reading main.go", Streaming: true, At: 1761740001000},
			{ID: "th1", Kind: KindThought, Text: "maybe the parser", Streaming: true, At: 1761740001500},
			{ID: "notice-1", Kind: KindNotice, Text: "retrying", Level: LevelWarning, At: 1761740002000},
			{ID: "tool-1", Kind: KindTool, Text: "Edit main.go", At: 1761740003000, Tool: &Tool{
				Title:  "Edit main.go",
				Kind:   "edit",
				Status: "running",
				Content: []ToolContent{
					{Type: "text", Text: "apply patch"},
					{Type: "diff", Path: "main.go", Old: "old", New: "new"},
				},
				Locations: []string{"main.go", "main_test.go"},
			}},
		},
		Permission: &Permission{
			ID: "0", Title: "Allow edit?", ToolCallID: "tool-1",
			Options: []PermissionOption{
				{ID: "allow", Name: "Allow", Kind: "allow_once"},
				{ID: "deny", Name: "Deny", Kind: "reject_once"},
			},
		},
		Plan: []PlanItem{
			{Content: "read", Priority: PriorityHigh, Status: PlanCompleted},
			{Content: "edit", Priority: PriorityMedium, Status: PlanInProgress},
		},
		Modes: []Mode{{ID: "default", Name: "Default", Description: "default mode"}},
		Mode:  "default",
		Options: []Option{{
			ID: "model", Name: "Model", Category: "model", CurrentValue: "sonnet",
			Choices: []OptionChoice{
				{Value: "sonnet", Name: "Sonnet", Description: "balanced"},
				{Value: "opus", Name: "Opus", Description: "deep"},
			},
		}},
		Queue:      []QueuedPrompt{{ID: "q1", Text: "then run tests"}},
		AutoAccept: false,
		Usage:      &Usage{Used: 31994, Size: 1000000, CostUSD: 0.16},
		Error:      "adapter restarted",
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	var decoded State
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(decoded, *state) {
		t.Fatalf("decoded = %#v, want %#v", decoded, *state)
	}
}

func TestClientMessageValidate(t *testing.T) {
	attachment := func(name, mime, data string) Attachment {
		return Attachment{Name: name, Mime: mime, Data: data}
	}
	validAttachment := attachment("shot.png", "image/png", base64.StdEncoding.EncodeToString([]byte("png")))
	oversizedAttachment := attachment("huge.png", "image/png", strings.Repeat("A", base64.StdEncoding.EncodedLen(MaxAttachmentBytes+1)))

	tests := []struct {
		name    string
		message ClientMessage
		want    string
	}{
		{"version", ClientMessage{V: 2, Type: TypeHello}, "unsupported protocol version"},
		{"unknown type", ClientMessage{V: Version, Type: "shout"}, "unknown client message type"},
		{"hello", ClientMessage{V: Version, Type: TypeHello, Client: "pairfob-desktop"}, ""},
		{"hello empty epoch", ClientMessage{V: Version, Type: TypeHello, Cursor: &Cursor{Seq: 1}}, "empty epoch"},
		{"hello negative seq", ClientMessage{V: Version, Type: TypeHello, Cursor: &Cursor{Epoch: "9f2c", Seq: -1}}, "negative seq"},
		{"ping", ClientMessage{V: Version, Type: TypePing}, ""},
		{"command empty id", ClientMessage{V: Version, Type: TypeCommand, Command: &Command{Kind: CommandCancel}}, "empty id"},
		{"command no payload", ClientMessage{V: Version, Type: TypeCommand, ID: "c1"}, "no command"},
		{"command unknown kind", ClientMessage{V: Version, Type: TypeCommand, ID: "c1", Command: &Command{Kind: "shout"}}, "unknown command kind"},
		{"prompt", ClientMessage{V: Version, Type: TypeCommand, ID: "c1", Command: &Command{Kind: CommandPrompt, Text: "hi"}}, ""},
		{"prompt attachment", ClientMessage{V: Version, Type: TypeCommand, ID: "c1", Command: &Command{Kind: CommandPrompt, Attachments: []Attachment{validAttachment}}}, ""},
		{"prompt empty", ClientMessage{V: Version, Type: TypeCommand, ID: "c1", Command: &Command{Kind: CommandPrompt}}, "neither text nor attachments"},
		{"prompt oversized", ClientMessage{V: Version, Type: TypeCommand, ID: "c1", Command: &Command{Kind: CommandPrompt, Text: strings.Repeat("x", MaxLineBytes+1)}}, "exceeds 4 MiB"},
		{"attachment empty name", ClientMessage{V: Version, Type: TypeCommand, ID: "c1", Command: &Command{Kind: CommandPrompt, Text: "hi", Attachments: []Attachment{attachment("", "image/png", "eA==")}}}, "empty name"},
		{"attachment empty mime", ClientMessage{V: Version, Type: TypeCommand, ID: "c1", Command: &Command{Kind: CommandPrompt, Text: "hi", Attachments: []Attachment{attachment("shot.png", "", "eA==")}}}, "empty mime"},
		{"attachment bad base64", ClientMessage{V: Version, Type: TypeCommand, ID: "c1", Command: &Command{Kind: CommandPrompt, Text: "hi", Attachments: []Attachment{attachment("shot.png", "image/png", "%%%")}}}, "not base64"},
		{"attachment oversized", ClientMessage{V: Version, Type: TypeCommand, ID: "c1", Command: &Command{Kind: CommandPrompt, Text: "hi", Attachments: []Attachment{oversizedAttachment}}}, "exceeds 8 MiB"},
		{"cancel", ClientMessage{V: Version, Type: TypeCommand, ID: "c1", Command: &Command{Kind: CommandCancel}}, ""},
		{"answer", ClientMessage{V: Version, Type: TypeCommand, ID: "c1", Command: &Command{Kind: CommandAnswer, RequestID: "0", OptionID: "allow"}}, ""},
		{"answer missing request", ClientMessage{V: Version, Type: TypeCommand, ID: "c1", Command: &Command{Kind: CommandAnswer, OptionID: "allow"}}, "empty request_id"},
		{"answer missing option", ClientMessage{V: Version, Type: TypeCommand, ID: "c1", Command: &Command{Kind: CommandAnswer, RequestID: "0"}}, "empty option_id"},
		{"set mode", ClientMessage{V: Version, Type: TypeCommand, ID: "c1", Command: &Command{Kind: CommandSetMode, ModeID: "plan"}}, ""},
		{"set mode missing id", ClientMessage{V: Version, Type: TypeCommand, ID: "c1", Command: &Command{Kind: CommandSetMode}}, "empty mode_id"},
		{"set option", ClientMessage{V: Version, Type: TypeCommand, ID: "c1", Command: &Command{Kind: CommandSetOption, OptionID: "model", Value: "opus"}}, ""},
		{"set option missing id", ClientMessage{V: Version, Type: TypeCommand, ID: "c1", Command: &Command{Kind: CommandSetOption, Value: "opus"}}, "empty option_id"},
		{"unqueue", ClientMessage{V: Version, Type: TypeCommand, ID: "c1", Command: &Command{Kind: CommandUnqueue, QueueID: "q1"}}, ""},
		{"unqueue missing id", ClientMessage{V: Version, Type: TypeCommand, ID: "c1", Command: &Command{Kind: CommandUnqueue}}, "empty queue_id"},
		{"auto accept", ClientMessage{V: Version, Type: TypeCommand, ID: "c1", Command: &Command{Kind: CommandSetAutoAccept, Enabled: boolPtr(true)}}, ""},
		{"auto accept missing flag", ClientMessage{V: Version, Type: TypeCommand, ID: "c1", Command: &Command{Kind: CommandSetAutoAccept}}, "no enabled flag"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := test.message.Validate()
			if test.want == "" {
				if err != nil {
					t.Fatalf("Validate() = %v, want nil", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("Validate() = %v, want containing %q", err, test.want)
			}
		})
	}
}

func TestServerMessageValidate(t *testing.T) {
	tests := []struct {
		name    string
		message ServerMessage
		want    string
	}{
		{"version", ServerMessage{V: 2, Type: TypeWelcome, Epoch: "9f2c"}, "unsupported protocol version"},
		{"unknown type", ServerMessage{V: Version, Type: "shout"}, "unknown server message type"},
		{"welcome", ServerMessage{V: Version, Type: TypeWelcome, Epoch: "9f2c", Seq: 1}, ""},
		{"welcome empty epoch", ServerMessage{V: Version, Type: TypeWelcome}, "empty epoch"},
		{"snapshot", ServerMessage{V: Version, Type: TypeSnapshot, Epoch: "9f2c", Seq: 1, State: NewState("id", "claude", "t")}, ""},
		{"snapshot no state", ServerMessage{V: Version, Type: TypeSnapshot, Epoch: "9f2c", Seq: 1}, "no state"},
		{"changes", ServerMessage{V: Version, Type: TypeChanges, Epoch: "9f2c", Changes: []Change{{Seq: 2, Ops: []Op{{Op: OpSetTitle, Title: "t"}}}}}, ""},
		{"changes no list", ServerMessage{V: Version, Type: TypeChanges, Epoch: "9f2c"}, "no changes"},
		{"changes bad op", ServerMessage{V: Version, Type: TypeChanges, Epoch: "9f2c", Changes: []Change{{Seq: 2, Ops: []Op{{Op: "explode"}}}}}, "unknown op"},
		{"result ok", ServerMessage{V: Version, Type: TypeResult, ID: "c1", OK: boolPtr(true)}, ""},
		{"result no id", ServerMessage{V: Version, Type: TypeResult, OK: boolPtr(true)}, "empty id"},
		{"result no ok", ServerMessage{V: Version, Type: TypeResult, ID: "c1"}, "no ok flag"},
		{"result failure", ServerMessage{V: Version, Type: TypeResult, ID: "c1", OK: boolPtr(false), Error: &Error{Code: ErrCodeBusy, Message: "turn running"}}, ""},
		{"result failure no error", ServerMessage{V: Version, Type: TypeResult, ID: "c1", OK: boolPtr(false)}, "no error"},
		{"result failure empty code", ServerMessage{V: Version, Type: TypeResult, ID: "c1", OK: boolPtr(false), Error: &Error{Message: "x"}}, "empty code"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := test.message.Validate()
			if test.want == "" {
				if err != nil {
					t.Fatalf("Validate() = %v, want nil", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("Validate() = %v, want containing %q", err, test.want)
			}
		})
	}
}

func TestChangeValidate(t *testing.T) {
	if err := (Change{Seq: 42, Ops: []Op{{Op: OpSetStatus, Status: StatusIdle}}}).Validate(); err != nil {
		t.Fatalf("Validate() = %v", err)
	}
	if err := (Change{Seq: -1}).Validate(); err == nil {
		t.Fatal("Validate() accepted a negative seq")
	}
	if err := (Change{Seq: 1, Ops: []Op{{Op: OpAppendEntry, Entry: &Entry{ID: "x", Kind: "speech"}}}}).Validate(); err == nil {
		t.Fatal("Validate() accepted an unknown entry kind")
	}
}

func TestOpValidate(t *testing.T) {
	validEntry := func() *Entry {
		return &Entry{ID: "m1", Kind: KindAgent, Text: "hello"}
	}
	tests := []struct {
		name string
		op   Op
		want string
	}{
		{"unknown", Op{Op: "explode"}, "unknown op"},
		{"append entry", Op{Op: OpAppendEntry, Entry: validEntry()}, ""},
		{"append entry no payload", Op{Op: OpAppendEntry}, "no entry"},
		{"append entry empty id", Op{Op: OpAppendEntry, Entry: &Entry{Kind: KindAgent}}, "empty id"},
		{"append entry unknown kind", Op{Op: OpAppendEntry, Entry: &Entry{ID: "m1", Kind: "speech"}}, "unknown entry kind"},
		{"append entry oversized", Op{Op: OpAppendEntry, Entry: &Entry{ID: "m1", Kind: KindAgent, Text: strings.Repeat("x", MaxLineBytes+1)}}, "exceeds 4 MiB"},
		{"set entry", Op{Op: OpSetEntry, Entry: validEntry()}, ""},
		{"append text", Op{Op: OpAppendText, ID: "m1", Text: "more"}, ""},
		{"append text empty id", Op{Op: OpAppendText}, "empty id"},
		{"append text oversized", Op{Op: OpAppendText, ID: "m1", Text: strings.Repeat("x", MaxLineBytes+1)}, "exceeds 4 MiB"},
		{"set streaming", Op{Op: OpSetStreaming, ID: "m1", Streaming: boolPtr(true)}, ""},
		{"set streaming empty id", Op{Op: OpSetStreaming, Streaming: boolPtr(true)}, "empty id"},
		{"set streaming no flag", Op{Op: OpSetStreaming, ID: "m1"}, "no streaming flag"},
		{"remove entry", Op{Op: OpRemoveEntry, ID: "m1"}, ""},
		{"remove entry empty id", Op{Op: OpRemoveEntry}, "empty id"},
		{"set status", Op{Op: OpSetStatus, Status: StatusBlocked}, ""},
		{"set status unknown", Op{Op: OpSetStatus, Status: "sleeping"}, "unknown status"},
		{"set status empty", Op{Op: OpSetStatus}, "unknown status"},
		{"clear permission", Op{Op: OpSetPermission}, ""},
		{"set permission", Op{Op: OpSetPermission, Permission: &Permission{ID: "0", Options: []PermissionOption{{ID: "allow"}}}}, ""},
		{"set permission empty id", Op{Op: OpSetPermission, Permission: &Permission{}}, "empty id"},
		{"set permission empty option", Op{Op: OpSetPermission, Permission: &Permission{ID: "0", Options: []PermissionOption{{Name: "Allow"}}}}, "empty id"},
		{"set plan", Op{Op: OpSetPlan, Plan: []PlanItem{{Content: "read", Priority: PriorityLow, Status: PlanPending}}}, ""},
		{"set plan empty content", Op{Op: OpSetPlan, Plan: []PlanItem{{Priority: PriorityLow, Status: PlanPending}}}, "empty content"},
		{"set plan unknown status", Op{Op: OpSetPlan, Plan: []PlanItem{{Content: "read", Status: "doing"}}}, "unknown plan status"},
		{"set plan unknown priority", Op{Op: OpSetPlan, Plan: []PlanItem{{Content: "read", Priority: "urgent"}}}, "unknown plan priority"},
		{"set modes", Op{Op: OpSetModes, Modes: []Mode{{ID: "default"}}, Mode: "default"}, ""},
		{"set modes empty id", Op{Op: OpSetModes, Modes: []Mode{{Name: "Default"}}}, "empty id"},
		{"set options", Op{Op: OpSetOptions, Options: []Option{{ID: "model"}}}, ""},
		{"set options empty id", Op{Op: OpSetOptions, Options: []Option{{Name: "Model"}}}, "empty id"},
		{"set queue", Op{Op: OpSetQueue, Queue: []QueuedPrompt{{ID: "q1", Text: "next"}}}, ""},
		{"set queue empty id", Op{Op: OpSetQueue, Queue: []QueuedPrompt{{Text: "next"}}}, "empty id"},
		{"set auto accept", Op{Op: OpSetAutoAccept, Enabled: boolPtr(false)}, ""},
		{"set auto accept no flag", Op{Op: OpSetAutoAccept}, "no enabled flag"},
		{"set title", Op{Op: OpSetTitle, Title: "new"}, ""},
		{"set usage", Op{Op: OpSetUsage, Usage: &Usage{Used: 1, Size: 2}}, ""},
		{"set usage no payload", Op{Op: OpSetUsage}, "no usage"},
		{"set error", Op{Op: OpSetError, Error: "boom"}, ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := test.op.Validate()
			if test.want == "" {
				if err != nil {
					t.Fatalf("Validate() = %v, want nil", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("Validate() = %v, want containing %q", err, test.want)
			}
		})
	}
}

func TestOpJSONKeepsExplicitFalse(t *testing.T) {
	tests := []struct {
		name string
		op   Op
		want string
	}{
		{"streaming false", Op{Op: OpSetStreaming, ID: "m1", Streaming: boolPtr(false)}, `{"op":"set_streaming","id":"m1","streaming":false}`},
		{"auto accept false", Op{Op: OpSetAutoAccept, Enabled: boolPtr(false)}, `{"op":"set_auto_accept","enabled":false}`},
		{"clear permission", Op{Op: OpSetPermission}, `{"op":"set_permission"}`},
		{"append text", Op{Op: OpAppendText, ID: "m1", Text: ""}, `{"op":"append_text","id":"m1"}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			encoded, err := json.Marshal(test.op)
			if err != nil {
				t.Fatal(err)
			}
			if string(encoded) != test.want {
				t.Fatalf("encoded = %s, want %s", encoded, test.want)
			}
		})
	}
}
