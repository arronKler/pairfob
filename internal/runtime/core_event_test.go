package runtime

import (
	"context"
	"fmt"
	"testing"
	"time"
)

func readCoreEvents(t *testing.T, stream EventStream, want int) []Event {
	t.Helper()
	out := make([]Event, 0, want)
	timeout := time.After(3 * time.Second)
	for len(out) < want {
		select {
		case event, ok := <-stream.Events():
			if !ok {
				t.Fatalf("events closed after %d of %d: err=%v", len(out), want, stream.Err())
			}
			out = append(out, event)
		case <-timeout:
			t.Fatalf("timed out after %d of %d events", len(out), want)
		}
	}
	return out
}

func TestCoreSubscribeEventsMapsEvents(t *testing.T) {
	fake := newFakeCoreTransport()
	core := newTestCore(t, fake)
	stream, err := core.SubscribeEvents(context.Background(), DefaultSession(), EventSubscription{PaneIDs: []string{"t1", "devbox:t7"}})
	if err != nil {
		t.Fatal(err)
	}
	if fake.eventCallCount() != 1 {
		t.Fatalf("event calls=%d", fake.eventCallCount())
	}
	for _, line := range []string{
		`{"jsonrpc":"2.0","method":"event","params":{"data":{"records":{},"reported":true,"status":{"app":"claude","state":"working"}},"seq":1,"terminal":"t1","type":"status"}}`,
		`{"jsonrpc":"2.0","method":"event","params":{"data":{"records":{},"reported":true,"status":{"app":"codex","state":"error"}},"seq":2,"terminal":"devbox/t7","type":"status"}}`,
		`{"jsonrpc":"2.0","method":"event","params":{"data":{"records":{},"reported":true,"status":{"app":"codex","state":"clear"}},"seq":3,"terminal":"devbox/t7","type":"status"}}`,
		`{"jsonrpc":"2.0","method":"event","params":{"data":{"records":{},"reported":false,"status":null},"seq":4,"terminal":"t1","type":"status"}}`,
		`{"jsonrpc":"2.0","method":"event","params":{"data":{"records":{},"reported":true,"status":{"app":"pi","state":"blocked"}},"seq":5,"terminal":"t9","type":"status"}}`,
		`{"jsonrpc":"2.0","method":"event","params":{"data":{},"seq":6,"terminal":"t2","type":"created"}}`,
		`{"jsonrpc":"2.0","method":"event","params":{"data":{},"seq":7,"terminal":"t2","type":"finished"}}`,
		`{"jsonrpc":"2.0","method":"event","params":{"data":{},"seq":8,"terminal":"t2","type":"missed"}}`,
		`{"jsonrpc":"2.0","method":"event","params":{"data":{},"seq":9,"terminal":"t2","type":"lost"}}`,
		`{"jsonrpc":"2.0","method":"event","params":{"data":{},"seq":10,"terminal":"t2","type":"restarted"}}`,
		`{"jsonrpc":"2.0","method":"event","params":{"data":{},"seq":11,"terminal":"t2","type":"removed"}}`,
		`{"jsonrpc":"2.0","method":"event","params":{"data":{},"seq":12,"terminal":"t2","type":"title"}}`,
		`{"jsonrpc":"2.0","method":"event","params":{"data":{},"seq":13,"terminal":"t1","type":"heartbeat"}}`,
		`{"jsonrpc":"2.0","method":"event","params":{"data":{},"seq":14,"terminal":"t1","type":"foreground"}}`,
		`{"jsonrpc":"2.0","method":"event","params":{"data":{},"seq":15,"terminal":"t1","type":"turn"}}`,
	} {
		fake.pushEvent(line)
	}
	events := readCoreEvents(t, stream, 11)
	want := []Event{
		{Kind: EventAgentStatus, PaneID: "t1", AgentStatus: "working"},
		{Kind: EventAgentStatus, PaneID: "devbox:t7", AgentStatus: "blocked"},
		{Kind: EventAgentStatus, PaneID: "devbox:t7", AgentStatus: ""},
		{Kind: EventAgentStatus, PaneID: "t1", AgentStatus: ""},
		{Kind: EventStructure, PaneID: "t2"},
		{Kind: EventStructure, PaneID: "t2"},
		{Kind: EventStructure, PaneID: "t2"},
		{Kind: EventStructure, PaneID: "t2"},
		{Kind: EventStructure, PaneID: "t2"},
		{Kind: EventStructure, PaneID: "t2"},
		{Kind: EventStructure, PaneID: "t2"},
	}
	for index := range want {
		if events[index] != want[index] {
			t.Fatalf("event[%d]=%+v want %+v (all: %+v)", index, events[index], want[index], events)
		}
	}
	select {
	case extra, ok := <-stream.Events():
		if ok {
			t.Fatalf("unexpected event %+v", extra)
		}
	default:
	}
	if err := stream.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestCoreSubscribeEventsSplitsMultipleLines(t *testing.T) {
	fake := newFakeCoreTransport()
	core := newTestCore(t, fake)
	stream, err := core.SubscribeEvents(context.Background(), DefaultSession(), EventSubscription{})
	if err != nil {
		t.Fatal(err)
	}
	fake.pushEvent(`{"jsonrpc":"2.0","method":"event","params":{"data":{"status":{"state":"idle"}},"seq":1,"terminal":"t1","type":"status"}}` + "\n" +
		`{"jsonrpc":"2.0","method":"event","params":{"data":{},"seq":2,"terminal":"t3","type":"created"}}` + "\n")
	events := readCoreEvents(t, stream, 2)
	if events[0].AgentStatus != "idle" || events[1].Kind != EventStructure || events[1].PaneID != "t3" {
		t.Fatalf("events=%+v", events)
	}
	_ = stream.Close()
}

func TestCoreSubscribeEventsNonMembershipTypeIsIgnored(t *testing.T) {
	fake := newFakeCoreTransport()
	core := newTestCore(t, fake)
	stream, err := core.SubscribeEvents(context.Background(), DefaultSession(), EventSubscription{})
	if err != nil {
		t.Fatal(err)
	}
	fake.pushEvent(`{"jsonrpc":"2.0","method":"event","params":{"data":{},"seq":1,"terminal":"t1","type":"turn"}}`)
	fake.pushEvent(`{"jsonrpc":"2.0","method":"event","params":{"data":{},"seq":2,"terminal":"t1","type":"created"}}`)
	events := readCoreEvents(t, stream, 1)
	if events[0].Kind != EventStructure || events[0].PaneID != "t1" {
		t.Fatalf("events=%+v", events)
	}
	_ = stream.Close()
}

func TestCoreSubscribeEventsSlowReaderDropsOldest(t *testing.T) {
	fake := newFakeCoreTransport()
	core := newTestCore(t, fake)
	stream, err := core.SubscribeEvents(context.Background(), DefaultSession(), EventSubscription{})
	if err != nil {
		t.Fatal(err)
	}
	// Fill the stream's buffer plus eight. A slow caller must not end the
	// stream; the newest invalidations are the ones kept.
	for index := 1; index <= coreEventBuffer+8; index++ {
		fake.pushEvent(fmt.Sprintf(`{"jsonrpc":"2.0","method":"event","params":{"data":{},"seq":%d,"terminal":"t%d","type":"created"}}`, index, index))
	}
	time.Sleep(100 * time.Millisecond)
	events := readCoreEvents(t, stream, coreEventBuffer)
	if events[0].PaneID != "t9" || events[len(events)-1].PaneID != fmt.Sprintf("t%d", coreEventBuffer+8) {
		t.Fatalf("first=%q last=%q", events[0].PaneID, events[len(events)-1].PaneID)
	}
	if err := stream.Err(); err != nil {
		t.Fatalf("slow reader ended the stream: %v", err)
	}
	_ = stream.Close()
}

func TestCoreSubscribeEventsMalformedEndsStream(t *testing.T) {
	fake := newFakeCoreTransport()
	core := newTestCore(t, fake)
	stream, err := core.SubscribeEvents(context.Background(), DefaultSession(), EventSubscription{})
	if err != nil {
		t.Fatal(err)
	}
	fake.pushEvent("{\n")
	<-stream.Done()
	if stream.Err() == nil {
		t.Fatal("malformed event left a clean stream")
	}
	select {
	case _, ok := <-stream.Events():
		if ok {
			t.Fatal("events stayed open after a malformed line")
		}
	default:
		t.Fatal("Done closed before Events")
	}
	if fake.closeCount() == 0 {
		t.Fatal("malformed event kept the dedicated connection")
	}
}

func TestCoreSubscribeEventsChannelCloseIsNotFatal(t *testing.T) {
	fake := newFakeCoreTransport()
	core := newTestCore(t, fake)
	stream, err := core.SubscribeEvents(context.Background(), DefaultSession(), EventSubscription{})
	if err != nil {
		t.Fatal(err)
	}
	fake.closeEventStream()
	<-stream.Done()
	if stream.Err() == nil {
		t.Fatal("an unexpected event channel close reported no error")
	}
	if fault, ok := AsFault(stream.Err()); !ok || fault.Code != CodeOffline {
		t.Fatalf("err=%v", stream.Err())
	}
}

func TestCoreSubscribeEventsCloseIsIdempotent(t *testing.T) {
	fake := newFakeCoreTransport()
	core := newTestCore(t, fake)
	stream, err := core.SubscribeEvents(context.Background(), DefaultSession(), EventSubscription{})
	if err != nil {
		t.Fatal(err)
	}
	if err := stream.Close(); err != nil {
		t.Fatal(err)
	}
	if err := stream.Close(); err != nil {
		t.Fatal(err)
	}
	<-stream.Done()
	for range stream.Events() {
	}
	if stream.Err() != nil {
		t.Fatalf("a requested close reported an error: %v", stream.Err())
	}
	if fake.closeCount() != 1 {
		t.Fatalf("dedicated connection closed %d times", fake.closeCount())
	}
}

func TestCoreSubscribeEventsUnsupported(t *testing.T) {
	fake := newFakeCoreTransport()
	delete(fake.hello.Methods, "events.subscribe")
	_, err := newTestCore(t, fake).SubscribeEvents(context.Background(), DefaultSession(), EventSubscription{})
	fault, ok := AsFault(err)
	if !ok || fault.Code != CodeUnsupported {
		t.Fatalf("fault=%+v err=%v", fault, err)
	}
	if fake.closeCount() != 1 {
		t.Fatalf("unsupported subscribe kept its connection: %d", fake.closeCount())
	}
}

func TestCoreSubscribeEventsRejectsInvalidInput(t *testing.T) {
	fake := newFakeCoreTransport()
	core := newTestCore(t, fake)
	if _, err := core.SubscribeEvents(context.Background(), NamedSession("work"), EventSubscription{}); err == nil {
		t.Fatal("named session was accepted")
	}
	if _, err := core.SubscribeEvents(context.Background(), DefaultSession(), EventSubscription{PaneIDs: []string{"bad/id"}}); err == nil {
		t.Fatal("invalid pane id was accepted")
	}
	if fake.eventCallCount() != 0 {
		t.Fatalf("invalid subscription reached the core: %d", fake.eventCallCount())
	}
}

func TestCoreCloseClosesEventStreams(t *testing.T) {
	fake := newFakeCoreTransport()
	core := newTestCore(t, fake)
	stream, err := core.SubscribeEvents(context.Background(), DefaultSession(), EventSubscription{})
	if err != nil {
		t.Fatal(err)
	}
	if err := core.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-stream.Done():
	case <-time.After(3 * time.Second):
		t.Fatal("event stream outlived Core.Close")
	}
	if _, err := core.SubscribeEvents(context.Background(), DefaultSession(), EventSubscription{}); err == nil {
		t.Fatal("closed core accepted a subscription")
	}
}
