package runtime

import "testing"

func TestHerdrCapabilitiesBindTranscriptToProtocol(t *testing.T) {
	t.Parallel()
	live := capabilities(19)
	if !live[FeaturePaneRead].Available || !live[FeatureTranscript].Available {
		t.Fatalf("protocol 19 capabilities = %+v", live)
	}
	if live[FeatureHistory].Available {
		t.Fatal("herdr must leave history to the daemon journal")
	}
	legacy := capabilities(0)
	if legacy[FeaturePaneRead].Available || legacy[FeatureTranscript].Available {
		t.Fatalf("protocol 0 capabilities = %+v", legacy)
	}
}

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
