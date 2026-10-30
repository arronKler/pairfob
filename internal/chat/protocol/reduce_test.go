package protocol

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func fullState() *State {
	return &State{
		ID:     "0123456789abcdef",
		Title:  "claude pairfob",
		Agent:  "claude",
		Status: StatusWorking,
		Entries: []Entry{
			{ID: "user-1", Kind: KindUser, Text: "hi", At: 1},
			{ID: "m1", Kind: KindAgent, Text: "hello", Streaming: true, At: 2},
			{ID: "th1", Kind: KindThought, Text: "hmm", At: 3},
			{ID: "notice-1", Kind: KindNotice, Text: "note", Level: LevelInfo, At: 4},
			{ID: "tool-1", Kind: KindTool, Text: "tool", At: 5, Tool: &Tool{
				Title: "Edit", Kind: "edit", Status: "running",
				Content: []ToolContent{
					{Type: "text", Text: "apply"},
					{Type: "diff", Path: "a.go", Old: "old", New: "new"},
				},
				Locations: []string{"a.go"},
			}},
		},
		Permission: &Permission{
			ID: "0", Title: "Allow edit?", ToolCallID: "tool-1",
			Options: []PermissionOption{{ID: "allow", Name: "Allow", Kind: "allow_once"}},
		},
		Plan:  []PlanItem{{Content: "read", Priority: PriorityHigh, Status: PlanPending}},
		Modes: []Mode{{ID: "default", Name: "Default", Description: "default mode"}},
		Mode:  "default",
		Options: []Option{{
			ID: "model", Name: "Model", Category: "model", CurrentValue: "sonnet",
			Choices: []OptionChoice{{Value: "sonnet", Name: "Sonnet", Description: "balanced"}},
		}},
		Queue:      []QueuedPrompt{{ID: "q1", Text: "next"}},
		AutoAccept: true,
		Usage:      &Usage{Used: 1, Size: 2, CostUSD: 0.5},
	}
}

func TestApplyTranscriptOps(t *testing.T) {
	state := NewState("0123456789abcdef", "claude", "claude pairfob")
	err := state.Apply([]Op{
		{Op: OpSetStatus, Status: StatusWorking},
		{Op: OpAppendEntry, Entry: &Entry{ID: "user-1", Kind: KindUser, Text: "fix the test"}},
		{Op: OpAppendEntry, Entry: &Entry{ID: "m1", Kind: KindAgent, Text: "look", Streaming: true}},
		{Op: OpAppendText, ID: "m1", Text: "ing"},
		{Op: OpSetStreaming, ID: "m1", Streaming: boolPtr(false)},
		{Op: OpAppendEntry, Entry: &Entry{ID: "notice-1", Kind: KindNotice, Text: "note", Level: LevelInfo}},
		{Op: OpSetEntry, Entry: &Entry{ID: "notice-1", Kind: KindNotice, Text: "updated", Level: LevelWarning}},
		{Op: OpRemoveEntry, ID: "notice-1"},
	})
	if err != nil {
		t.Fatalf("Apply() = %v", err)
	}
	if state.Status != StatusWorking {
		t.Fatalf("status = %q", state.Status)
	}
	if len(state.Entries) != 2 {
		t.Fatalf("entries = %d, want 2", len(state.Entries))
	}
	if state.Entries[0].Text != "fix the test" || state.Entries[0].Kind != KindUser {
		t.Fatalf("entry 0 = %#v", state.Entries[0])
	}
	if state.Entries[1].Text != "looking" || state.Entries[1].Streaming {
		t.Fatalf("entry 1 = %#v", state.Entries[1])
	}
	if _, ok := state.Entry("notice-1"); ok {
		t.Fatal("removed entry is still present")
	}
}

func TestApplyAppendTextAndStreaming(t *testing.T) {
	state := NewState("id", "claude", "t")
	if err := state.Apply([]Op{{Op: OpAppendEntry, Entry: &Entry{ID: "m1", Kind: KindAgent}}}); err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"a", "b", "c"} {
		if err := state.Apply([]Op{{Op: OpAppendText, ID: "m1", Text: text}}); err != nil {
			t.Fatal(err)
		}
	}
	entry, ok := state.Entry("m1")
	if !ok || entry.Text != "abc" {
		t.Fatalf("entry = %#v, want text abc", entry)
	}
	if err := state.Apply([]Op{{Op: OpSetStreaming, ID: "m1", Streaming: boolPtr(true)}}); err != nil {
		t.Fatal(err)
	}
	if entry, _ := state.Entry("m1"); !entry.Streaming {
		t.Fatal("streaming flag was not set")
	}
	if err := state.Apply([]Op{{Op: OpSetStreaming, ID: "m1", Streaming: boolPtr(false)}}); err != nil {
		t.Fatal(err)
	}
	if entry, _ := state.Entry("m1"); entry.Streaming {
		t.Fatal("streaming flag was not cleared")
	}
}

