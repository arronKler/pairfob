package runtime

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
)

func TestFakeImplementsDeepRuntimeAndCoreFlow(t *testing.T) {
	var _ Runtime = (*Fake)(nil)
	fake := NewFake()
	descriptor, err := fake.Describe(context.Background(), DefaultSession())
	if err != nil || !descriptor.Supports(FeatureCreateConversation) || !descriptor.Supports(FeatureLayoutSwap) {
		t.Fatalf("descriptor=%+v err=%v", descriptor, err)
	}
	if _, err := fake.Execute(context.Background(), DefaultSession(), "op-text", SendTextCommand{PaneID: "w0:p1", Text: "hello-pairfob"}); err != nil {
		t.Fatal(err)
	}
	view, err := fake.Observe(context.Background(), DefaultSession(), PaneReadQuery{PaneID: "w0:p1", Source: SourceVisible, Format: FormatText, Lines: 40})
	if err != nil {
		t.Fatal(err)
	}
	read := view.(PaneReadView)
	if !strings.Contains(read.Text, "hello-pairfob") {
		t.Fatalf("visible readback %q", read.Text)
	}
	if _, err := fake.Execute(context.Background(), DefaultSession(), "op-enter", SendKeysCommand{PaneID: "w0:p1", Keys: []string{"Enter"}}); err != nil {
		t.Fatal(err)
	}
	snapshot := observeFakeSnapshot(t, fake)
	if snapshot.Panes[0].AgentStatus != "working" {
		t.Fatalf("snapshot=%+v", snapshot)
	}
}

