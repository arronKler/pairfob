package runtime

import (
	"context"
	"testing"
	"time"
)

func openCoreTerminal(t *testing.T, core *Core, fake *fakeCoreTransport, open TerminalOpen) (TerminalController, uint32, chan coreStreamItem) {
	t.Helper()
	controller, err := core.OpenTerminal(context.Background(), open)
	if err != nil {
		t.Fatal(err)
	}
	channel, items := fake.lastOutput()
	if items == nil {
		t.Fatal("open terminal did not install an output stream")
	}
	return controller, channel, items
}

func nextCoreTerminalEvent(t *testing.T, controller TerminalController) TerminalEvent {
	t.Helper()
	select {
	case event, ok := <-controller.Events():
		if !ok {
			t.Fatal("terminal events closed")
		}
		return event
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for a terminal event")
		return TerminalEvent{}
	}
}

func TestCoreOpenTerminalFrames(t *testing.T) {
	fake := newFakeCoreTransport()
	core := newTestCore(t, fake)
	controller, channel, items := openCoreTerminal(t, core, fake, TerminalOpen{PaneID: "devbox:t7", Cols: 100, Rows: 40})
	if attaches := fake.attachLog(); len(attaches) != 1 || attaches[0] != (coreFakeAttach{terminal: "devbox/t7", cols: 100, rows: 40}) {
		t.Fatalf("attaches=%+v", attaches)
	}

	items <- coreStreamItem{kind: coreKindData, payload: []byte("first paint")}
	first := nextCoreTerminalEvent(t, controller)
	if first.Frame == nil || first.Frame.Sequence != 1 || !first.Frame.Full || first.Frame.Width != 100 ||
		first.Frame.Height != 40 || string(first.Frame.Data) != "first paint" {
		t.Fatalf("first=%+v", first)
	}

	items <- coreStreamItem{kind: coreKindData, payload: []byte("live")}
	second := nextCoreTerminalEvent(t, controller)
	if second.Frame == nil || second.Frame.Sequence != 2 || second.Frame.Full || string(second.Frame.Data) != "live" {
		t.Fatalf("second=%+v", second)
	}

	items <- coreStreamItem{kind: coreKindResize, cols: 132, rows: 43}
	items <- coreStreamItem{kind: coreKindData, payload: []byte("after resize")}
	third := nextCoreTerminalEvent(t, controller)
	if third.Frame == nil || third.Frame.Sequence != 3 || third.Frame.Width != 132 || third.Frame.Height != 43 {
		t.Fatalf("third=%+v", third)
	}

	if err := controller.Input([]byte("ls\r")); err != nil {
		t.Fatal(err)
	}
	typed := fake.typedLog()
	if len(typed) != 1 || typed[0].channel != channel || string(typed[0].data) != "ls\r" {
		t.Fatalf("typed=%+v", typed)
	}
	if err := controller.Resize(TerminalResize{Cols: 90, Rows: 30}); err != nil {
		t.Fatal(err)
	}
	if resizes := fake.resizeLog(); len(resizes) != 1 || resizes[0] != (coreFakeResize{channel: channel, cols: 90, rows: 30}) {
		t.Fatalf("resizes=%+v", resizes)
	}
	items <- coreStreamItem{kind: coreKindData, payload: []byte("after local resize")}
	fourth := nextCoreTerminalEvent(t, controller)
	if fourth.Frame == nil || fourth.Frame.Width != 90 || fourth.Frame.Height != 30 {
		t.Fatalf("fourth=%+v", fourth)
	}

	if err := controller.Close(); err != nil {
		t.Fatal(err)
	}
	if err := controller.Close(); err != nil {
		t.Fatal(err)
	}
	if closed := fake.closedLog(); len(closed) != 1 || closed[0] != channel {
		t.Fatalf("closed=%v", closed)
	}
	<-controller.Events()
}

func TestCoreOpenTerminalClosedStream(t *testing.T) {
	fake := newFakeCoreTransport()
	core := newTestCore(t, fake)
	controller, channel, items := openCoreTerminal(t, core, fake, TerminalOpen{PaneID: "t3", Cols: 80, Rows: 24})
	items <- coreStreamItem{kind: coreKindData, payload: []byte("screen")}
	fake.closeOutput(channel)
	first := nextCoreTerminalEvent(t, controller)
	if first.Frame == nil || string(first.Frame.Data) != "screen" {
		t.Fatalf("first=%+v", first)
	}
	closed := nextCoreTerminalEvent(t, controller)
	if closed.Closed == nil || closed.Closed.Reason == "" {
		t.Fatalf("closed=%+v", closed)
	}
	if _, ok := <-controller.Events(); ok {
		t.Fatal("terminal events stayed open")
	}
	if err := controller.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestCoreOpenTerminalValidation(t *testing.T) {
	fake := newFakeCoreTransport()
	core := newTestCore(t, fake)
	for _, open := range []TerminalOpen{
		{PaneID: "", Cols: 80, Rows: 24},
		{PaneID: "bad/id", Cols: 80, Rows: 24},
		{PaneID: "t3", Cols: 0, Rows: 24},
		{PaneID: "t3", Cols: 80, Rows: 4},
		{PaneID: "t3", Cols: 400, Rows: 24},
	} {
		if _, err := core.OpenTerminal(context.Background(), open); err == nil {
			t.Fatalf("invalid open accepted: %+v", open)
		} else if fault, ok := AsFault(err); !ok || fault.Code != CodeInvalid {
			t.Fatalf("open %+v fault=%+v err=%v", open, fault, err)
		}
	}
	if attaches := fake.attachLog(); len(attaches) != 0 {
		t.Fatalf("invalid opens reached the core: %+v", attaches)
	}
	if _, err := core.OpenTerminal(context.Background(), TerminalOpen{PaneID: "t3", Cols: 80, Rows: 24, Session: NamedSession("work")}); err == nil {
		t.Fatal("named session was accepted")
	}
}

func TestCoreOpenTerminalCommandsAfterClose(t *testing.T) {
	fake := newFakeCoreTransport()
	core := newTestCore(t, fake)
	controller, _, _ := openCoreTerminal(t, core, fake, TerminalOpen{PaneID: "t3", Cols: 80, Rows: 24})
	if err := controller.Scroll(TerminalScroll{Direction: "up", Lines: 1}); err == nil {
		t.Fatal("scroll was accepted")
	} else if fault, ok := AsFault(err); !ok || fault.Code != CodeUnsupported {
		t.Fatalf("scroll fault=%+v err=%v", fault, err)
	}
	if err := controller.Close(); err != nil {
		t.Fatal(err)
	}
	for _, err := range []error{controller.Input([]byte("x")), controller.Resize(TerminalResize{Cols: 90, Rows: 30})} {
		fault, ok := AsFault(err)
		if !ok || fault.Code != CodeOffline || fault.Outcome != OutcomeNotApplied {
			t.Fatalf("fault=%+v err=%v", fault, err)
		}
	}
	if len(fake.typedLog()) != 0 || len(fake.resizeLog()) != 0 {
		t.Fatal("a closed controller wrote to the core")
	}
}

func TestCoreOpenTerminalMissingAttach(t *testing.T) {
	fake := newFakeCoreTransport()
	delete(fake.hello.Methods, "terminal.attach")
	_, err := newTestCore(t, fake).OpenTerminal(context.Background(), TerminalOpen{PaneID: "t3", Cols: 80, Rows: 24})
	if fault, ok := AsFault(err); !ok || fault.Code != CodeUnsupported {
		t.Fatalf("fault=%+v err=%v", fault, err)
	}
}