func TestApplySessionOps(t *testing.T) {
	state := NewState("id", "claude", "t")
	err := state.Apply([]Op{
		{Op: OpSetStatus, Status: StatusBlocked},
		{Op: OpSetPermission, Permission: &Permission{
			ID: "0", Title: "Allow edit?", ToolCallID: "tool-1",
			Options: []PermissionOption{{ID: "allow", Name: "Allow", Kind: "allow_once"}},
		}},
		{Op: OpSetPlan, Plan: []PlanItem{{Content: "read", Priority: PriorityHigh, Status: PlanPending}}},
		{Op: OpSetModes, Modes: []Mode{{ID: "default", Name: "Default"}, {ID: "plan", Name: "Plan"}}, Mode: "plan"},
		{Op: OpSetOptions, Options: []Option{{ID: "model", Name: "Model", Category: "model", CurrentValue: "sonnet"}}},
		{Op: OpSetQueue, Queue: []QueuedPrompt{{ID: "q1", Text: "next"}}},
		{Op: OpSetAutoAccept, Enabled: boolPtr(true)},
		{Op: OpSetTitle, Title: "new title"},
		{Op: OpSetUsage, Usage: &Usage{Used: 10, Size: 100, CostUSD: 0.01}},
		{Op: OpSetError, Error: "adapter died"},
	})
	if err != nil {
		t.Fatalf("Apply() = %v", err)
	}
	if state.Status != StatusBlocked || state.Mode != "plan" || !state.AutoAccept {
		t.Fatalf("state = %#v", state)
	}
	if len(state.Modes) != 2 || len(state.Options) != 1 || len(state.Queue) != 1 || len(state.Plan) != 1 {
		t.Fatalf("state = %#v", state)
	}
	if state.Title != "new title" || state.Error != "adapter died" {
		t.Fatalf("title = %q, error = %q", state.Title, state.Error)
	}
	if state.Usage == nil || state.Usage.Used != 10 || state.Usage.CostUSD != 0.01 {
		t.Fatalf("usage = %#v", state.Usage)
	}
	if _, ok := state.PermissionOption("allow"); !ok {
		t.Fatal("permission option not found")
	}
	if err := state.Apply([]Op{{Op: OpSetError}}); err != nil {
		t.Fatal(err)
	}
	if state.Error != "" {
		t.Fatalf("error = %q, want cleared", state.Error)
	}
}

func TestApplyPermissionSetAndClear(t *testing.T) {
	state := NewState("id", "claude", "t")
	if err := state.Apply([]Op{{Op: OpSetPermission, Permission: &Permission{
		ID: "0", Options: []PermissionOption{{ID: "allow", Name: "Allow"}},
	}}}); err != nil {
		t.Fatal(err)
	}
	if state.Permission == nil || state.Permission.ID != "0" {
		t.Fatalf("permission = %#v", state.Permission)
	}
	if option, ok := state.PermissionOption("allow"); !ok || option.Name != "Allow" {
		t.Fatalf("option = %#v, ok = %v", option, ok)
	}
	if err := state.Apply([]Op{{Op: OpSetPermission}}); err != nil {
		t.Fatal(err)
	}
	if state.Permission != nil {
		t.Fatalf("permission = %#v, want nil", state.Permission)
	}
	if _, ok := state.PermissionOption("allow"); ok {
		t.Fatal("cleared permission still resolves an option")
	}
}

func TestApplyAtomicFailure(t *testing.T) {
	state := NewState("id", "claude", "t")
	if err := state.Apply([]Op{{Op: OpAppendEntry, Entry: &Entry{ID: "user-1", Kind: KindUser, Text: "hi"}}}); err != nil {
		t.Fatal(err)
	}
	before := state.Clone()
	err := state.Apply([]Op{
		{Op: OpSetTitle, Title: "changed"},
		{Op: OpSetStatus, Status: StatusIdle},
		{Op: OpAppendText, ID: "missing", Text: "x"},
	})
	if err == nil {
		t.Fatal("Apply() accepted a missing entry")
	}
	if !reflect.DeepEqual(state, before) {
		t.Fatalf("state changed after a failed change: %#v", state)
	}
}

