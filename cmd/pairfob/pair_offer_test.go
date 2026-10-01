package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"reflect"
	"strings"
	"testing"
	"time"

	"pairfob/internal/admin"
)

func offerEvents(t *testing.T, out string) []pairOfferEvent {
	t.Helper()
	var events []pairOfferEvent
	scanner := bufio.NewScanner(strings.NewReader(out))
	for scanner.Scan() {
		var event pairOfferEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			t.Fatalf("line %q: %v", scanner.Text(), err)
		}
		events = append(events, event)
	}
	return events
}

func TestPairOfferAcceptsOnceTheCodeIsProven(t *testing.T) {
	svc := &interactiveAdmin{}
	sock := startAdminService(t, svc)
	stdin, hold := io.Pipe()
	defer hold.Close()
	var out bytes.Buffer
	if err := runPairOffer(context.Background(), sock, stdin, &out); err != nil {
		t.Fatal(err)
	}
	events := offerEvents(t, out.String())
	if len(events) != 3 || events[0].Event != "offer" || events[1].Event != "ready" || events[2].Event != "paired" {
		t.Fatalf("events = %+v", events)
	}
	offer := events[0]
	if offer.Ref != "4f7a2c9e1b0d88aa55cc3311abde7001" || offer.Code != "7K3M9H2P" || !strings.Contains(offer.URL, "/pair#") || offer.ExpiresAt == nil {
		t.Fatalf("offer = %+v", offer)
	}
	want := []string{"new", "wait:" + offer.Ref, "accept:" + offer.Ref}
	if steps := svc.Steps(); !reflect.DeepEqual(steps, want) {
		t.Fatalf("steps = %q, want %q", steps, want)
	}
}

// waitingAdmin never sees the phone prove the code.
type waitingAdmin struct {
	*interactiveAdmin
	release chan struct{}
}

func (a waitingAdmin) WaitPairingReady(string) (admin.Pairing, error) {
	<-a.release
	return admin.Pairing{}, context.Canceled
}

func TestPairOfferDeniesTheSlotWhenTheOperatorLeaves(t *testing.T) {
	cases := map[string]func(cancel context.CancelFunc, stdin io.Closer){
		"stdin closes":   func(_ context.CancelFunc, stdin io.Closer) { _ = stdin.Close() },
		"signal arrives": func(cancel context.CancelFunc, _ io.Closer) { cancel() },
	}
	for name, leave := range cases {
		t.Run(name, func(t *testing.T) {
			svc := waitingAdmin{interactiveAdmin: &interactiveAdmin{}, release: make(chan struct{})}
			defer close(svc.release)
			sock := startAdminService(t, svc)
			stdin, hold := io.Pipe()
			defer hold.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var out bytes.Buffer
			done := make(chan error, 1)
			go func() { done <- runPairOffer(ctx, sock, stdin, &out) }()
			time.Sleep(50 * time.Millisecond)
			leave(cancel, hold)
			select {
			case err := <-done:
				if err == nil || err.Error() != "pairing cancelled" {
					t.Fatalf("err = %v", err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("offer kept waiting")
			}
			events := offerEvents(t, out.String())
			if len(events) != 2 || events[0].Event != "offer" || events[1].Event != "error" {
				t.Fatalf("events = %+v", events)
			}
			steps := svc.Steps()
			if last := steps[len(steps)-1]; last != "deny:"+events[0].Ref {
				t.Fatalf("steps = %q", steps)
			}
		})
	}
}

type brokenPipe struct{}

func (brokenPipe) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }

func TestPairOfferDeniesTheSlotWhenNobodyReadsTheOffer(t *testing.T) {
	svc := &interactiveAdmin{}
	sock := startAdminService(t, svc)
	if err := runPairOffer(context.Background(), sock, strings.NewReader(""), brokenPipe{}); err == nil {
		t.Fatal("offered a pairing to a closed pipe")
	}
	want := []string{"new", "deny:4f7a2c9e1b0d88aa55cc3311abde7001"}
	if steps := svc.Steps(); !reflect.DeepEqual(steps, want) {
		t.Fatalf("steps = %q, want %q", steps, want)
	}
}

func TestPairOfferCheckHasNoSideEffects(t *testing.T) {
	if err := pairOfferCommand([]string{"--check"}, "/nonexistent/pairfob.sock"); err != nil {
		t.Fatal(err)
	}
	if err := pairOfferCommand([]string{"--json"}, "/nonexistent/pairfob.sock"); err == nil || err.Error() != pairOfferUsage {
		t.Fatalf("err = %v", err)
	}
}