func TestFakeTerminalStreamsInputAndResize(t *testing.T) {
	fake := NewFake()
	controller, err := fake.OpenTerminal(context.Background(), TerminalOpen{PaneID: "w0:p1", Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	if event := <-controller.Events(); event.Frame == nil || !event.Frame.Full || event.Frame.Width != 80 {
		t.Fatalf("initial event = %+v", event)
	}
	if err := controller.Input([]byte("echo")); err != nil {
		t.Fatal(err)
	}
	if event := <-controller.Events(); event.Frame == nil || event.Frame.Full || string(event.Frame.Data) != "echo" {
		t.Fatalf("input event = %+v", event)
	}
	if err := controller.Resize(TerminalResize{Cols: 100, Rows: 40}); err != nil {
		t.Fatal(err)
	}
	if event := <-controller.Events(); event.Frame == nil || !event.Frame.Full || event.Frame.Width != 100 || event.Frame.Height != 40 {
		t.Fatalf("resize event = %+v", event)
	}
	if err := controller.Close(); err != nil {
		t.Fatal(err)
	}
	if event := <-controller.Events(); event.Closed == nil {
		t.Fatalf("close event = %+v", event)
	}
}

func TestFakePaneReadZeroLinesMatchesHerdrProtocol19(t *testing.T) {
	fake := NewFake()
	view, err := fake.Observe(context.Background(), DefaultSession(), PaneReadQuery{
		PaneID: "w0:p1", Source: SourceVisible, Format: FormatText, Lines: 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	read := view.(PaneReadView)
	if read.Text != "" || !read.Truncated {
		t.Fatalf("zero-line read = %+v, want empty truncated view", read)
	}
}

func TestFakeRecentPaneReadReturnsBoundedTail(t *testing.T) {
	fake := NewFake()
	fake.Panes["w0:p1"].Text = "one\ntwo\nthree\nfour\n"
	view, err := fake.Observe(context.Background(), DefaultSession(), PaneReadQuery{
		PaneID: "w0:p1", Source: SourceRecentUnwrapped, Format: FormatText, Lines: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	read := view.(PaneReadView)
	if read.Text != "three\nfour\n" || !read.Truncated {
		t.Fatalf("recent read = %+v", read)
	}
}

func TestFakeCreatesTerminalConversationWithoutAgent(t *testing.T) {
	fake := NewFake()
	fake.AgentKinds = nil
	descriptor, err := fake.Describe(context.Background(), DefaultSession())
	if err != nil || !descriptor.Supports(FeatureCreateConversation) || len(descriptor.AgentKinds) != 0 {
		t.Fatalf("descriptor=%+v err=%v", descriptor, err)
	}
	receipt, err := fake.Execute(context.Background(), DefaultSession(), "op-terminal", CreateConversationCommand{
		CWD: "/tmp/project", Label: "shell",
	})
	if err != nil || receipt.Outcome != OutcomeApplied || len(receipt.Created) != 3 {
		t.Fatalf("receipt=%+v err=%v", receipt, err)
	}
	for _, ref := range receipt.Created {
		if ref.Kind == EntityAgent {
			t.Fatalf("terminal conversation created an agent: %+v", receipt.Created)
		}
	}
	snapshot := observeFakeSnapshot(t, fake)
	var pane Pane
	for _, item := range snapshot.Panes {
		if item.PaneID == "w2:p1" {
			pane = item
		}
	}
	if pane.Agent != "" || pane.AgentStatus != "idle" || pane.Cwd != "/tmp/project" {
		t.Fatalf("pane=%+v", pane)
	}
	if _, err := fake.Execute(context.Background(), DefaultSession(), "op-missing-kind", CreateConversationCommand{
		CWD: "/tmp/project", AgentKind: "codex",
	}); err == nil {
		t.Fatal("unavailable agent kind was accepted")
	}
}

func TestFakeCreatesConversationAndLayoutEntities(t *testing.T) {
	fake := NewFake()
	receipt, err := fake.Execute(context.Background(), DefaultSession(), "op-conversation", CreateConversationCommand{
		CWD: "/tmp/project", Label: "project", AgentKind: "codex",
	})
	if err != nil || receipt.Outcome != OutcomeApplied || len(receipt.Created) != 4 {
		t.Fatalf("receipt=%+v err=%v", receipt, err)
	}
	var paneID string
	for _, ref := range receipt.Created {
		if ref.Kind == EntityPane {
			paneID = ref.ID
		}
	}
	if paneID == "" {
		t.Fatal("conversation did not return a pane")
	}
	for i, command := range []Command{
		ResizePaneCommand{PaneID: paneID, Direction: PaneRight},
		SwapPaneCommand{PaneID: paneID, Direction: PaneLeft},
		ZoomPaneCommand{PaneID: paneID, Mode: ZoomToggle},
	} {
		receipt, err := fake.Execute(context.Background(), DefaultSession(), "op-layout-"+string(rune('a'+i)), command)
		if err != nil || receipt.Outcome != OutcomeApplied {
			t.Fatalf("command %T receipt=%+v err=%v", command, receipt, err)
		}
	}
}

func TestFakeSnapshotDeepCopiesTrustedAgentSession(t *testing.T) {
	fake := NewFake()
	label := "original-pane"
	binding := &AgentSessionRef{Source: "hook", Agent: "codex", Kind: "id", Value: "trusted-id"}
	scroll := struct {
		OffsetFromBottom int `json:"offset_from_bottom"`
		ViewportRows     int `json:"viewport_rows"`
	}{OffsetFromBottom: 1, ViewportRows: 24}
	fake.mu.Lock()
	fake.Snap.Panes[0].Label = &label
	fake.Snap.Panes[0].AgentSession = binding
	fake.Snap.Panes[0].HistoryAvailable = true
	fake.Snap.Panes[0].Scroll = &scroll
	fake.mu.Unlock()
	snapshot := observeFakeSnapshot(t, fake)
	encoded, err := json.Marshal(snapshot.Panes[0])
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "trusted-id") || !strings.Contains(string(encoded), `"history_available":true`) {
		t.Fatalf("pane JSON leaked trusted binding or hid availability: %s", encoded)
	}
	var wait sync.WaitGroup
	wait.Add(2)
	go func() {
		defer wait.Done()
		for i := 0; i < 300; i++ {
			snapshot.Focused["pane_id"] = "external"
			snapshot.Workspaces[0].Label = "external"
			*snapshot.Panes[0].Label = "external"
			snapshot.Panes[0].AgentSession.Value = "external"
			snapshot.Panes[0].Scroll.ViewportRows = i
		}
	}()
	go func() {
		defer wait.Done()
		for i := 0; i < 300; i++ {
			_, _ = fake.Execute(context.Background(), DefaultSession(), "rename", RenameWorkspaceCommand{WorkspaceID: "w0", Label: "internal"})
			_, _ = fake.Observe(context.Background(), DefaultSession(), SnapshotQuery{})
		}
	}()
	wait.Wait()
	current := observeFakeSnapshot(t, fake)
	if current.Focused["pane_id"] != "w0:p1" || current.Workspaces[0].Label == "external" || *current.Panes[0].Label == "external" || current.Panes[0].AgentSession.Value != "trusted-id" || current.Panes[0].Scroll.ViewportRows != 24 {
		t.Fatalf("external snapshot mutation escaped into runtime state: %+v", current)
	}
}

func TestHistoryIsTypedUnsupported(t *testing.T) {
	view, err := NewFake().Observe(context.Background(), DefaultSession(), HistoryQuery{PaneID: "w0:p1", Limit: 20})
	if view != nil {
		t.Fatalf("unexpected history view: %+v", view)
	}
	fault, ok := AsFault(err)
	if !ok || fault.Code != CodeUnsupported || fault.Outcome != OutcomeNotApplied {
		t.Fatalf("fault=%+v err=%v", fault, err)
	}
}

func TestFakeCloseWorkspaceRemovesTabsAndPanes(t *testing.T) {
	fake := NewFake()
	receipt, err := fake.Execute(context.Background(), DefaultSession(), "op-close-ws", CloseWorkspaceCommand{WorkspaceID: "w0"})
	if err != nil || receipt.Outcome != OutcomeApplied {
		t.Fatalf("receipt=%+v err=%v", receipt, err)
	}
	snapshot := observeFakeSnapshot(t, fake)
	if len(snapshot.Workspaces) != 0 || len(snapshot.Tabs) != 0 || len(snapshot.Panes) != 0 {
		t.Fatalf("snapshot still has workspace objects: %+v", snapshot)
	}
	if _, err := fake.Execute(context.Background(), DefaultSession(), "op-close-missing", CloseWorkspaceCommand{WorkspaceID: "w0"}); err == nil {
		t.Fatal("expected missing workspace close to fail")
	}
}

func observeFakeSnapshot(t *testing.T, fake *Fake) Snapshot {
	t.Helper()
	view, err := fake.Observe(context.Background(), DefaultSession(), SnapshotQuery{})
	if err != nil {
		t.Fatal(err)
	}
	return view.(SnapshotView).Snapshot
}