func TestApplyDuplicateEntry(t *testing.T) {
	state := NewState("id", "claude", "t")
	before := state.Clone()
	err := state.Apply([]Op{
		{Op: OpAppendEntry, Entry: &Entry{ID: "m1", Kind: KindAgent, Text: "one"}},
		{Op: OpAppendEntry, Entry: &Entry{ID: "m1", Kind: KindAgent, Text: "two"}},
	})
	if err == nil {
		t.Fatal("Apply() accepted a duplicate entry id")
	}
	if !reflect.DeepEqual(state, before) {
		t.Fatalf("state changed after a duplicate append: %#v", state)
	}
	if len(state.Entries) != 0 {
		t.Fatalf("entries = %d, want 0", len(state.Entries))
	}
}

func TestApplyMissingEntry(t *testing.T) {
	ops := []Op{
		{Op: OpSetEntry, Entry: &Entry{ID: "missing", Kind: KindAgent}},
		{Op: OpAppendText, ID: "missing", Text: "x"},
		{Op: OpSetStreaming, ID: "missing", Streaming: boolPtr(true)},
		{Op: OpRemoveEntry, ID: "missing"},
	}
	for _, op := range ops {
		t.Run(op.Op, func(t *testing.T) {
			state := NewState("id", "claude", "t")
			if err := state.Apply([]Op{{Op: OpAppendEntry, Entry: &Entry{ID: "m1", Kind: KindAgent}}}); err != nil {
				t.Fatal(err)
			}
			before := state.Clone()
			if err := state.Apply([]Op{op}); err == nil {
				t.Fatalf("Apply() accepted %s on a missing id", op.Op)
			}
			if !reflect.DeepEqual(state, before) {
				t.Fatalf("state changed after a failed %s", op.Op)
			}
		})
	}
}

