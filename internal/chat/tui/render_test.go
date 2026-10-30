package tui

import (
	"strings"
	"testing"

	"pairfob/internal/chat/protocol"
)

func TestRenderEntryKinds(t *testing.T) {
	user := renderEntry(protocol.Entry{Kind: protocol.KindUser, Text: "fix\nit"})
	if len(user) != 2 || user[0] != "› fix" || user[1] != "  it" {
		t.Fatalf("user lines = %q", user)
	}

	agentEntry := renderEntry(protocol.Entry{Kind: protocol.KindAgent, Text: "done", Streaming: true})
	if len(agentEntry) != 1 || agentEntry[0] != "● done▌" {
		t.Fatalf("agent lines = %q", agentEntry)
	}

	thought := renderEntry(protocol.Entry{Kind: protocol.KindThought, Text: "thinking"})
	if len(thought) != 1 || thought[0] != "… thinking" {
		t.Fatalf("thought lines = %q", thought)
	}

	notice := renderEntry(protocol.Entry{Kind: protocol.KindNotice, Text: "note"})
	if len(notice) != 1 || notice[0] != "! note" {
		t.Fatalf("notice lines = %q", notice)
	}
}

func TestRenderToolRows(t *testing.T) {
	lines := renderEntry(protocol.Entry{Kind: protocol.KindTool, Tool: &protocol.Tool{
		Title:     "Read a file",
		Kind:      "read",
		Status:    "completed",
		Content:   []protocol.ToolContent{{Type: "text", Text: "one\ntwo"}, {Type: "diff", Path: "/a.txt"}},
		Locations: []string{"/a.txt"},
	}})
	want := []string{
		"⚙ Read a file (read) [completed]",
		"    one",
		"    two",
		"    ± /a.txt",
		"    @ /a.txt",
	}
	if len(lines) != len(want) {
		t.Fatalf("lines = %q", lines)
	}
	for i := range want {
		if lines[i] != want[i] {
			t.Fatalf("line %d = %q, want %q", i, lines[i], want[i])
		}
	}
}

func TestRenderPlan(t *testing.T) {
	state := protocol.NewState("id", "claude", "title")
	state.Plan = []protocol.PlanItem{
		{Content: "done", Status: protocol.PlanCompleted},
		{Content: "now", Status: protocol.PlanInProgress},
		{Content: "later", Status: protocol.PlanPending},
	}
	lines := renderPlan(state)
	want := []string{"plan", "  [x] done", "  [~] now", "  [ ] later"}
	if strings.Join(lines, "\n") != strings.Join(want, "\n") {
		t.Fatalf("plan = %q", lines)
	}
}

func TestWindowLines(t *testing.T) {
	lines := []string{"a", "b", "c", "d", "e"}
	if got := windowLines(lines, 3, 0); strings.Join(got, "") != "cde" {
		t.Fatalf("bottom window = %q", got)
	}
	if got := windowLines(lines, 3, 2); strings.Join(got, "") != "abc" {
		t.Fatalf("scrolled window = %q", got)
	}
	if got := windowLines(lines, 10, 0); len(got) != 5 {
		t.Fatalf("short content window = %q", got)
	}
}

func TestRenderTranscriptEmpty(t *testing.T) {
	lines := renderTranscript(protocol.NewState("id", "claude", "title"))
	if len(lines) != 1 || lines[0] != "no messages yet" {
		t.Fatalf("empty transcript = %q", lines)
	}
}
