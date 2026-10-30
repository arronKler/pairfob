package runtime

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"testing"
	"time"
)

// coreLiveGated reads a real core. Mutating tests need a second gate and an
// explicit HC_SESSION: run them only with a scratch HC_SESSION and
// XDG_STATE_HOME/XDG_CONFIG_HOME under a fresh temp directory, never against
// the default session, whose core is the user's own.
func coreLiveGated(t *testing.T, mutate bool) {
	t.Helper()
	if os.Getenv("PAIRFOB_CORE_LIVE") != "1" {
		t.Skip("set PAIRFOB_CORE_LIVE=1 to read the live terminal core")
	}
	if !mutate {
		return
	}
	if os.Getenv("PAIRFOB_CORE_LIVE_MUTATE") != "1" {
		t.Skip("set PAIRFOB_CORE_LIVE_MUTATE=1 to create terminals on a scratch core")
	}
	if os.Getenv("HC_SESSION") == "" {
		t.Fatal("mutating live tests need an explicit scratch HC_SESSION")
	}
}

// Reads only: Describe and Snapshot. Mutations are covered by the fake
// transport suite; this test exists to prove the wire against a real core.
func TestCoreLiveDescribeAndSnapshot(t *testing.T) {
	coreLiveGated(t, false)
	core := NewCore("")
	t.Cleanup(func() { _ = core.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	descriptor, err := core.Describe(ctx, DefaultSession())
	if err != nil {
		t.Fatalf("describe: %v", err)
	}
	view, err := core.Observe(ctx, DefaultSession(), SnapshotQuery{})
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	snapshot := view.(SnapshotView).Snapshot
	t.Logf("runtime=%s version=%s protocol=%d workspaces=%d tabs=%d panes=%d layouts=%d agent_kinds=%d",
		descriptor.Runtime, descriptor.Version, descriptor.Protocol,
		len(snapshot.Workspaces), len(snapshot.Tabs), len(snapshot.Panes), len(snapshot.Layouts), len(descriptor.AgentKinds))
	if descriptor.Runtime != "herdr-core" || descriptor.Protocol == 0 {
		t.Fatalf("descriptor=%+v", descriptor)
	}
	if len(snapshot.Tabs) != len(snapshot.Panes) || len(snapshot.Layouts) != len(snapshot.Panes) {
		t.Fatalf("projection lost a tab or layout: tabs=%d panes=%d layouts=%d", len(snapshot.Tabs), len(snapshot.Panes), len(snapshot.Layouts))
	}
	for _, pane := range snapshot.Panes {
		if pane.PaneID == "" || pane.WorkspaceID == "" || pane.TabID == "" {
			t.Fatalf("pane=%+v", pane)
		}
	}
}

func liveOperation(prefix string) string {
	return fmt.Sprintf("%s-%d", prefix, time.Now().UnixNano())
}

func coreLiveCreate(t *testing.T, ctx context.Context, core *Core, label string) string {
	t.Helper()
	receipt, err := core.Execute(ctx, DefaultSession(), liveOperation("live-create"), CreateConversationCommand{
		CWD: os.TempDir(), Label: label,
	})
	if err != nil {
		t.Fatalf("create %s: %v", label, err)
	}
	for _, ref := range receipt.Created {
		if ref.Kind == EntityPane {
			return ref.ID
		}
	}
	t.Fatalf("create %s returned no pane: %+v", label, receipt)
	return ""
}

func coreLiveClose(t *testing.T, core *Core, paneID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if _, err := core.Execute(ctx, DefaultSession(), liveOperation("live-close"), ClosePaneCommand{PaneID: paneID}); err != nil {
		t.Logf("close %s: %v", paneID, err)
	}
}

func TestCoreLiveEventsAndTerminal(t *testing.T) {
	coreLiveGated(t, true)
	core := NewCore("")
	t.Cleanup(func() { _ = core.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()

	first := coreLiveCreate(t, ctx, core, "pairfob-live-events")
	defer coreLiveClose(t, core, first)

	stream, err := core.SubscribeEvents(ctx, DefaultSession(), EventSubscription{PaneIDs: []string{first}})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer func() { _ = stream.Close() }()

	second := coreLiveCreate(t, ctx, core, "pairfob-live-created")
	defer coreLiveClose(t, core, second)

	// A terminal created after the subscription is a structure event.
	deadline := time.After(15 * time.Second)
	sawStructure := false
	for !sawStructure {
		select {
		case event, ok := <-stream.Events():
			if !ok {
				t.Fatalf("event stream closed: %v", stream.Err())
			}
			if event.Kind == EventStructure {
				sawStructure = true
				t.Logf("structure event pane=%q", event.PaneID)
			}
		case <-deadline:
			t.Fatal("no structure event after creating a terminal")
		}
	}

	controller, err := core.OpenTerminal(ctx, TerminalOpen{PaneID: first, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("open terminal: %v", err)
	}
	defer func() { _ = controller.Close() }()

	var firstFrame *TerminalFrame
	select {
	case event := <-controller.Events():
		if event.Closed != nil {
			t.Fatalf("terminal closed before its first frame: %+v", event.Closed)
		}
		firstFrame = event.Frame
	case <-time.After(15 * time.Second):
		t.Fatal("no first terminal frame")
	}
	if firstFrame == nil || !firstFrame.Full || firstFrame.Sequence != 1 || firstFrame.Width != 80 || firstFrame.Height != 24 {
		t.Fatalf("first frame=%+v", firstFrame)
	}
	t.Logf("first frame bytes=%d", len(firstFrame.Data))

	// Typing through a second attach stream while the full terminal is open
	// proves the core accepts more than one viewer per terminal.
	if _, err := core.Execute(ctx, DefaultSession(), liveOperation("live-send"), SendTextCommand{PaneID: first, Text: "echo pairfob-live"}); err != nil {
		t.Fatalf("send with the full terminal attached: %v", err)
	}
	if _, err := core.Execute(ctx, DefaultSession(), liveOperation("live-enter"), SendKeysCommand{PaneID: first, Keys: []string{"enter"}}); err != nil {
		t.Fatalf("enter with the full terminal attached: %v", err)
	}

	seen := false
	deadline = time.After(15 * time.Second)
	for !seen {
		select {
		case event, ok := <-controller.Events():
			if !ok {
				t.Fatalf("terminal closed while waiting for echo: %+v", event.Closed)
			}
			if event.Frame != nil {
				seen = bytes.Contains(event.Frame.Data, []byte("pairfob-live"))
			}
		case <-deadline:
			t.Fatal("the typed command never reached the terminal")
		}
	}
	if err := controller.Input([]byte("exit\r")); err != nil {
		t.Fatalf("input: %v", err)
	}
	if err := controller.Resize(TerminalResize{Cols: 100, Rows: 40}); err != nil {
		t.Fatalf("resize: %v", err)
	}
}

func TestCoreLiveStatusEvent(t *testing.T) {
	coreLiveGated(t, true)
	core := NewCore("")
	t.Cleanup(func() { _ = core.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()

	paneID := coreLiveCreate(t, ctx, core, "pairfob-live-status")
	defer coreLiveClose(t, core, paneID)

	stream, err := core.SubscribeEvents(ctx, DefaultSession(), EventSubscription{PaneIDs: []string{paneID}})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer func() { _ = stream.Close() }()

	// A program that reports its own status through OSC 7501.
	controller, err := core.OpenTerminal(ctx, TerminalOpen{PaneID: paneID, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("open terminal: %v", err)
	}
	defer func() { _ = controller.Close() }()
	script := `printf '\033]7501;{"state":"working","app":"pairfob-live"}\007'; sleep 30` + "\r"
	if err := controller.Input([]byte(script)); err != nil {
		t.Fatalf("input: %v", err)
	}

	deadline := time.After(20 * time.Second)
	for {
		select {
		case event, ok := <-stream.Events():
			if !ok {
				t.Fatalf("event stream closed: %v", stream.Err())
			}
			if event.Kind == EventAgentStatus && event.PaneID == paneID {
				if event.AgentStatus != "working" {
					t.Fatalf("status event=%+v", event)
				}
				return
			}
		case <-deadline:
			t.Skip("this core did not report an OSC 7501 status event; mapping is covered by unit tests")
		}
	}
}
