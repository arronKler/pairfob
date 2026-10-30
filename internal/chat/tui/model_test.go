package tui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"pairfob/internal/chat/protocol"
)

func testModel() *Model {
	state := protocol.NewState("0123456789abcdef", "claude", "claude · pairfob")
	state.Modes = []protocol.Mode{
		{ID: "default", Name: "Default"},
		{ID: "plan", Name: "Plan"},
	}
	state.Mode = "default"
	state.Options = []protocol.Option{{
		ID:           "model",
		Name:         "Model",
		Category:     "model",
		CurrentValue: "sonnet",
		Choices: []protocol.OptionChoice{
			{Value: "sonnet", Name: "Sonnet"},
			{Value: "haiku", Name: "Haiku"},
		},
	}}
	state.Entries = []protocol.Entry{
		{ID: "user-1", Kind: protocol.KindUser, Text: "hi"},
		{ID: "msg-1", Kind: protocol.KindAgent, Text: "hello"},
	}
	return &Model{state: state, width: 80, height: 20}
}

func TestViewShowsTranscriptAndComposer(t *testing.T) {
	m := testModel()
	view := m.View()
	for _, want := range []string{"claude · pairfob · starting", "› hi", "● hello", "│ ", "enter send"} {
		if !strings.Contains(view, want) {
			t.Fatalf("view is missing %q:\n%s", want, view)
		}
	}
}

func TestViewShowsPermissionWithSelection(t *testing.T) {
	m := testModel()
	m.state.Permission = &protocol.Permission{
		ID:    "0",
		Title: "Read a file",
		Options: []protocol.PermissionOption{
			{ID: "allow", Name: "Allow"},
			{ID: "reject", Name: "Reject"},
		},
	}
	view := m.View()
	if !strings.Contains(view, "permission: Read a file") || !strings.Contains(view, "> Allow") {
		t.Fatalf("view is missing the permission prompt:\n%s", view)
	}
	m.permIndex = 1
	view = m.View()
	if !strings.Contains(view, "> Reject") {
		t.Fatalf("selection did not move:\n%s", view)
	}
}

func TestCtrlCTwiceQuits(t *testing.T) {
	m := testModel()
	if _, cmd := m.handleKey(tea.KeyMsg{Type: tea.KeyCtrlC}); cmd != nil {
		t.Fatal("first ctrl+c quit")
	}
	if !m.quitArmed {
		t.Fatal("first ctrl+c did not arm the quit")
	}
	_, cmd := m.handleKey(tea.KeyMsg{Type: tea.KeyCtrlC})
	if cmd == nil {
		t.Fatal("second ctrl+c did not quit")
	}
	if _, ok := cmd().(tea.QuitMsg); !ok {
		t.Fatal("second ctrl+c did not produce a quit message")
	}
}

func TestEscapeNeedsConfirmationToCancel(t *testing.T) {
	m := testModel()
	m.state.Status = protocol.StatusWorking
	escape := tea.KeyMsg{Type: tea.KeyEsc}

	if _, cmd := m.handleKey(escape); cmd != nil {
		t.Fatal("first esc cancelled the turn")
	}
	if !m.cancelArmed {
		t.Fatal("first esc did not arm the cancel")
	}
	if _, cmd := m.handleKey(escape); cmd == nil {
		t.Fatal("second esc did not cancel")
	}
	if m.cancelArmed {
		t.Fatal("cancel stayed armed after firing")
	}

	m.state.Status = protocol.StatusIdle
	if _, cmd := m.handleKey(escape); cmd != nil || m.cancelArmed {
		t.Fatal("esc on an idle transcript started a cancel")
	}
}

func TestEnterSendsTheComposer(t *testing.T) {
	m := testModel()
	m.composer.SetText("fix the test")
	_, cmd := m.handleKey(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("enter did not send")
	}
	if !m.composer.Empty() {
		t.Fatal("composer was not cleared")
	}

	m.composer.SetText("")
	if _, cmd := m.handleKey(tea.KeyMsg{Type: tea.KeyEnter}); cmd != nil {
		t.Fatal("empty composer sent a prompt")
	}
}

func TestNewlineKeys(t *testing.T) {
	m := testModel()
	m.composer.SetText("a")
	m.handleKey(tea.KeyMsg{Type: tea.KeyCtrlJ})
	m.handleKey(tea.KeyMsg{Type: tea.KeyEnter, Alt: true})
	if got := m.composer.Text(); got != "a\n\n" {
		t.Fatalf("composer = %q", got)
	}
}

func TestPermissionEnterAnswers(t *testing.T) {
	m := testModel()
	m.state.Permission = &protocol.Permission{
		ID:      "0",
		Options: []protocol.PermissionOption{{ID: "allow"}, {ID: "reject"}},
	}
	m.permIndex = 1
	_, cmd := m.handleKey(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("enter did not answer the permission")
	}
	if !m.composer.Empty() {
		t.Fatal("the permission answer typed into the composer")
	}
}

func TestMenuSelectsModeAndOption(t *testing.T) {
	m := testModel()
	m.openMenu()
	if m.menu == nil {
		t.Fatal("menu did not open")
	}
	if page := m.menu.current(); len(page.items) != 3 {
		t.Fatalf("root items = %+v", page.items)
	}

	m.handleMenuKey("down")
	m.handleMenuKey("down")
	if index := m.menu.current().index; index != 2 {
		t.Fatalf("index = %d, want the option row", index)
	}
	_, cmd := m.handleMenuKey("enter")
	if cmd != nil || m.menu == nil {
		t.Fatal("option row should open a submenu")
	}
	if len(m.menu.pages) != 2 {
		t.Fatalf("menu pages = %d", len(m.menu.pages))
	}

	m.handleMenuKey("down")
	_, cmd = m.handleMenuKey("enter")
	if cmd == nil {
		t.Fatal("choice did not produce a command")
	}
	if m.menu != nil {
		t.Fatal("menu stayed open after a choice")
	}

	m.openMenu()
	m.handleMenuKey("down")
	m.handleMenuKey("down")
	m.handleMenuKey("enter")
	if len(m.menu.pages) != 2 {
		t.Fatalf("menu pages = %d", len(m.menu.pages))
	}
	m.handleMenuKey("esc")
	if len(m.menu.pages) != 1 {
		t.Fatalf("esc did not return to the root page")
	}
	m.handleMenuKey("esc")
	if m.menu != nil {
		t.Fatal("esc did not close the root page")
	}
}
