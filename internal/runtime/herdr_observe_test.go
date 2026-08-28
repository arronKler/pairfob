package runtime

import "testing"

func TestNormalizePaneKeepsLabelSeparateFromTerminalTitle(t *testing.T) {
	t.Parallel()
	pane := normalizePane(herdrPaneWire{
		PaneID: "w1:p1", WorkspaceID: "w1", TabID: "w1:t1",
		Agent: "claude", Title: "  user@host: ~/pairfob  ",
	})
	if pane.Label != nil {
		t.Fatalf("osc title must not become the pane label: %+v", pane.Label)
	}
	if pane.TerminalTitle != "user@host: ~/pairfob" {
		t.Fatalf("terminal title=%q", pane.TerminalTitle)
	}

	named := "auth pane"
	pane = normalizePane(herdrPaneWire{
		PaneID: "w1:p1", WorkspaceID: "w1", TabID: "w1:t1",
		Label: &named, Title: "zsh",
	})
	if pane.Label == nil || *pane.Label != "auth pane" {
		t.Fatalf("user label=%v", pane.Label)
	}
	if pane.TerminalTitle != "zsh" {
		t.Fatalf("terminal title=%q", pane.TerminalTitle)
	}
}
