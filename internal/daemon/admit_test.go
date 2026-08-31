package daemon

import (
	"testing"
	"time"

	"pairfob/internal/envelope"
	"pairfob/internal/mux"
	"pairfob/internal/phone"
	"pairfob/internal/runtime"
)

// The race detector substantially amplifies the Argon2 work performed by the
// phone handshake. This bounds the test without constraining production code.
const pairingTestTimeout = 30 * time.Second

func TestPairingApprovalBeforeOrAfterSPAKEPersistsDevice(t *testing.T) {
	for _, approveBefore := range []bool{false, true} {
		name := "after_phone_handshake"
		if approveBefore {
			name = "before_phone_handshake"
		}
		t.Run(name, func(t *testing.T) { testPairingApprovalOrder(t, approveBefore) })
	}
}

func testPairingApprovalOrder(t *testing.T, approveBefore bool) {
	hub := mux.NewHub("pf_test")
	engA, hubD := mux.NewPipePair(32)
	eng := NewEngine(hub, engA, runtime.NewFake())
	daemonHandled := make(chan byte, 4)
	stopD := pump(t, hubD, func(f envelope.Frame) {
		hub.HandleDaemon(hubD, f)
		daemonHandled <- f.Typ
	})
	defer close(stopD)
	if err := eng.Register("pf_test"); err != nil {
		t.Fatal(err)
	}
	stopE := make(chan struct{})
	go eng.RecvLoop(stopE)
	defer close(stopE)

	code := "7K3M9H2P"
	offer, err := eng.OpenPairing(code)
	if err != nil {
		t.Fatal(err)
	}
	waitForHandledFrame(t, daemonHandled, envelope.TypPAIR_OPEN)
	if err := eng.Admit("wrong-ref"); err == nil {
		t.Fatal("admit with mismatched pair_ref succeeded")
	}
	if approveBefore {
		if err := eng.Admit(offer.Ref); err != nil {
			t.Fatal(err)
		}
		st := eng.PairingStatus()
		if st.Ready || !st.Admitted || st.Code != code {
			t.Fatalf("status before phone ready=%t admitted=%t code=%q", st.Ready, st.Admitted, st.Code)
		}
	}

	phA, hubC := mux.NewPipePair(32)
	stopC := pump(t, hubC, func(f envelope.Frame) { hub.HandleClient(hubC, f) })
	defer close(stopC)
	ph := &phone.Client{Conn: phA, Label: "iPhone"}
	done := make(chan error, 1)
	go func() { done <- ph.Pair(offer.Ref, code, eng.DaemonID) }()
	if !approveBefore {
		ready := make(chan PairingStatus, 1)
		waitErr := make(chan error, 1)
		go func() {
			st, err := eng.WaitPairingReady(offer.Ref)
			ready <- st
			waitErr <- err
		}()
		var st PairingStatus
		select {
		case st = <-ready:
			if err := <-waitErr; err != nil {
				t.Fatal(err)
			}
		case <-time.After(pairingTestTimeout):
			t.Fatal("WaitPairingReady did not observe the phone proof")
		}
		if !st.Ready || st.Admitted {
			t.Fatalf("status awaiting computer approval ready=%t admitted=%t", st.Ready, st.Admitted)
		}
		if err := eng.Admit(offer.Ref); err != nil {
			t.Fatal(err)
		}
	}

	select {
	case err := <-done:
		if err != nil {
			t.Fatal("pair", err)
		}
	case <-time.After(pairingTestTimeout):
		t.Fatal("Pair did not finish after computer approval")
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if ph.DeviceID != "" && eng.HasDevice(ph.DeviceID) {
			eng.mu.Lock()
			label := eng.Devices[ph.DeviceID].Label
			eng.mu.Unlock()
			if label != "iPhone" {
				t.Fatalf("pairing ack label was not persisted: %q", label)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("ConfirmPairing did not persist device id=%q", ph.DeviceID)
}

func waitForHandledFrame(t *testing.T, handled <-chan byte, want byte) {
	t.Helper()
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	for {
		select {
		case typ := <-handled:
			if typ == want {
				return
			}
		case <-timer.C:
			t.Fatalf("relay did not handle frame type %#x", want)
		}
	}
}

func TestWaitPairingReadyWakesWhenSlotIsDenied(t *testing.T) {
	a, _ := mux.NewPipePair(8)
	eng := NewEngine(nil, a, runtime.NewFake())
	eng.DaemonID = "d_test"
	offer, err := eng.OpenPairing("7K3M9H2P")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, waitErr := eng.WaitPairingReady(offer.Ref)
		done <- waitErr
	}()
	if err := eng.Deny(offer.Ref); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatalf("got %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("waiter remained blocked after deny")
	}
}