func TestApplyClearsListsToArrays(t *testing.T) {
	state := fullState()
	err := state.Apply([]Op{
		{Op: OpSetPlan},
		{Op: OpSetModes},
		{Op: OpSetOptions},
		{Op: OpSetQueue},
	})
	if err != nil {
		t.Fatalf("Apply() = %v", err)
	}
	if state.Plan == nil || state.Modes == nil || state.Options == nil || state.Queue == nil {
		t.Fatalf("state = %#v, want empty slices", state)
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	for _, list := range []string{`"plan":null`, `"modes":null`, `"options":null`, `"queue":null`} {
		if strings.Contains(string(encoded), list) {
			t.Fatalf("encoded state contains %s: %s", list, encoded)
		}
	}
}

func TestApplyUnknownOp(t *testing.T) {
	state := NewState("id", "claude", "t")
	before := state.Clone()
	if err := state.Apply([]Op{{Op: "explode"}}); err == nil {
		t.Fatal("Apply() accepted an unknown op")
	}
	if !reflect.DeepEqual(state, before) {
		t.Fatal("state changed after an unknown op")
	}
	if err := state.Apply(nil); err != nil {
		t.Fatalf("Apply(nil) = %v", err)
	}
}

func TestApplySetStatus(t *testing.T) {
	state := NewState("id", "claude", "t")
	for _, status := range []string{StatusIdle, StatusWorking, StatusBlocked, StatusExited, StatusStarting} {
		if err := state.Apply([]Op{{Op: OpSetStatus, Status: status}}); err != nil {
			t.Fatalf("Apply(%q) = %v", status, err)
		}
		if state.Status != status {
			t.Fatalf("status = %q, want %q", state.Status, status)
		}
	}
	before := state.Clone()
	if err := state.Apply([]Op{{Op: OpSetStatus, Status: "sleeping"}}); err == nil {
		t.Fatal("Apply() accepted an unknown status")
	}
	if !reflect.DeepEqual(state, before) {
		t.Fatal("state changed after an unknown status")
	}
}

func TestCloneDeepCopy(t *testing.T) {
	original := fullState()
	before := original.Clone()
	clone := original.Clone()

	clone.Entries[0].Text = "changed"
	clone.Entries[4].Tool.Title = "changed"
	clone.Entries[4].Tool.Content[0].Text = "changed"
	clone.Entries[4].Tool.Locations[0] = "changed"
	clone.Permission.Options[0].Name = "changed"
	clone.Plan[0].Content = "changed"
	clone.Modes[0].Name = "changed"
	clone.Options[0].Choices[0].Name = "changed"
	clone.Queue[0].Text = "changed"
	clone.Usage.Used = 99

	if !reflect.DeepEqual(original, before) {
		t.Fatalf("clone shares payloads with the original: %#v", original)
	}
}

func TestClonePreservesNil(t *testing.T) {
	var zero State
	clone := zero.Clone()
	if clone.Entries != nil || clone.Plan != nil || clone.Modes != nil || clone.Options != nil || clone.Queue != nil {
		t.Fatalf("clone = %#v, want nil slices", clone)
	}
	if clone.Permission != nil || clone.Usage != nil {
		t.Fatalf("clone = %#v, want nil pointers", clone)
	}
	var nilState *State
	if nilState.Clone() != nil {
		t.Fatal("nil state cloned to a non-nil state")
	}
}

func TestNewStateAndLookups(t *testing.T) {
	state := NewState("0123456789abcdef", "claude", "claude pairfob")
	if state.ID != "0123456789abcdef" || state.Agent != "claude" || state.Title != "claude pairfob" {
		t.Fatalf("state = %#v", state)
	}
	if state.Status != StatusStarting {
		t.Fatalf("status = %q, want %q", state.Status, StatusStarting)
	}
	if state.Entries == nil || state.Plan == nil || state.Modes == nil || state.Options == nil || state.Queue == nil {
		t.Fatalf("state = %#v, want empty slices", state)
	}
	if _, ok := state.Entry("m1"); ok {
		t.Fatal("found an entry in an empty state")
	}
	if err := state.Apply([]Op{{Op: OpAppendEntry, Entry: &Entry{ID: "m1", Kind: KindAgent, Text: "hello"}}}); err != nil {
		t.Fatal(err)
	}
	if entry, ok := state.Entry("m1"); !ok || entry.Text != "hello" {
		t.Fatalf("entry = %#v, ok = %v", entry, ok)
	}
	var nilState *State
	if _, ok := nilState.Entry("m1"); ok {
		t.Fatal("nil state returned an entry")
	}
	if _, ok := nilState.PermissionOption("allow"); ok {
		t.Fatal("nil state returned a permission option")
	}
	var nilUsage State
	if _, ok := nilUsage.PermissionOption("allow"); ok {
		t.Fatal("state without a permission returned an option")
	}
}

func TestApplyCopiesEntryPayload(t *testing.T) {
	state := NewState("id", "claude", "t")
	entry := &Entry{ID: "m1", Kind: KindTool, Tool: &Tool{
		Title:     "Edit",
		Content:   []ToolContent{{Type: "text", Text: "apply"}},
		Locations: []string{"a.go"},
	}}
	if err := state.Apply([]Op{{Op: OpAppendEntry, Entry: entry}}); err != nil {
		t.Fatal(err)
	}
	entry.Text = "changed"
	entry.Tool.Title = "changed"
	entry.Tool.Content[0].Text = "changed"
	entry.Tool.Locations[0] = "changed"
	stored, _ := state.Entry("m1")
	if stored.Text != "" || stored.Tool.Title != "Edit" || stored.Tool.Content[0].Text != "apply" || stored.Tool.Locations[0] != "a.go" {
		t.Fatalf("state shares the op payload: %#v", stored)
	}

	replacement := &Entry{ID: "m1", Kind: KindAgent, Text: "replaced"}
	if err := state.Apply([]Op{{Op: OpSetEntry, Entry: replacement}}); err != nil {
		t.Fatal(err)
	}
	replacement.Text = "changed"
	if stored, _ := state.Entry("m1"); stored.Text != "replaced" {
		t.Fatalf("state shares the set_entry payload: %#v", stored)
	}
}

func TestApplyChangeJSON(t *testing.T) {
	state := NewState("0123456789abcdef", "claude", "t")
	line := `{"seq":42,"ops":[` +
		`{"op":"append_entry","entry":{"id":"user-1","kind":"user","text":"hi","streaming":false,"at":1}},` +
		`{"op":"set_status","status":"working"}]}`
	var change Change
	if err := json.Unmarshal([]byte(line), &change); err != nil {
		t.Fatal(err)
	}
	if err := change.Validate(); err != nil {
		t.Fatalf("Validate() = %v", err)
	}
	if err := state.Apply(change.Ops); err != nil {
		t.Fatalf("Apply() = %v", err)
	}
	if state.Status != StatusWorking {
		t.Fatalf("status = %q", state.Status)
	}
	if entry, ok := state.Entry("user-1"); !ok || entry.Text != "hi" || entry.At != 1 {
		t.Fatalf("entry = %#v, ok = %v", entry, ok)
	}
}
